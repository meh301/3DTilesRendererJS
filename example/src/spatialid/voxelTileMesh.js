/**
 * Creates Three.js meshes from greedy-meshed spatial ID voxel data.
 * Uses a custom voxel wireframe shader that renders grid lines at voxel boundaries.
 * Supports configurable zoom levels — lower zoom = larger voxels.
 */

import {
	BufferGeometry,
	Float32BufferAttribute,
	Uint32BufferAttribute,
	Mesh,
} from "three";
import { gridToLocalEcef, computeTileCenterEcef, downsampleZFXY } from "./zfxyMath.js";
import { createVoxelMaterial } from "./voxelMaterial.js";
import { isWebGPUAvailable, gpuGreedyMesh } from "./gpuMesher.js";

// Shared material instance
let _material = null;
function getSharedMaterial() {
	if (!_material) {
		_material = createVoxelMaterial();
	}
	return _material;
}

// Worker pool
let _worker = null;
let _jobId = 0;
const _pending = new Map();

function getWorker() {
	if (!_worker) {
		_worker = new Worker(
			new URL("./mesherWorker.js", import.meta.url),
			{ type: "module" }
		);
		_worker.onmessage = (e) => {
			const { id, success, result, error, timeMs } = e.data;
			const job = _pending.get(id);
			if (!job) return;
			_pending.delete(id);
			if (success) {
				console.log(`[MesherWorker] Job ${id}: ${result.triangleCount} tris in ${timeMs?.toFixed(0)}ms`);
				job.resolve(result);
			} else {
				job.reject(new Error(error));
			}
		};
	}
	return _worker;
}

function meshInWorker(tileData) {
	return new Promise((resolve, reject) => {
		const id = ++_jobId;
		_pending.set(id, { resolve, reject });

		const worker = getWorker();
		const msg = {
			id,
			data: {
				x: tileData.x, y: tileData.y, f: tileData.f,
				buildingIdx: tileData.buildingIdx, count: tileData.count,
			},
			zoom: tileData.zoom,
		};

		worker.postMessage(msg, [
			tileData.x.buffer, tileData.y.buffer,
			tileData.f.buffer, tileData.buildingIdx.buffer,
		]);
	});
}

/**
 * Build a Three.js Mesh from mesher output.
 * The mesher outputs positions in integer grid coordinates.
 * We convert them to ECEF-relative for rendering, but also pass
 * the original grid coords as a vertex attribute for the wireframe shader.
 */
function buildMeshFromResult(meshResult, zoom, centerEcef, altitudeOffset, material) {
	// Convert grid positions to CENTER-RELATIVE ECEF (small values for float32 precision)
	const relativePositions = gridToLocalEcef(meshResult.positions, zoom, centerEcef, altitudeOffset);

	const geo = new BufferGeometry();
	geo.setAttribute("position", new Float32BufferAttribute(relativePositions, 3));
	geo.setAttribute("normal", new Float32BufferAttribute(meshResult.normals, 3));
	geo.setIndex(new Uint32BufferAttribute(meshResult.indices, 1));
	geo.setAttribute("buildingId", new Uint32BufferAttribute(meshResult.buildingIds, 1));
	geo.setAttribute("gridPosition", new Float32BufferAttribute(
		meshResult.localPositions || meshResult.positions, 3
	));
	geo.computeBoundingSphere();

	// mesh.position holds the tile center (ECEF).
	// Three.js composes this into the modelMatrix.
	// The vertex positions are small offsets from this center (~0-1000m).
	const mesh = new Mesh(geo, material);
	mesh.position.set(centerEcef[0], centerEcef[1], centerEcef[2]);
	mesh.frustumCulled = false;

	// Update resolution/pixelRatio uniforms each frame (like TopoLinesPlugin)
	mesh.onBeforeRender = (renderer) => {
		if (material.uniforms?.resolution) {
			renderer.getDrawingBufferSize(material.uniforms.resolution.value);
		}
		if (material.uniforms?.pixelRatio) {
			material.uniforms.pixelRatio.value = renderer.getPixelRatio();
		}
	};

	return { mesh, triangleCount: meshResult.triangleCount };
}

/**
 * Create voxel tile meshes at a specific zoom level.
 *
 * @param {object} tileData - Full-resolution parsed CSV data (ZL25)
 * @param {object} options
 * @param {number} [options.altitudeOffset=0]
 * @param {number} [options.displayZoom=25] - Zoom level to display (25=1m, 24=2m, 23=4m, etc.)
 * @param {boolean} [options.useGPU=false] - Use WebGPU compute for face culling
 * @returns {Promise<{mesh: Mesh, centerEcef: number[], totalTriangles: number, meshResult: object}>}
 */
export async function createVoxelTileMesh(tileData, options = {}) {
	const {
		altitudeOffset = 0,
		displayZoom = 25,
		useGPU = false,
	} = options;

	const { x, y, f, buildingIdx, count, zoom } = tileData;
	const centerEcef = computeTileCenterEcef(x, y, f, count, zoom);
	const material = getSharedMaterial();

	// Downsample if displaying at a coarser zoom level
	let meshData;
	let meshZoom;
	if (displayZoom < zoom) {
		const levels = zoom - displayZoom;
		const coarse = downsampleZFXY(x, y, f, buildingIdx, levels);
		meshData = {
			x: coarse.x, y: coarse.y, f: coarse.f,
			buildingIdx: coarse.buildingIdx, count: coarse.count,
		};
		meshZoom = displayZoom;
	} else {
		// Clone for transfer to worker
		meshData = {
			x: new Int32Array(x), y: new Int32Array(y), f: new Int32Array(f),
			buildingIdx: new Uint32Array(buildingIdx), count,
		};
		meshZoom = zoom;
	}

	console.log(`[VoxelTile] Meshing ZL${meshZoom} (${meshData.count} voxels) [${useGPU && isWebGPUAvailable() ? 'GPU' : 'CPU'}]...`);

	let meshResult;
	if (useGPU && isWebGPUAvailable()) {
		try {
			meshResult = await gpuGreedyMesh(meshData);
			// Fallback to CPU if GPU produced no output (shader issue)
			if (meshResult.triangleCount === 0 && meshData.count > 0) {
				console.warn("[VoxelTile] GPU produced 0 tris, falling back to CPU");
				const cpuData = displayZoom < zoom
					? downsampleZFXY(x, y, f, buildingIdx, zoom - displayZoom)
					: { x: new Int32Array(x), y: new Int32Array(y), f: new Int32Array(f), buildingIdx: new Uint32Array(buildingIdx), count };
				meshResult = await meshInWorker({ ...cpuData, zoom: meshZoom });
			}
		} catch (e) {
			console.warn("[VoxelTile] GPU mesher failed, falling back to CPU:", e.message);
			meshResult = await meshInWorker({ ...meshData, zoom: meshZoom });
		}
	} else {
		meshResult = await meshInWorker({ ...meshData, zoom: meshZoom });
	}
	const { mesh, triangleCount } = buildMeshFromResult(meshResult, meshZoom, centerEcef, altitudeOffset, material);
	mesh.userData.displayZoom = meshZoom;

	console.log(`[VoxelTile] Done: ZL${meshZoom} = ${triangleCount} tris from ${meshData.count} voxels`);

	return { mesh, centerEcef, totalTriangles: triangleCount, meshResult };
}

/**
 * Create a mesh directly from a cached mesh result (skips meshing entirely).
 * @param {object} cachedMesh - {positions, normals, indices, buildingIds, vertexCount, triangleCount}
 * @param {number[]} centerEcef
 * @param {number} zoom
 * @param {number} altitudeOffset
 * @returns {{mesh: Mesh, totalTriangles: number}}
 */
export function createVoxelTileMeshFromCache(cachedMesh, centerEcef, zoom, altitudeOffset) {
	const material = getSharedMaterial();
	// The cached mesh has grid-space positions in the `positions` field.
	// We need to convert them to absolute ECEF, same as buildMeshFromResult does.
	const { mesh, triangleCount } = buildMeshFromResult(cachedMesh, zoom, centerEcef, altitudeOffset, material);
	mesh.userData.displayZoom = zoom;
	return { mesh, totalTriangles: triangleCount };
}

/**
 * Get the shared voxel material (for uniform updates from GUI).
 */
export function getVoxelMaterial() {
	return getSharedMaterial();
}

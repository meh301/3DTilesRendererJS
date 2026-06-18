/**
 * WebGPU Compute Mesher for Spatial ID voxels.
 *
 * Uses raw WebGPU API (not Three.js compute nodes) for maximum control.
 * Runs a compute shader that:
 *   1. Reads voxel occupancy data from a storage buffer
 *   2. Performs face culling (checks 6 neighbors per voxel)
 *   3. Emits exposed face quads into an output buffer
 *
 * Greedy merging is NOT done on GPU (too complex for a first pass).
 * Instead, the GPU does face culling (the main bottleneck), then the
 * output is optionally greedy-merged on CPU or returned as individual quads.
 *
 * Falls back to CPU mesher if WebGPU is unavailable.
 */

let _device = null;
let _pipeline = null;

/**
 * Check if WebGPU is available.
 */
export function isWebGPUAvailable() {
	return !!navigator.gpu;
}

/**
 * Initialize the WebGPU device (lazy, cached).
 */
async function getDevice() {
	if (_device) return _device;
	if (!navigator.gpu) throw new Error("WebGPU not available");

	const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
	if (!adapter) throw new Error("No WebGPU adapter found");

	_device = await adapter.requestDevice({
		requiredLimits: {
			maxStorageBufferBindingSize: 512 * 1024 * 1024, // 512MB
			maxBufferSize: 512 * 1024 * 1024,
		},
	});

	return _device;
}

// WGSL compute shader for face culling
const FACE_CULL_SHADER = /* wgsl */ `
	struct VoxelData {
		x: array<i32>,
	};

	struct Params {
		count: u32,
		sizeX: u32,
		sizeY: u32,
		sizeF: u32,
		minX: i32,
		minY: i32,
		minF: i32,
		_pad: u32,
	};

	// Output: 6 potential faces per voxel, each face = 1 if exposed, 0 if interior
	// Face order: +X, -X, +Y, -Y, +F, -F
	struct FaceOutput {
		faces: array<u32>,
	};

	@group(0) @binding(0) var<storage, read> xCoords: VoxelData;
	@group(0) @binding(1) var<storage, read> yCoords: VoxelData;
	@group(0) @binding(2) var<storage, read> fCoords: VoxelData;
	@group(0) @binding(3) var<storage, read> buildingIdx: VoxelData;
	@group(0) @binding(4) var<uniform> params: Params;
	@group(0) @binding(5) var<storage, read> occupancy: VoxelData; // flat 3D grid: buildingIdx+1 or 0
	@group(0) @binding(6) var<storage, read_write> faceOutput: FaceOutput;

	fn getOccupant(lx: i32, ly: i32, lf: i32) -> u32 {
		if (lx < 0 || ly < 0 || lf < 0 ||
			u32(lx) >= params.sizeX || u32(ly) >= params.sizeY || u32(lf) >= params.sizeF) {
			return 0u;
		}
		let idx = u32(lx) + u32(ly) * params.sizeX + u32(lf) * params.sizeX * params.sizeY;
		return u32(occupancy.x[idx]);
	}

	@compute @workgroup_size(256)
	fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
		let i = gid.x;
		if (i >= params.count) { return; }

		let lx = xCoords.x[i] - params.minX;
		let ly = yCoords.x[i] - params.minY;
		let lf = fCoords.x[i] - params.minF;
		let self_bldg = u32(buildingIdx.x[i]) + 1u;

		// Check 6 neighbors
		let neighbors = array<vec3<i32>, 6>(
			vec3<i32>(lx + 1, ly, lf), // +X
			vec3<i32>(lx - 1, ly, lf), // -X
			vec3<i32>(lx, ly + 1, lf), // +Y
			vec3<i32>(lx, ly - 1, lf), // -Y
			vec3<i32>(lx, ly, lf + 1), // +F
			vec3<i32>(lx, ly, lf - 1), // -F
		);

		for (var face = 0u; face < 6u; face++) {
			let n = neighbors[face];
			let neighbor_bldg = getOccupant(n.x, n.y, n.z);
			// Face is exposed if neighbor is empty or different building
			if (neighbor_bldg != self_bldg) {
				faceOutput.faces[i * 6u + face] = 1u;
			} else {
				faceOutput.faces[i * 6u + face] = 0u;
			}
		}
	}
`;

/**
 * Run face culling on the GPU.
 * Returns which faces of each voxel are exposed.
 *
 * @param {{x: Int32Array, y: Int32Array, f: Int32Array, buildingIdx: Uint32Array, count: number}} data
 * @returns {Promise<Uint32Array>} Face flags: count*6 entries, 1=exposed, 0=interior
 */
export async function gpuFaceCull(data) {
	const device = await getDevice();
	const { x, y, f, buildingIdx, count } = data;

	// Compute bounds
	let minX = Infinity, minY = Infinity, minF = Infinity;
	let maxX = -Infinity, maxY = -Infinity, maxF = -Infinity;
	for (let i = 0; i < count; i++) {
		if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
		if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
		if (f[i] < minF) minF = f[i]; if (f[i] > maxF) maxF = f[i];
	}

	const sizeX = maxX - minX + 1;
	const sizeY = maxY - minY + 1;
	const sizeF = maxF - minF + 1;
	const gridSize = sizeX * sizeY * sizeF;

	// Build occupancy grid on CPU (could also be a GPU pass, but this is fast)
	const occupancy = new Int32Array(gridSize);
	for (let i = 0; i < count; i++) {
		const idx = (x[i] - minX) + (y[i] - minY) * sizeX + (f[i] - minF) * sizeX * sizeY;
		occupancy[idx] = buildingIdx[i] + 1;
	}

	// Create GPU buffers
	const xBuf = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
	const yBuf = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
	const fBuf = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
	const bBuf = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
	const occBuf = device.createBuffer({ size: gridSize * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

	const paramData = new ArrayBuffer(32);
	const paramView = new DataView(paramData);
	paramView.setUint32(0, count, true);
	paramView.setUint32(4, sizeX, true);
	paramView.setUint32(8, sizeY, true);
	paramView.setUint32(12, sizeF, true);
	paramView.setInt32(16, minX, true);
	paramView.setInt32(20, minY, true);
	paramView.setInt32(24, minF, true);
	const paramBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

	const outputSize = count * 6 * 4;
	const outBuf = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
	const readBuf = device.createBuffer({ size: outputSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

	// Upload data
	device.queue.writeBuffer(xBuf, 0, new Int32Array(x));
	device.queue.writeBuffer(yBuf, 0, new Int32Array(y));
	device.queue.writeBuffer(fBuf, 0, new Int32Array(f));
	device.queue.writeBuffer(bBuf, 0, new Uint32Array(buildingIdx));
	device.queue.writeBuffer(occBuf, 0, occupancy);
	device.queue.writeBuffer(paramBuf, 0, new Uint32Array(paramData));

	// Create pipeline (cached)
	if (!_pipeline) {
		const shaderModule = device.createShaderModule({ code: FACE_CULL_SHADER });
		_pipeline = device.createComputePipeline({
			layout: "auto",
			compute: { module: shaderModule, entryPoint: "main" },
		});
	}

	// Bind group
	const bindGroup = device.createBindGroup({
		layout: _pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: xBuf } },
			{ binding: 1, resource: { buffer: yBuf } },
			{ binding: 2, resource: { buffer: fBuf } },
			{ binding: 3, resource: { buffer: bBuf } },
			{ binding: 4, resource: { buffer: paramBuf } },
			{ binding: 5, resource: { buffer: occBuf } },
			{ binding: 6, resource: { buffer: outBuf } },
		],
	});

	// Dispatch
	const encoder = device.createCommandEncoder();
	const pass = encoder.beginComputePass();
	pass.setPipeline(_pipeline);
	pass.setBindGroup(0, bindGroup);
	pass.dispatchWorkgroups(Math.ceil(count / 256));
	pass.end();

	// Copy output to readable buffer
	encoder.copyBufferToBuffer(outBuf, 0, readBuf, 0, outputSize);
	device.queue.submit([encoder.finish()]);

	// Read back
	await readBuf.mapAsync(GPUMapMode.READ);
	const result = new Uint32Array(readBuf.getMappedRange().slice(0));
	readBuf.unmap();

	// Cleanup
	xBuf.destroy(); yBuf.destroy(); fBuf.destroy(); bBuf.destroy();
	occBuf.destroy(); paramBuf.destroy(); outBuf.destroy(); readBuf.destroy();

	return result;
}

/**
 * GPU-accelerated greedy mesh: face culling on GPU, quad generation on CPU.
 *
 * @param {{x: Int32Array, y: Int32Array, f: Int32Array, buildingIdx: Uint32Array, count: number}} data
 * @returns {Promise<{positions, localPositions, normals, indices, buildingIds, vertexCount, triangleCount}>}
 */
export async function gpuGreedyMesh(data) {
	const { x, y, f, buildingIdx, count } = data;

	console.log(`[GPU Mesher] Face culling ${count} voxels...`);
	const t0 = performance.now();
	const faceFlags = await gpuFaceCull(data);
	const t1 = performance.now();
	console.log(`[GPU Mesher] Face culling done in ${(t1 - t0).toFixed(0)}ms`);

	// Find bounds for local positions
	let minX = Infinity, minY = Infinity, minF = Infinity;
	for (let i = 0; i < count; i++) {
		if (x[i] < minX) minX = x[i];
		if (y[i] < minY) minY = y[i];
		if (f[i] < minF) minF = f[i];
	}

	// Generate quads from face flags (CPU — could also be GPU but complex)
	const FACE_NORMALS = [
		[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
	];
	// Face quad corners relative to voxel, indexed by face direction
	const FACE_VERTS = [
		// +X: x+1 face, sweep Y and F
		[[1,0,0],[1,1,0],[1,1,1],[1,0,1]],
		// -X: x face
		[[0,0,0],[0,0,1],[0,1,1],[0,1,0]],
		// +Y
		[[0,1,0],[1,1,0],[1,1,1],[0,1,1]],
		// -Y
		[[0,0,0],[0,0,1],[1,0,1],[1,0,0]],
		// +F
		[[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
		// -F
		[[0,0,0],[0,1,0],[1,1,0],[1,0,0]],
	];

	const positions = [];
	const localPositions = [];
	const normals = [];
	const indicesArr = [];
	const bldgIdsArr = [];
	let vertIdx = 0;

	for (let i = 0; i < count; i++) {
		const lx = x[i] - minX;
		const ly = y[i] - minY;
		const lf = f[i] - minF;
		const bldg = buildingIdx[i];

		for (let face = 0; face < 6; face++) {
			if (faceFlags[i * 6 + face] === 0) continue;

			const [nx, ny, nz] = FACE_NORMALS[face];
			const verts = FACE_VERTS[face];

			for (const [dx, dy, dz] of verts) {
				localPositions.push(lx + dx, ly + dy, lf + dz);
				positions.push(x[i] + dx, y[i] + dy, f[i] + dz);
				normals.push(nx, ny, nz);
			}
			bldgIdsArr.push(bldg, bldg, bldg, bldg);

			// Two triangles per quad
			if (nx + ny + nz > 0) {
				indicesArr.push(vertIdx, vertIdx+1, vertIdx+2, vertIdx, vertIdx+2, vertIdx+3);
			} else {
				indicesArr.push(vertIdx, vertIdx+2, vertIdx+1, vertIdx, vertIdx+3, vertIdx+2);
			}
			vertIdx += 4;
		}
	}

	const triangleCount = indicesArr.length / 3;
	console.log(`[GPU Mesher] Generated ${triangleCount} triangles (${vertIdx} vertices) in ${(performance.now() - t1).toFixed(0)}ms`);

	return {
		positions: new Float32Array(positions),
		localPositions: new Float32Array(localPositions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indicesArr),
		buildingIds: new Uint32Array(bldgIdsArr),
		vertexCount: vertIdx,
		triangleCount,
	};
}

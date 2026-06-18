/**
 * VoxelTileManager: orchestrates loading, caching, rendering
 * of spatial ID voxel tiles based on camera position.
 */

import { Group } from "three";
import { TileIndex } from "./tileIndex.js";
import { TileCache } from "./tileCache.js";
import { fetchAndParseCSV } from "./csvParser.js";
import { createVoxelTileMesh, getVoxelMaterial } from "./voxelTileMesh.js";
// Note: createVoxelTileMeshFromCache removed — mesh cache is handled inside createVoxelTileMesh

export class VoxelTileManager {

	constructor(parent, options) {
		// Create a dedicated group for voxel meshes — makes cleanup bulletproof
		this.voxelGroup = new Group();
		this.voxelGroup.name = "voxelGroup";
		parent.add(this.voxelGroup);

		this.parent = parent;
		this.maxDistance = options.maxDistance ?? 5000;
		this.altitudeOffset = options.altitudeOffset ?? 0;
		this.displayZoom = options.displayZoom ?? 25;
		this.useGPU = options.useGPU ?? false;
		this.enabled = true;

		this.tileIndex = new TileIndex(options.baseUrl, options.manifest);
		this.cache = new TileCache();

		/** @type {Map<string, {mesh, centerEcef, totalTriangles, code, rawData}>} */
		this._loadedTiles = new Map();
		/** @type {Set<string>} */
		this._loadingTiles = new Set();
		/** @type {Set<string>} */
		this._failedTiles = new Set();

		// Generation counter: incremented on dispose/zoom change to cancel stale async ops
		this._generation = 0;

		this._frameCount = 0;
		this._checkInterval = 60;

		/** @type {function|null} */
		this.onProgress = options.onProgress || null;
	}

	update(camera, tilesGroupMatrixWorldInverse) {
		if (!this.enabled) {
			this.voxelGroup.visible = false;
			return;
		}
		this.voxelGroup.visible = true;

		const camEcef = this._cameraToEcef(camera, tilesGroupMatrixWorldInverse);

		this._frameCount++;
		if (this._frameCount >= this._checkInterval) {
			this._frameCount = 0;
			this._updateTileLoading(camEcef);
		}

		// Update visibility based on distance
		for (const [code, tile] of this._loadedTiles) {
			if (tile.mesh) {
				const dist = this.tileIndex.getDistanceToTile(code, camEcef);
				tile.mesh.visible = dist <= this.maxDistance;
			}
		}
	}

	_cameraToEcef(camera, tilesGroupMatrixWorldInverse) {
		if (tilesGroupMatrixWorldInverse) {
			const vec = camera.position.clone().applyMatrix4(tilesGroupMatrixWorldInverse);
			return [vec.x, vec.y, vec.z];
		}
		return [camera.position.x, camera.position.y, camera.position.z];
	}

	_updateTileLoading(camEcef) {
		const needed = new Set(this.tileIndex.getTilesInRange(camEcef, this.maxDistance));

		// Unload distant tiles
		for (const [code, tile] of this._loadedTiles) {
			if (!needed.has(code)) {
				if (tile.mesh) {
					this.voxelGroup.remove(tile.mesh);
					tile.mesh.geometry.dispose();
				}
				this._loadedTiles.delete(code);
			}
		}

		// Load needed tiles
		for (const code of needed) {
			if (!this._loadedTiles.has(code) && !this._loadingTiles.has(code) && !this._failedTiles.has(code)) {
				this._loadTile(code);
			}
		}
	}

	async _loadTile(code) {
		this._loadingTiles.add(code);
		const gen = this._generation; // capture current generation

		try {
			this.onProgress?.(`Loading ${code}...`, 0.1);

			// 1. Get parsed CSV data (from cache or fetch)
			let data = await this.cache.getTile(code);
			if (gen !== this._generation) return; // stale

			if (!data) {
				const url = this.tileIndex.getUrl(code);
				if (!url) return;

				this.onProgress?.(`Fetching ${code}...`, 0.2);
				data = await fetchAndParseCSV(url);
				if (gen !== this._generation) return; // stale
				await this.cache.putTile(code, data);
			}

			this.tileIndex.computeTileCenter(code, data);

			// 2. Mesh
			this.onProgress?.(`Meshing ${code} (ZL${this.displayZoom})...`, 0.5);
			const t0 = performance.now();
			const { mesh, centerEcef, totalTriangles, meshResult } = await createVoxelTileMesh(data, {
				altitudeOffset: this.altitudeOffset,
				displayZoom: this.displayZoom,
				useGPU: this.useGPU,
			});
			if (gen !== this._generation) {
				mesh.geometry.dispose(); // clean up orphaned mesh
				return;
			}

			const dt = performance.now() - t0;
			console.log(`[VoxelEngine] ${code}: ${totalTriangles} tris in ${dt.toFixed(0)}ms`);

			// 3. Cache mesh result
			if (meshResult) {
				await this.cache.putMesh(code, this.displayZoom, meshResult);
			}

			// 4. Add to scene
			this.voxelGroup.add(mesh);
			this._loadedTiles.set(code, { mesh, centerEcef, totalTriangles, code, rawData: data });
			this.onProgress?.(`${code} ready`, 1.0);
		} catch (err) {
			if (gen === this._generation) {
				console.warn(`[VoxelEngine] Failed ${code}:`, err.message);
				this._failedTiles.add(code);
			}
		} finally {
			this._loadingTiles.delete(code);
		}
	}

	/**
	 * Change the display zoom level. Removes ALL meshes and re-loads.
	 */
	async setDisplayZoom(zoom) {
		if (zoom === this.displayZoom) return;
		this.displayZoom = zoom;
		this._generation++; // cancel all in-flight loads

		console.log(`[VoxelEngine] Zoom → ZL${zoom}, clearing and re-loading...`);

		// Remove ALL voxel meshes from the group
		this._clearMeshes();

		// Re-trigger loading (will happen on next update cycle)
		// The _loadedTiles still have rawData so we can re-mesh without re-fetching
		const tilesToRemesh = new Map(this._loadedTiles);
		this._loadedTiles.clear();
		this._loadingTiles.clear();
		this._failedTiles.clear();

		for (const [code, tile] of tilesToRemesh) {
			if (!tile.rawData) continue;
			this._loadTileFromData(code, tile.rawData);
		}
	}

	/**
	 * Load a tile from already-parsed data (skip fetch, just mesh).
	 */
	async _loadTileFromData(code, data) {
		this._loadingTiles.add(code);
		const gen = this._generation;

		try {
			this.tileIndex.computeTileCenter(code, data);

			this.onProgress?.(`Meshing ${code} (ZL${this.displayZoom})...`, 0.5);
			const { mesh, centerEcef, totalTriangles, meshResult } = await createVoxelTileMesh(data, {
				altitudeOffset: this.altitudeOffset,
				displayZoom: this.displayZoom,
				useGPU: this.useGPU,
			});
			if (gen !== this._generation) {
				mesh.geometry.dispose();
				return;
			}

			if (meshResult) {
				await this.cache.putMesh(code, this.displayZoom, meshResult);
			}

			this.voxelGroup.add(mesh);
			this._loadedTiles.set(code, { mesh, centerEcef, totalTriangles, code, rawData: data });
			this.onProgress?.(`${code} ready`, 1.0);
		} catch (err) {
			if (gen === this._generation) {
				console.warn(`[VoxelEngine] Re-mesh failed ${code}:`, err.message);
			}
		} finally {
			this._loadingTiles.delete(code);
		}
	}

	/**
	 * Remove all voxel meshes from the scene.
	 */
	_clearMeshes() {
		// Remove and dispose all children of the voxel group
		while (this.voxelGroup.children.length > 0) {
			const child = this.voxelGroup.children[0];
			this.voxelGroup.remove(child);
			if (child.geometry) child.geometry.dispose();
		}
	}

	getStats() {
		let totalTriangles = 0;
		let visibleTriangles = 0;
		for (const tile of this._loadedTiles.values()) {
			totalTriangles += tile.totalTriangles || 0;
			if (tile.mesh?.visible) {
				visibleTriangles += tile.mesh.geometry.index ? tile.mesh.geometry.index.count / 3 : 0;
			}
		}
		return {
			loadedTiles: this._loadedTiles.size,
			loadingTiles: this._loadingTiles.size,
			totalTriangles,
			visibleTriangles,
			displayZoom: this.displayZoom,
		};
	}

	getMaterial() { return getVoxelMaterial(); }

	async clearAll() {
		this._generation++;
		this._clearMeshes();
		this._loadedTiles.clear();
		this._loadingTiles.clear();
		this._failedTiles.clear();
		await this.cache.clear();
	}

	dispose() {
		this._generation++;
		this._clearMeshes();
		if (this.voxelGroup.parent) {
			this.voxelGroup.parent.remove(this.voxelGroup);
		}
		this._loadedTiles.clear();
		this._loadingTiles.clear();
	}
}

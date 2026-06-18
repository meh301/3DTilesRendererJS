/**
 * IndexedDB cache for spatial ID tile data.
 * Two stores:
 *   - "tiles": parsed CSV data (so CSVs don't need re-parsing)
 *   - "meshes": meshed geometry (so greedy meshing doesn't re-run)
 * Both persist across page refreshes.
 */

const DB_NAME = "spatialid-cache";
const DB_VERSION = 3;
const TILES_STORE = "tiles";
const MESHES_STORE = "meshes";
const DATA_VERSION = "3";
const MESH_VERSION = "3";

function openDB() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(TILES_STORE)) {
				db.createObjectStore(TILES_STORE);
			}
			if (!db.objectStoreNames.contains(MESHES_STORE)) {
				db.createObjectStore(MESHES_STORE);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export class TileCache {

	constructor() {
		this._dbPromise = openDB();
	}

	async _store(name, mode) {
		const db = await this._dbPromise;
		const tx = db.transaction(name, mode);
		return tx.objectStore(name);
	}

	// --- Parsed CSV data ---

	async getTile(tileCode) {
		const store = await this._store(TILES_STORE, "readonly");
		return new Promise((resolve) => {
			const req = store.get(tileCode);
			req.onsuccess = () => {
				const val = req.result;
				if (!val || val.version !== DATA_VERSION) {
					resolve(null);
				} else {
					resolve({
						x: new Int32Array(val.x),
						y: new Int32Array(val.y),
						f: new Int32Array(val.f),
						buildingIdx: new Uint32Array(val.buildingIdx),
						buildingIds: val.buildingIds,
						count: val.count,
						zoom: val.zoom,
					});
				}
			};
			req.onerror = () => resolve(null);
		});
	}

	async putTile(tileCode, data) {
		const store = await this._store(TILES_STORE, "readwrite");
		return new Promise((resolve, reject) => {
			const req = store.put({
				x: data.x.buffer,
				y: data.y.buffer,
				f: data.f.buffer,
				buildingIdx: data.buildingIdx.buffer,
				buildingIds: data.buildingIds,
				count: data.count,
				zoom: data.zoom,
				version: DATA_VERSION,
			}, tileCode);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	}

	// --- Meshed geometry ---

	/**
	 * Get cached mesh result for a tile at a specific display zoom.
	 * @param {string} tileCode
	 * @param {number} displayZoom
	 * @returns {Promise<{positions, normals, indices, buildingIds, gridPositions, vertexCount, triangleCount}|null>}
	 */
	async getMesh(tileCode, displayZoom) {
		const store = await this._store(MESHES_STORE, "readonly");
		const key = `${tileCode}_z${displayZoom}`;
		return new Promise((resolve) => {
			const req = store.get(key);
			req.onsuccess = () => {
				const val = req.result;
				if (!val || val.version !== MESH_VERSION) {
					resolve(null);
				} else {
					resolve({
						positions: new Float32Array(val.positions),
						localPositions: val.localPositions ? new Float32Array(val.localPositions) : null,
						normals: new Float32Array(val.normals),
						indices: new Uint32Array(val.indices),
						buildingIds: new Uint32Array(val.buildingIds),
						vertexCount: val.vertexCount,
						triangleCount: val.triangleCount,
					});
				}
			};
			req.onerror = () => resolve(null);
		});
	}

	async putMesh(tileCode, displayZoom, meshResult) {
		const store = await this._store(MESHES_STORE, "readwrite");
		const key = `${tileCode}_z${displayZoom}`;
		return new Promise((resolve, reject) => {
			const req = store.put({
				positions: meshResult.positions.buffer,
				localPositions: meshResult.localPositions?.buffer || null,
				normals: meshResult.normals.buffer,
				indices: meshResult.indices.buffer,
				buildingIds: meshResult.buildingIds.buffer,
				vertexCount: meshResult.vertexCount,
				triangleCount: meshResult.triangleCount,
				version: MESH_VERSION,
			}, key);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	}

	// --- Backward compat aliases ---
	get(...args) { return this.getTile(...args); }
	put(...args) { return this.putTile(...args); }

	async clear() {
		const tilesStore = await this._store(TILES_STORE, "readwrite");
		const meshStore = await this._store(MESHES_STORE, "readwrite");
		await new Promise((r, j) => { const req = tilesStore.clear(); req.onsuccess = r; req.onerror = j; });
		await new Promise((r, j) => { const req = meshStore.clear(); req.onsuccess = r; req.onerror = j; });
	}
}

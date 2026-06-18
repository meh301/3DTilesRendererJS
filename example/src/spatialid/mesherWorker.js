/**
 * Web Worker for greedy meshing.
 */

import { greedyMesh } from "./greedyMesher.js";

self.onmessage = (e) => {
	const { id, data, zoom } = e.data;

	try {
		const t0 = performance.now();
		const result = greedyMesh(data);
		const dt = performance.now() - t0;

		self.postMessage({
			id,
			success: true,
			result: {
				positions: result.positions,
				localPositions: result.localPositions,
				normals: result.normals,
				indices: result.indices,
				buildingIds: result.buildingIds,
				vertexCount: result.vertexCount,
				triangleCount: result.triangleCount,
			},
			timeMs: dt,
		}, [
			result.positions.buffer,
			result.localPositions.buffer,
			result.normals.buffer,
			result.indices.buffer,
			result.buildingIds.buffer,
		]);
	} catch (err) {
		self.postMessage({ id, success: false, error: err.message });
	}
};

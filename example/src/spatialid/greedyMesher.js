/**
 * CPU Greedy Mesher for Spatial ID voxels.
 *
 * Optimized approach: iterate only occupied voxels (not the full bounding box).
 * Uses a Map for sparse occupancy. Per-building face culling preserves building boundaries.
 */

// Face directions: axis (0=X,1=Y,2=F), sign, u-axis, v-axis, normal
const FACES = [
	{ axis: 0, sign: +1, u: 1, v: 2, nx: 1, ny: 0, nz: 0 },
	{ axis: 0, sign: -1, u: 1, v: 2, nx: -1, ny: 0, nz: 0 },
	{ axis: 1, sign: +1, u: 0, v: 2, nx: 0, ny: 1, nz: 0 },
	{ axis: 1, sign: -1, u: 0, v: 2, nx: 0, ny: -1, nz: 0 },
	{ axis: 2, sign: +1, u: 0, v: 1, nx: 0, ny: 0, nz: 1 },
	{ axis: 2, sign: -1, u: 0, v: 1, nx: 0, ny: 0, nz: -1 },
];

/**
 * @param {{x: Int32Array, y: Int32Array, f: Int32Array, buildingIdx: Uint32Array, count: number}} data
 */
export function greedyMesh(data) {
	const { x, y, f, buildingIdx, count } = data;

	// Build sparse occupancy map: key → buildingIdx+1
	// Key encoding: pack (x,y,f) relative to min into a single number
	let minX = Infinity, minY = Infinity, minF = Infinity;
	let maxX = -Infinity, maxY = -Infinity, maxF = -Infinity;
	for (let i = 0; i < count; i++) {
		if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
		if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
		if (f[i] < minF) minF = f[i]; if (f[i] > maxF) maxF = f[i];
	}

	const sizeX = maxX - minX + 3; // +3 for 1-cell padding on each side
	const sizeY = maxY - minY + 3;
	const strideY = sizeX;
	const strideF = sizeX * sizeY;

	// Encode a local coord to a flat key (with +1 offset for padding)
	const encode = (lx, ly, lf) => (lx + 1) + (ly + 1) * strideY + (lf + 1) * strideF;

	const occupancy = new Map();
	for (let i = 0; i < count; i++) {
		const key = encode(x[i] - minX, y[i] - minY, f[i] - minF);
		occupancy.set(key, buildingIdx[i] + 1);
	}

	// For each face direction, find exposed faces by iterating occupied voxels only
	// Group exposed faces by (axis, slice, buildingId) for greedy merge
	// Structure: Map<sliceKey, {uMin, uMax, vMin, vMax, faces: Map<"u,v" → buildingId+1>}>

	const positions = [];      // absolute grid coords (for ECEF conversion)
	const localPositions = []; // local grid coords 0..sizeN (for shader fract())
	const normals = [];
	const indicesArr = [];
	const bldgIdsArr = [];
	let vertIdx = 0;

	const offsets = [0, 0, 0]; // neighbor offset for each face direction

	for (const face of FACES) {
		const { axis, sign, u, v, nx, ny, nz } = face;

		// Collect exposed faces grouped by slice (position along axis)
		// slice → Map<"u,v" → buildingId+1>
		const slices = new Map();

		for (let i = 0; i < count; i++) {
			const coords = [x[i] - minX, y[i] - minY, f[i] - minF];
			const d = coords[axis]; // slice position

			// Check neighbor
			const nKey = encode(
				coords[0] + (axis === 0 ? sign : 0),
				coords[1] + (axis === 1 ? sign : 0),
				coords[2] + (axis === 2 ? sign : 0)
			);
			const neighbor = occupancy.get(nKey) || 0;
			const self = buildingIdx[i] + 1;

			if (neighbor === self) continue; // Same building neighbor → interior face

			// Exposed face
			let slice = slices.get(d);
			if (!slice) {
				slice = { faces: new Map(), uCoords: [], vCoords: [] };
				slices.set(d, slice);
			}
			const cu = coords[u];
			const cv = coords[v];
			slice.faces.set(cv * 100000 + cu, self); // pack u,v into single key
			slice.uCoords.push(cu);
			slice.vCoords.push(cv);
		}

		// Greedy merge each slice
		for (const [d, slice] of slices) {
			if (slice.faces.size === 0) continue;

			// Find bounds of this slice's faces
			let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
			for (const cu of slice.uCoords) { if (cu < uMin) uMin = cu; if (cu > uMax) uMax = cu; }
			for (const cv of slice.vCoords) { if (cv < vMin) vMin = cv; if (cv > vMax) vMax = cv; }

			const dU = uMax - uMin + 1;
			const dV = vMax - vMin + 1;

			// Build compact 2D mask for this slice (only the bounds area)
			const mask = new Uint32Array(dU * dV); // buildingId+1 or 0
			for (const [packedKey, bldg] of slice.faces) {
				const cu = packedKey % 100000;
				const cv = (packedKey - cu) / 100000;
				mask[(cv - vMin) * dU + (cu - uMin)] = bldg;
			}

			// Full greedy merge — the voxel line shader handles grid visualization.
			const MAX_MERGE = 9999;
			for (let iv = 0; iv < dV; iv++) {
				for (let iu = 0; iu < dU; iu++) {
					const m = mask[iv * dU + iu];
					if (m === 0) continue;

					let w = 1;
					while (w < MAX_MERGE && iu + w < dU && mask[iv * dU + iu + w] === m) w++;

					let h = 1;
					let done = false;
					while (h < MAX_MERGE && iv + h < dV && !done) {
						for (let k = 0; k < w; k++) {
							if (mask[(iv + h) * dU + iu + k] !== m) { done = true; break; }
						}
						if (!done) h++;
					}

					for (let dv = 0; dv < h; dv++)
						for (let du = 0; du < w; du++)
							mask[(iv + dv) * dU + iu + du] = 0;

					// Emit quad
					const corner = [0, 0, 0];
					corner[axis] = d + (sign > 0 ? 1 : 0);
					corner[u] = uMin + iu;
					corner[v] = vMin + iv;

					const duVec = [0, 0, 0]; duVec[u] = w;
					const dvVec = [0, 0, 0]; dvVec[v] = h;

					// Local coords (small values for shader)
					const lx = corner[0], ly = corner[1], lz = corner[2];
					localPositions.push(
						lx, ly, lz,
						lx + duVec[0], ly + duVec[1], lz + duVec[2],
						lx + duVec[0] + dvVec[0], ly + duVec[1] + dvVec[1], lz + duVec[2] + dvVec[2],
						lx + dvVec[0], ly + dvVec[1], lz + dvVec[2]
					);

					// Absolute coords (for ECEF conversion)
					const ox = minX, oy = minY, oz = minF;
					positions.push(
						lx + ox, ly + oy, lz + oz,
						lx + duVec[0] + ox, ly + duVec[1] + oy, lz + duVec[2] + oz,
						lx + duVec[0] + dvVec[0] + ox, ly + duVec[1] + dvVec[1] + oy, lz + duVec[2] + dvVec[2] + oz,
						lx + dvVec[0] + ox, ly + dvVec[1] + oy, lz + dvVec[2] + oz
					);
					normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);

					const bldg = m - 1;
					bldgIdsArr.push(bldg, bldg, bldg, bldg);

					if (sign > 0) {
						indicesArr.push(vertIdx, vertIdx+1, vertIdx+2, vertIdx, vertIdx+2, vertIdx+3);
					} else {
						indicesArr.push(vertIdx, vertIdx+2, vertIdx+1, vertIdx, vertIdx+3, vertIdx+2);
					}
					vertIdx += 4;
				}
			}
		}
	}

	const triangleCount = indicesArr.length / 3;

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

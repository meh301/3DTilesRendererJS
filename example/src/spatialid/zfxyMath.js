/**
 * ZFXY ↔ Geographic coordinate conversion.
 * Implements the same math as @spatial-id/javascript-sdk but optimized for bulk operations.
 *
 * ZFXY format: Z/F/X/Y
 *   Z = zoom level (typically 25)
 *   F = floor (altitude quantization index)
 *   X = web mercator tile X coordinate
 *   Y = web mercator tile Y coordinate
 */

import projector from "ecef-projector";

const ZFXY_1M_ZOOM_BASE = 25; // 2^25 = 33554432
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Northwest corner of a tile in lng/lat.
 */
export function tileToLngLat(x, y, z) {
	const n = Math.pow(2, z);
	const lng = (x / n) * 360 - 180;
	const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
	return { lng, lat: latRad * RAD2DEG };
}

/**
 * Center of a tile in lng/lat.
 */
export function tileCenterLngLat(x, y, z) {
	return tileToLngLat(2 * x + 1, 2 * y + 1, z + 1);
}

/**
 * Bottom altitude of floor F at zoom Z, in meters.
 */
export function floorToAlt(f, z) {
	return (f * Math.pow(2, ZFXY_1M_ZOOM_BASE)) / Math.pow(2, z);
}

/**
 * Voxel vertical height in meters at zoom Z.
 */
export function voxelHeight(z) {
	return Math.pow(2, ZFXY_1M_ZOOM_BASE) / Math.pow(2, z);
}

/**
 * Center altitude of a voxel (midpoint between floor and ceiling).
 */
export function voxelCenterAlt(f, z) {
	return floorToAlt(f, z) + voxelHeight(z) / 2;
}

/**
 * Convert lng/lat to tile X/Y at zoom Z.
 */
export function lngLatToTile(lng, lat, z) {
	const n = Math.pow(2, z);
	const x = Math.floor(n * (lng / 360 + 0.5));
	const sinLat = Math.sin(lat * DEG2RAD);
	const y = Math.floor(n * (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)));
	return { x, y };
}

/**
 * Convert a single ZFXY voxel to ECEF coordinates (center of voxel).
 * Returns [x, y, z] in ECEF meters.
 */
export function zfxyToEcef(z, f, x, y) {
	const center = tileCenterLngLat(x, y, z);
	const alt = voxelCenterAlt(f, z);
	return projector.project(center.lat, center.lng, alt);
}

/**
 * Batch convert ZFXY arrays to a flat Float32Array of ECEF positions.
 * Much faster than calling zfxyToEcef per-voxel due to reduced function call overhead.
 *
 * @param {Int32Array} xArr - X coordinates
 * @param {Int32Array} yArr - Y coordinates
 * @param {Int32Array} fArr - F (floor) coordinates
 * @param {number} z - Zoom level (constant for all)
 * @returns {Float32Array} Flat array [ex0,ey0,ez0, ex1,ey1,ez1, ...]
 */
/**
 * @param {number} [altOffset=0] - Additional altitude offset in meters (useful to raise voxels above terrain)
 */
export function batchZfxyToEcef(xArr, yArr, fArr, z, altOffset = 0) {
	const count = xArr.length;
	const result = new Float32Array(count * 3);
	const n = Math.pow(2, z);
	const n1 = Math.pow(2, z + 1);
	const vHeight = voxelHeight(z);
	const halfHeight = vHeight / 2;
	const altBase = Math.pow(2, ZFXY_1M_ZOOM_BASE);

	for (let i = 0; i < count; i++) {
		// Center lng/lat (inline tileCenterLngLat for speed)
		const cx = (2 * xArr[i] + 1);
		const cy = (2 * yArr[i] + 1);
		const lng = (cx / n1) * 360 - 180;
		const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * cy) / n1)));
		const lat = latRad * RAD2DEG;

		// Center altitude
		const alt = (fArr[i] * altBase) / n + halfHeight + altOffset;

		// ECEF projection
		const ecef = projector.project(lat, lng, alt);
		result[i * 3] = ecef[0];
		result[i * 3 + 1] = ecef[1];
		result[i * 3 + 2] = ecef[2];
	}

	return result;
}

/**
 * Compute approximate voxel horizontal size in meters at a given latitude and zoom.
 */
export function voxelHorizontalSize(lat, z) {
	const R = 6378137; // WGS84 equatorial radius
	const n = Math.pow(2, z);
	// At the equator, each tile is (2*pi*R)/n meters wide
	// At latitude, multiply by cos(lat)
	return (2 * Math.PI * R * Math.cos(lat * DEG2RAD)) / n;
}

/**
 * Compute ENU-to-ECEF rotation matrix elements at a given lat/lon.
 * Returns the 9 elements of the 3x3 rotation matrix in row-major order.
 */
/**
 * Convert greedy mesh grid positions to ECEF positions relative to a center point.
 * The greedy mesher outputs positions in integer grid coordinates (voxel units).
 * This converts them to ECEF meters, offset from a tile center.
 *
 * @param {Float32Array} gridPositions - Vertex positions in grid coords [x,y,f, x,y,f, ...]
 * @param {number} zoom - ZFXY zoom level
 * @param {number[]} centerEcef - [ex,ey,ez] ECEF center to subtract (for float32 precision)
 * @param {number} [altOffset=0] - Additional altitude offset in meters
 * @returns {Float32Array} Positions in tile-local ECEF (small values, float32 safe)
 */
export function gridToLocalEcef(gridPositions, zoom, centerEcef, altOffset = 0) {
	const count = gridPositions.length / 3;
	const result = new Float32Array(count * 3);
	const n = Math.pow(2, zoom);
	const n1 = Math.pow(2, zoom + 1);
	const altBase = Math.pow(2, ZFXY_1M_ZOOM_BASE);
	const vH = voxelHeight(zoom);

	for (let i = 0; i < count; i++) {
		const gx = gridPositions[i * 3];     // grid X (can be fractional from quad corners)
		const gy = gridPositions[i * 3 + 1]; // grid Y
		const gf = gridPositions[i * 3 + 2]; // grid F

		// Convert grid to lng/lat/alt
		// Grid coords are at voxel edges (integer = edge, not center)
		const lng = (gx / n) * 360 - 180;
		const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / n)));
		const lat = latRad * RAD2DEG;
		const alt = (gf * altBase) / n + altOffset;

		// To ECEF
		const ecef = projector.project(lat, lng, alt);

		// Subtract center for float32 precision
		result[i * 3] = ecef[0] - centerEcef[0];
		result[i * 3 + 1] = ecef[1] - centerEcef[1];
		result[i * 3 + 2] = ecef[2] - centerEcef[2];
	}

	return result;
}

/**
 * Compute the ECEF center of a tile from its voxel data.
 * Uses the median voxel position for a representative center.
 */
export function computeTileCenterEcef(x, y, f, count, zoom) {
	const midIdx = Math.floor(count / 2);
	const center = tileCenterLngLat(x[midIdx], y[midIdx], zoom);
	const alt = voxelCenterAlt(f[midIdx], zoom);
	return projector.project(center.lat, center.lng, alt);
}

/**
 * Downsample ZFXY coordinates by shifting bits (coarser LOD).
 * Reduces zoom level by `levels`, deduplicating merged voxels.
 *
 * @param {Int32Array} x
 * @param {Int32Array} y
 * @param {Int32Array} f
 * @param {Uint32Array} buildingIdx
 * @param {number} levels - Number of zoom levels to reduce (1 = ZL24, 2 = ZL23, etc.)
 * @returns {{ x: Int32Array, y: Int32Array, f: Int32Array, buildingIdx: Uint32Array, count: number }}
 */
export function downsampleZFXY(x, y, f, buildingIdx, levels) {
	const shift = levels;
	const seen = new Set();
	const count = x.length;
	const ox = new Int32Array(count);
	const oy = new Int32Array(count);
	const of_ = new Int32Array(count);
	const ob = new Uint32Array(count);
	let outCount = 0;

	for (let i = 0; i < count; i++) {
		const sx = x[i] >> shift;
		const sy = y[i] >> shift;
		const sf = f[i] >> shift;
		const key = `${buildingIdx[i]}/${sx}/${sy}/${sf}`;
		if (seen.has(key)) continue;
		seen.add(key);
		ox[outCount] = sx;
		oy[outCount] = sy;
		of_[outCount] = sf;
		ob[outCount] = buildingIdx[i];
		outCount++;
	}

	return {
		x: ox.slice(0, outCount),
		y: oy.slice(0, outCount),
		f: of_.slice(0, outCount),
		buildingIdx: ob.slice(0, outCount),
		count: outCount,
	};
}

export function enuToEcefRotation(latDeg, lngDeg) {
	const lat = latDeg * DEG2RAD;
	const lng = lngDeg * DEG2RAD;
	const sinLat = Math.sin(lat);
	const cosLat = Math.cos(lat);
	const sinLng = Math.sin(lng);
	const cosLng = Math.cos(lng);

	// Column-major (for Three.js Matrix4):
	// East  = [-sinLng,         cosLng,        0      ]
	// North = [-sinLat*cosLng, -sinLat*sinLng,  cosLat ]
	// Up    = [ cosLat*cosLng,  cosLat*sinLng,  sinLat ]
	return {
		e00: -sinLng,          e01: -sinLat * cosLng, e02: cosLat * cosLng,
		e10: cosLng,           e11: -sinLat * sinLng, e12: cosLat * sinLng,
		e20: 0,                e21: cosLat,           e22: sinLat,
	};
}

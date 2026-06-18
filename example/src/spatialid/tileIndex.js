/**
 * Tile index: manages the manifest of available spatial ID tiles
 * and determines which tiles to load based on camera position.
 *
 * Japan map sheet codes (e.g. 53394548) follow a hierarchical grid.
 * The 8-digit code encodes: 1:200k sheet (2 digits) + 1:25k subdivision (6 digits).
 * Each tile covers roughly 1km × 0.7km at Tokyo's latitude.
 *
 * Rather than decoding the grid system, we store the geographic center
 * of each tile (computed from the first voxel's coordinates) and use
 * simple distance-based selection.
 */

import { tileCenterLngLat, lngLatToTile } from "./zfxyMath.js";
import projector from "ecef-projector";

/**
 * @typedef {Object} TileManifestEntry
 * @property {string} url - Full URL to the CSV file
 * @property {number} [centerLat] - Cached center latitude (set after first load)
 * @property {number} [centerLng] - Cached center longitude
 * @property {number[]} [centerEcef] - Cached ECEF center
 */

export class TileIndex {

	/**
	 * @param {string} baseUrl - Base URL prepended to tile filenames
	 * @param {Object<string, string>} manifest - Map of tile code → filename
	 */
	constructor(baseUrl, manifest) {
		this.baseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";

		/** @type {Map<string, TileManifestEntry>} */
		this.tiles = new Map();

		for (const [code, filename] of Object.entries(manifest)) {
			this.tiles.set(code, {
				url: this.baseUrl + filename,
			});
		}
	}

	/**
	 * Set the geographic center of a tile (called after parsing its data).
	 * This enables distance-based tile selection.
	 */
	setTileCenter(tileCode, lat, lng) {
		const entry = this.tiles.get(tileCode);
		if (!entry) return;
		entry.centerLat = lat;
		entry.centerLng = lng;
		entry.centerEcef = projector.project(lat, lng, 0);
	}

	/**
	 * Compute the geographic center of a tile from its parsed voxel data.
	 * Uses the median X/Y coordinates to estimate the tile center.
	 */
	computeTileCenter(tileCode, tileData) {
		const { x, y, count, zoom } = tileData;
		if (count === 0) return;

		// Use median voxel as center estimate
		const midIdx = Math.floor(count / 2);
		const center = tileCenterLngLat(x[midIdx], y[midIdx], zoom);
		this.setTileCenter(tileCode, center.lat, center.lng);
	}

	/**
	 * Get URL for a tile.
	 */
	getUrl(tileCode) {
		return this.tiles.get(tileCode)?.url;
	}

	/**
	 * Get all tile codes.
	 */
	getAllCodes() {
		return Array.from(this.tiles.keys());
	}

	/**
	 * Get tile codes within range of a camera position.
	 *
	 * @param {number[]} cameraEcef - Camera position [x,y,z] in ECEF
	 * @param {number} maxDistMeters - Maximum distance in meters
	 * @returns {string[]} Tile codes within range
	 */
	getTilesInRange(cameraEcef, maxDistMeters) {
		const result = [];
		const maxDistSq = maxDistMeters * maxDistMeters;

		for (const [code, entry] of this.tiles) {
			if (!entry.centerEcef) {
				// Tile hasn't been loaded yet — include it as a candidate
				// (we'll compute its center after first load)
				result.push(code);
				continue;
			}

			const dx = cameraEcef[0] - entry.centerEcef[0];
			const dy = cameraEcef[1] - entry.centerEcef[1];
			const dz = cameraEcef[2] - entry.centerEcef[2];
			const distSq = dx * dx + dy * dy + dz * dz;

			if (distSq <= maxDistSq) {
				result.push(code);
			}
		}

		return result;
	}

	/**
	 * Get distance from camera to a tile center.
	 * Returns Infinity if tile center is unknown.
	 */
	getDistanceToTile(tileCode, cameraEcef) {
		const entry = this.tiles.get(tileCode);
		if (!entry?.centerEcef) return Infinity;

		const dx = cameraEcef[0] - entry.centerEcef[0];
		const dy = cameraEcef[1] - entry.centerEcef[1];
		const dz = cameraEcef[2] - entry.centerEcef[2];
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}
}

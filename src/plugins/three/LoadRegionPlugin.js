import { Ray, Sphere } from "three";
import { OBB } from "../../three/math/OBB.js";

export class LoadRegionPlugin {
	constructor() {
		this.name = "LOAD_REGION_PLUGIN";
		this.regions = [];
		this.tiles = null;
	}

	init(tiles) {
		this.tiles = tiles;
	}

	addRegion(region) {
		if (this.regions.indexOf(region) === -1) {
			this.regions.push(region);
		}
	}

	removeRegion(region) {
		const index = this.regions.indexOf(region);
		if (index !== -1) {
			this.regions.splice(index, 1);
		}
	}

	hasRegion(region) {
		return this.regions.indexOf(region) !== -1;
	}

	clearRegions() {
		this.regions = [];
	}

	// calculateTileViewError(tile, target) {
	// 	const boundingVolume = tile.cached.boundingVolume;
	// 	const { regions, tiles } = this;

	// 	let visible = false;
	// 	let maxError = -Infinity;
	// 	for (const region of regions) {
	// 		const intersects = region.intersectsTile(boundingVolume, tile, tiles);
	// 		if (intersects) {
	// 			visible = true;
	// 			maxError = Math.max(region.calculateError(tile, tiles), maxError);
	// 		}
	// 	}

	// 	target.inView = visible;
	// 	target.error = maxError;
	// }

	calculateTileViewError(tile, target) {
		const boundingVolume = tile.cached.boundingVolume;
		const { regions, tiles } = this;

		let visible = true;
		let maxError = -Infinity;
		for (const region of regions) {
			// maxError = Math.max(region.calculateError(tile, tiles), maxError);
			const intersects = region.intersectsTile(boundingVolume, tile, tiles);
			if (intersects && tile.geometricError < 3) {
				tiles.invokeOnePlugin(
					(plugin) =>
						plugin !== this &&
						plugin.setTileVisible &&
						plugin.setTileVisible(tile, false)
				);
			}
			// else if (intersects) {
			// 	tiles.invokeOnePlugin(
			// 		(plugin) =>
			// 			plugin !== this &&
			// 			plugin.setTileVisible &&
			// 			plugin.setTileVisible(tile, true)
			// 	);
			// }
		}

		target.inView = visible;
		target.error = 3;
		// console.log(tile.geometricError);
	}

	// calculateTileViewError(tile, target) {
	// 	const boundingVolume = tile.cached.boundingVolume;
	// 	const { regions, tiles } = this;

	// 	// start with assumption that tile should be visible
	// 	let intersectsAnyRegion = false;

	// 	for (const region of regions) {
	// 		if (region.intersectsTile(boundingVolume, tile, tiles)) {
	// 			intersectsAnyRegion = true;
	// 			break;
	// 		}
	// 	}

	// 	if (intersectsAnyRegion) {
	// 		// The tile intersects exclusion region -> discard
	// 		target.inView = false;
	// 		target.error = -Infinity;
	// 	} else {
	// 		// The tile does not intersect exclusion region -> keep and evaluate error
	// 		target.inView = true;

	// 		let maxError = -Infinity;
	// 		for (const region of regions) {
	// 			maxError = Math.max(region.calculateError(tile, tiles), maxError);
	// 		}
	// 		target.error = maxError;
	// 	}
	// }

	dispose() {
		this.regions = [];
	}
}

// Definitions of predefined regions
export class BaseRegion {
	constructor(errorTarget = 10) {
		this.errorTarget = errorTarget;
	}

	intersectsTile() {}

	calculateError(tile, tilesRenderer) {
		return tile.geometricError - this.errorTarget + tilesRenderer.errorTarget;
	}
}

export class SphereRegion extends BaseRegion {
	constructor(errorTarget = 10, sphere = new Sphere()) {
		super(errorTarget);
		this.sphere = sphere.clone();
	}

	intersectsTile(boundingVolume) {
		return boundingVolume.intersectsSphere(this.sphere);
	}
}

export class RayRegion extends BaseRegion {
	constructor(errorTarget = 10, ray = new Ray()) {
		super(errorTarget);
		this.ray = ray.clone();
	}

	intersectsTile(boundingVolume) {
		return boundingVolume.intersectsRay(this.ray);
	}
}

export class OBBRegion extends BaseRegion {
	constructor(errorTarget = 10, obb = new OBB()) {
		super(errorTarget);
		this.obb = obb.clone();
		this.obb.update();
	}

	intersectsTile(boundingVolume) {
		return boundingVolume.intersectsOBB(this.obb);
	}
}

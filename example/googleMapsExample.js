import {
	WGS84_ELLIPSOID,
	CAMERA_FRAME,
	GeoUtils,
	GlobeControls,
	CameraTransitionManager,
	TilesRenderer,
} from "3d-tiles-renderer";
import {
	TilesFadePlugin,
	UpdateOnChangePlugin,
	TileCompressionPlugin,
	UnloadTilesPlugin,
	GLTFExtensionsPlugin,
	BatchedTilesPlugin,
	CesiumIonAuthPlugin,
	LoadRegionPlugin,
	DebugTilesPlugin,
	OBBRegion,
} from "3d-tiles-renderer/plugins";
import {
	Scene,
	WebGLRenderer,
	PerspectiveCamera,
	MathUtils,
	OrthographicCamera,
	Plane,
	Vector3,
	Box3,
	Mesh,
	Matrix4,
	Frustum,
} from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GUI } from "three/examples/jsm/libs/lil-gui.module.min.js";
import Stats from "three/examples/jsm/libs/stats.module.js";
import { TopoLinesPlugin } from "./src/plugins/topolines/TopoLinesPlugin.js";
import * as THREE from "three";
import { Space } from "@spatial-id/javascript-sdk";
import projector from "ecef-projector";

let controls,
	scene,
	renderer,
	tiles,
	tiles2,
	tiles3,
	tiles4,
	tiles5,
	tiles6,
	transition;
let statsContainer, stats;
let boxRegion;
let boundingtilesloaded = false;
let pointcloudtilesloaded = false;
let iref, irefRegion, osakaexpo;
let helper;
let axes;
let sensorGroup;
let voxelGroup;

const clippingPlanes = [];
const res = {};

// Max number of voxels you ever want to draw in one frame
const MAX_VOXELS = 500000;

// distance thresholds (in meters)
const maxDistNear = 100; // inside here, draw every point
const maxDistFar = 200; // beyond here, never draw
const lodFalloff = 150; // how quickly to skip as you go out

// one shared tmp Vector3 and Matrix4 to avoid allocations:
const tmpV = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();

// projection‐frustum helpers:
const projScreenMatrix = new THREE.Matrix4();
const frustum = new THREE.Frustum();

// camera pos helper
let camPos = new THREE.Vector3();

// map from tile.id → Float32Array of world‐space [x,y,z, x,y,z,…]
const visibleTilePositions = new Map();
let voxelMesh = null;

const visibleTilePositions2 = new Map();
let voxelMesh2 = null;

const Z_CONST = 28;
const R_EQUATOR = 6_378_137; // WGS84 equatorial radius [m]
const DEG2RAD = Math.PI / 180;

const params = {
	orthographic: false,
	enableCacheDisplay: false,
	enableRendererStats: false,
	useBatchedMesh: Boolean(
		new URLSearchParams(window.location.hash.replace(/^#/, "")).get("batched")
	),
	displayTopoLines: false,
	errorTarget: 20,
	fov: 60,
	AltitudeOffset: 50,
	ZoomLevel: 28,
	DrawStaticSpatialID: true,
	DrawHelpers: false,
	reload: reinstantiateTiles,
};

function visualizeOBB(scene, color = 0xff0000) {
	let boundingboxmatrix = new Matrix4();
	if (tiles3.getOrientedBoundingBox(iref, boundingboxmatrix)) {
		tiles3.group.visible = false;
		const size = new THREE.Vector3();
		size.subVectors(iref.max, iref.min);
		const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
		const material = new THREE.MeshBasicMaterial({
			color: color,
			wireframe: true,
			depthTest: true,
		});
		const mesh = new THREE.Mesh(geometry, material);
		boundingboxmatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
		scene.add(mesh);
		console.log(mesh);
	}
}

/**
 * incoming ID is "Z/X/Y/F", but Spatial-ID wants "Z/F/X/Y"
 * e.g. "28/237863652/106326705/13" → "28/13/237863652/106326705"
 */
function reorderSpatialId(zxyf) {
	const [z, x, y, f] = zxyf.split("/");
	return `${z}/${f}/${x}/${y}`;
}
function parseSpatialId(str) {
	const parts = str.replace(/^\/+/, "").split("/");
	return {
		zoom: +parts[0],
		f: +parts[1],
		x: +parts[2],
		y: +parts[3],
	};
}
function pickByZoom(spatialIds, zoom) {
	// try exact match first
	const exact = spatialIds.find((si) => si.zoom === zoom);
	if (exact) return exact;

	// otherwise fall back to the highest‐zoom entry
	return spatialIds.reduce((a, b) => (a.zoom > b.zoom ? a : b));
}

function handleOBBClippingChange(box3, matrixWorld, scene) {
	const normals = [
		new THREE.Vector3(-1, 0, 0), // -X
		new THREE.Vector3(1, 0, 0), // +X
		new THREE.Vector3(0, -1, 0), // -Y
		new THREE.Vector3(0, 1, 0), // +Y
		new THREE.Vector3(0, 0, -1), // -Z
		new THREE.Vector3(0, 0, 1), // +Z
	];

	// 3) local “scale” = full box size
	const size = new THREE.Vector3();
	box3.getSize(size); // size = (max - min)

	// 4) extract only rotation from your world matrix
	const rotationMatrix = new THREE.Matrix4().extractRotation(matrixWorld);

	// 5) box world‐position
	const position = new THREE.Vector3();
	matrixWorld.decompose(
		position,
		/*quat*/ new THREE.Quaternion(),
		/*scale*/ new THREE.Vector3()
	);

	// 6) build six planes
	for (let i = 0; i < normals.length; i++) {
		const normalLocal = normals[i];

		// facePoint in local space: normal * (sizeAlongThatAxis/2)
		const axis = Math.floor(i / 2); // 0→X,1→X,2→Y,3→Y,4→Z,5→Z
		const halfExtent = size.getComponent(axis) / 2;
		const facePointLoc = new THREE.Vector3()
			.copy(normalLocal)
			.multiplyScalar(halfExtent);

		// rotate normal into world, then renormalize
		const normalWorld = normalLocal
			.clone()
			.applyMatrix4(rotationMatrix)
			.normalize();

		// rotate face-point into world, then translate
		const facePointWorld = facePointLoc
			.clone()
			.applyMatrix4(rotationMatrix)
			.add(position);

		// plane constant = –(n · P)
		const constant = -facePointWorld.dot(normalWorld);

		// build and push the plane
		clippingPlanes.push(new THREE.Plane(normalWorld, constant));
	}

	// 7) apply to every mesh in your tileset group

	// return clippingPlanes;
}

function reinstantiateTiles() {
	if (tiles) {
		scene.remove(tiles.group);
		tiles.dispose();
		tiles = null;
	}
	if (tiles2) {
		scene.remove(tiles2.group);
		tiles2.dispose();
		tiles2 = null;
	}

	if (tiles3) {
		scene.remove(tiles3.group);
		tiles3.dispose();
		tiles3 = null;
	}

	if (tiles4) {
		scene.remove(tiles4.group);
		tiles4.dispose();
		tiles4 = null;
	}

	if (tiles5) {
		scene.remove(tiles5.group);
		tiles5.dispose();
		tiles5 = null;
	}

	if (tiles6) {
		scene.remove(tiles6.group);
		tiles6.dispose();
		tiles6 = null;
	}

	tiles4 = new TilesRenderer("./datasets/I-REF_2018/tileset.json");
	tiles4.registerPlugin(new TileCompressionPlugin());
	tiles4.registerPlugin(new UpdateOnChangePlugin());
	tiles4.registerPlugin(new UnloadTilesPlugin());

	scene.add(tiles4.group);

	tiles4.addEventListener("load-model", (e) => {
		e.scene.traverse((child) => {
			if (!child.isMesh) return;

			// pick a random HSL color
			const hue = Math.random();
			const sat = 0.25 + Math.random() * 0.25;
			const lum = 0.375 + Math.random() * 0.25;

			// 1) semi-transparent surface
			child.material = new THREE.MeshBasicMaterial({
				color: new THREE.Color().setHSL(hue, sat, lum),
				transparent: true,
				opacity: 0.3,
				side: THREE.DoubleSide,
				polygonOffset: true,
				polygonOffsetFactor: 1,
				polygonOffsetUnits: 1,
			});
			child.material.needsUpdate = true;

			// 2) wireframe overlay
			const wireGeo = new THREE.WireframeGeometry(child.geometry);
			const wireMat = new THREE.LineBasicMaterial({
				color: child.material.color,
				linewidth: 1,
				transparent: false,
			});
			const wireframe = new THREE.LineSegments(wireGeo, wireMat);

			// copy transforms
			wireframe.position.copy(child.position);
			wireframe.rotation.copy(child.rotation);
			wireframe.scale.copy(child.scale);

			// draw on top
			wireframe.renderOrder = 1;

			// ←—— here’s the key bit:
			// prevent the raycaster from ever hitting the wireframe
			wireframe.raycast = () => {};

			child.parent.add(wireframe);
		});
	});

	tiles3 = new TilesRenderer("./datasets/geometrycutout/tileset.json");
	tiles3.registerPlugin(new TileCompressionPlugin());
	tiles3.registerPlugin(new UpdateOnChangePlugin());
	tiles3.registerPlugin(new UnloadTilesPlugin());
	tiles3.registerPlugin(new TilesFadePlugin());

	scene.add(tiles3.group);

	tiles3.addEventListener("load-model", (e) => {
		boundingtilesloaded = true;
		const boxMat = new THREE.Matrix4();
		if (!tiles3.getOrientedBoundingBox(iref, boxMat)) return;

		iref.max.set(iref.max.x + 2, iref.max.y + 2, iref.max.z + 2);
		console.log(iref);

		handleOBBClippingChange(iref, boxMat, scene);
		// visualizeOBB(scene);
		if (tiles3) {
			scene.remove(tiles3.group);
			tiles3.dispose();
			tiles3 = null;
		}
	});

	tiles = new TilesRenderer();
	tiles.registerPlugin(
		new CesiumIonAuthPlugin({
			apiToken: import.meta.env.VITE_ION_KEY,
			assetId: "2275207",
			autoRefreshToken: true,
		})
	);
	tiles.registerPlugin(new TileCompressionPlugin());
	tiles.registerPlugin(new UpdateOnChangePlugin());
	tiles.registerPlugin(new UnloadTilesPlugin());
	tiles.registerPlugin(new TilesFadePlugin());
	// tiles.registerPlugin(new LoadRegionPlugin());
	tiles.registerPlugin(new TopoLinesPlugin({ projection: "ellipsoid" }));
	tiles.registerPlugin(
		new GLTFExtensionsPlugin({
			dracoLoader: new DRACOLoader().setDecoderPath(
				"https://unpkg.com/three@0.153.0/examples/jsm/libs/draco/gltf/"
			),
		})
	);

	if (params.useBatchedMesh) {
		tiles.registerPlugin(
			new BatchedTilesPlugin({
				renderer,
				discardOriginalContent: false,
				instanceCount: 250,
			})
		);
	}

	scene.add(tiles.group);

	tiles.addEventListener("load-model", (e) => {
		if (boundingtilesloaded) {
			tiles.group.traverse((obj) => {
				if (obj.isMesh) {
					obj.material.clipIntersection = true;
					obj.material.clippingPlanes = clippingPlanes;
					obj.material.needsUpdate = true;
				}
			});
		}
	});

	tiles2 = new TilesRenderer("./datasets/bunkyo/tileset.json");
	// tiles2.registerPlugin(
	// 	new CesiumIonAuthPlugin({
	// 		apiToken: import.meta.env.VITE_ION_KEY,
	// 		assetId: "3435658",
	// 		autoRefreshToken: true,
	// 	})
	// );
	tiles2.registerPlugin(new TileCompressionPlugin());
	tiles2.registerPlugin(new UpdateOnChangePlugin());
	tiles2.registerPlugin(new UnloadTilesPlugin());
	tiles2.registerPlugin(new TilesFadePlugin());

	scene.add(tiles2.group);

	tiles2.addEventListener("tile-visibility-change", (e) => {
		tiles2.group.visible = false;
		const pts = e.scene; // this is your THREE.Points
		// console.log(pts);
		if (!pts.isPoints) return; // bail if it somehow isn’t

		let uuid;
		let posAttr;
		let worldMat;

		if (e.visible) {
			uuid = pts.uuid; // unique key per tile
			posAttr = pts.geometry.attributes.position;
			worldMat = pts.matrixWorld;

			// → tile just became visible
			if (visibleTilePositions.has(uuid)) return; // already baked

			const arr = new Float32Array(posAttr.count * 3);
			const p = new THREE.Vector3();
			for (let i = 0; i < posAttr.count; i++) {
				p.fromBufferAttribute(posAttr, i).applyMatrix4(worldMat);
				arr[3 * i] = p.x;
				arr[3 * i + 1] = p.y;
				arr[3 * i + 2] = p.z;
			}

			visibleTilePositions.set(uuid, arr);
			// console.log(`Tile ${uuid} visible → baked ${posAttr.count} points`);
		} else {
			// → tile just went out of view
			if (visibleTilePositions.delete(uuid)) {
				// console.log(`Tile ${uuid} hidden → removed`);
			}
		}

		// console.log(`→ tracking ${visibleTilePositions.size} tile(s)`);

		// lazy-create your InstancedMesh once
		if (!voxelMesh && visibleTilePositions.size > 0) {
			const space = new Space({ lat: 35.715848, lng: 139.761099, alt: 20 });
			const verts = space.vertices3d();

			const corners = verts.map((v) => {
				const [lng, lat, alt] = Array.isArray(v) ? v : [v.lng, v.lat, v.alt];
				return new Vector3(...projector.project(lat, lng, alt));
			});
			const voxelsizehorizontal = corners[1].distanceTo(corners[0]);
			// console.log(voxelsizehorizontal);
			const voxelsizevertical = corners[4].distanceTo(corners[0]);

			const eastEdge = new Vector3().subVectors(corners[3], corners[0]);
			const southEdge = new Vector3().subVectors(corners[1], corners[0]);
			const upEdge = new Vector3().subVectors(corners[4], corners[0]);
			const mBasis = new Matrix4().makeBasis(
				eastEdge.clone().normalize(),
				southEdge.clone().normalize(),
				upEdge.clone().normalize()
			);
			// console.log(mBasis);
			const rot = new THREE.Matrix4().extractRotation(mBasis);

			const boxGeo = new THREE.BoxGeometry(
				voxelsizehorizontal,
				voxelsizehorizontal,
				voxelsizevertical
			);

			boxGeo.applyMatrix4(rot);
			const boxMat = new THREE.MeshBasicMaterial({
				color: 0xffffff,
				transparent: true,
				wireframe: true,
				depthTest: true,
				opacity: 0.3,
			});
			voxelMesh = new THREE.InstancedMesh(boxGeo, boxMat, MAX_VOXELS);
			voxelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			voxelMesh.frustumCulled = false;
			voxelGroup.add(voxelMesh);
			// scene.add(voxelMesh);
		}
	});

	tiles5 = new TilesRenderer("./datasets/osaka/tileset.json");
	// tiles5.registerPlugin(
	// 	new CesiumIonAuthPlugin({
	// 		apiToken: import.meta.env.VITE_ION_KEY,
	// 		assetId: "3471063",
	// 		autoRefreshToken: true,
	// 	})
	// );
	tiles5.registerPlugin(new TileCompressionPlugin());
	tiles5.registerPlugin(new UpdateOnChangePlugin());
	tiles5.registerPlugin(new UnloadTilesPlugin());
	tiles5.registerPlugin(new TilesFadePlugin());
	scene.add(tiles5.group);

	tiles5.addEventListener("tile-visibility-change", (e) => {
		tiles5.group.visible = false;
		const pts = e.scene; // this is your THREE.Points
		// console.log(pts);
		if (!pts.isPoints) return; // bail if it somehow isn’t

		let uuid;
		let posAttr;
		let worldMat;

		if (e.visible) {
			uuid = pts.uuid; // unique key per tile
			posAttr = pts.geometry.attributes.position;
			worldMat = pts.matrixWorld;

			// → tile just became visible
			if (visibleTilePositions2.has(uuid)) return; // already baked

			const arr = new Float32Array(posAttr.count * 3);
			const p = new THREE.Vector3();
			for (let i = 0; i < posAttr.count; i++) {
				p.fromBufferAttribute(posAttr, i).applyMatrix4(worldMat);
				arr[3 * i] = p.x;
				arr[3 * i + 1] = p.y;
				arr[3 * i + 2] = p.z;
			}

			visibleTilePositions2.set(uuid, arr);
			// console.log(`Tile ${uuid} visible → baked ${posAttr.count} points`);
		} else {
			// → tile just went out of view
			if (visibleTilePositions2.delete(uuid)) {
				// console.log(`Tile ${uuid} hidden → removed`);
			}
		}

		// lazy-create your InstancedMesh once
		if (!voxelMesh2 && visibleTilePositions2.size > 0) {
			const space = new Space({ lat: 34.649007, lng: 135.383477, alt: 20 });
			const verts = space.vertices3d();

			const corners = verts.map((v) => {
				const [lng, lat, alt] = Array.isArray(v) ? v : [v.lng, v.lat, v.alt];
				return new Vector3(...projector.project(lat, lng, alt));
			});
			const voxelsizehorizontal = corners[1].distanceTo(corners[0]);
			// console.log(voxelsizehorizontal);
			const voxelsizevertical = corners[4].distanceTo(corners[0]);

			const eastEdge = new Vector3().subVectors(corners[3], corners[0]);
			const southEdge = new Vector3().subVectors(corners[1], corners[0]);
			const upEdge = new Vector3().subVectors(corners[4], corners[0]);
			const mBasis = new Matrix4().makeBasis(
				eastEdge.clone().normalize(),
				southEdge.clone().normalize(),
				upEdge.clone().normalize()
			);
			// console.log(mBasis);
			const rot = new THREE.Matrix4().extractRotation(mBasis);

			const boxGeo = new THREE.BoxGeometry(
				voxelsizehorizontal,
				voxelsizehorizontal,
				voxelsizevertical
			);

			boxGeo.applyMatrix4(rot);
			const boxMat = new THREE.MeshBasicMaterial({
				color: 0xffffff,
				transparent: true,
				wireframe: true,
				depthTest: true,
				opacity: 0.3,
			});
			voxelMesh2 = new THREE.InstancedMesh(boxGeo, boxMat, MAX_VOXELS);
			voxelMesh2.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			voxelMesh2.frustumCulled = false;
			voxelGroup.add(voxelMesh2);
			// scene.add(voxelMesh);
		}

		// hide the raw points so only voxels remain
		// pts.visible = false;
	});

	tiles.setResolutionFromRenderer(transition.camera, renderer);
	tiles.setCamera(transition.camera);
	tiles2.setResolutionFromRenderer(transition.camera, renderer);
	tiles2.setCamera(transition.camera);

	if (tiles3) {
		tiles3.setResolutionFromRenderer(transition.camera, renderer);
		tiles3.setCamera(transition.camera);
	}

	tiles4.setResolutionFromRenderer(transition.camera, renderer);
	tiles4.setCamera(transition.camera);

	tiles5.setResolutionFromRenderer(transition.camera, renderer);
	tiles5.setCamera(transition.camera);

	// controls.setScene(tiles.group);
	controls.raycaster.layers.set(0);
	controls.setTilesRenderer(tiles);
}

function init() {
	renderer = new WebGLRenderer({ antialias: true });
	// renderer.setClearColor(0x151c1f);
	renderer.setClearColor(0x000000);
	renderer.localClippingEnabled = true;
	document.body.appendChild(renderer.domElement);

	scene = new Scene();
	transition = new CameraTransitionManager(
		new PerspectiveCamera(
			params.fov,
			window.innerWidth / window.innerHeight,
			0.1,
			160000000
		),
		new OrthographicCamera(-1, 1, 1, -1, 1, 160000000)
	);

	transition.perspectiveCamera.position.set(4800000, 2570000, 14720000);
	transition.perspectiveCamera.lookAt(0, 0, 0);
	transition.perspectiveCamera.rotation.z = (-2 * Math.PI) / 3;

	// console.log(transition);
	transition.autoSync = false;
	transition.addEventListener("camera-change", ({ camera, prevCamera }) => {
		tiles.deleteCamera(prevCamera);
		tiles.setCamera(camera);
		controls.setCamera(camera);
	});

	controls = new GlobeControls(
		scene,
		transition.camera,
		renderer.domElement,
		null
	);
	controls.enableDamping = true;
	controls.adjustHeight = false;
	controls.cameraRadius = 0;
	controls.minDistance = -5;
	controls.maxDistance = Infinity;
	controls.minZoom = 0.0000001;
	controls.maxZoom = 9999.0;
	// console.log(controls);

	iref = new THREE.Box3();
	irefRegion = new OBBRegion();

	sensorGroup = new THREE.Group();
	scene.add(sensorGroup);

	voxelGroup = new THREE.Group();
	scene.add(voxelGroup);

	//websocket handling
	const socket = new WebSocket("wss://nodered.tlab.cloud/osaka");

	socket.onmessage = async (evt) => {
		for (let i = sensorGroup.children.length - 1; i >= 0; i--) {
			const c = sensorGroup.children[i];
			c.geometry?.dispose();
			c.material?.dispose();
			sensorGroup.remove(c);
		}
		let objs;
		try {
			objs = JSON.parse(evt.data);
		} catch {
			return;
		}
		const alt = params.AltitudeOffset;
		for (const obj of objs) {
			obj.spatial_ids.forEach((si) => {
				si.min_corner = reorderSpatialId(si.min_corner);
				si.max_corner = reorderSpatialId(si.max_corner);
			});
			const top = pickByZoom(obj.spatial_ids, params.ZoomLevel);
			const spaceMin = new Space(top.min_corner);
			const spaceMax = new Space(top.max_corner);
			const vertsMin = spaceMin.vertices3d();
			const vertsMax = spaceMax.vertices3d();
			const corners = vertsMin.concat(vertsMax).map((v) => {
				const [lng, lat, alt0] = Array.isArray(v) ? v : [v.lng, v.lat, v.alt];
				return new Vector3(...projector.project(lat, lng, alt0 + alt));
			});
			const eastEdge = new Vector3().subVectors(corners[3], corners[0]);
			const southEdge = new Vector3().subVectors(corners[1], corners[0]);
			const upEdge = new Vector3().subVectors(corners[4], corners[0]);
			const mBasis = new Matrix4().makeBasis(
				eastEdge.clone().normalize(),
				southEdge.clone().normalize(),
				upEdge.clone().normalize()
			);
			const minT = parseSpatialId(top.min_corner);
			const maxT = parseSpatialId(top.max_corner);
			const countX = maxT.x - minT.x + 1;
			const countY = maxT.y - minT.y + 1;
			const countZ = maxT.f - minT.f + 1;
			const size = new Vector3(
				eastEdge.length() * countX,
				southEdge.length() * countY,
				upEdge.length() * countZ
			);
			const geom = new THREE.BoxGeometry(size.x, size.y, size.z);
			const mat = new THREE.MeshBasicMaterial({
				color: obj.name === "person" ? 0xff0000 : 0x0000ff,
				wireframe: false,
				depthTest: true,
			});
			const center = corners[0]
				.clone()
				.add(eastEdge.clone().multiplyScalar(countX / 2))
				.add(southEdge.clone().multiplyScalar(countY / 2))
				.add(upEdge.clone().multiplyScalar(countZ / 2));
			const mesh = new THREE.Mesh(geom, mat);
			mesh.applyMatrix4(mBasis);
			mesh.position.copy(center);
			sensorGroup.add(mesh);
			axes = new THREE.AxesHelper(5000);
			axes.applyMatrix4(mBasis);
			axes.position.copy(center);
			if (params.DrawHelpers) {
				sensorGroup.add(axes);
			} else {
				if (axes) {
					sensorGroup.remove(axes);
					axes.dispose();
					axes = null;
				}
			}

			const canvas = document.createElement("canvas");
			canvas.width = 720;
			canvas.height = 256;
			const ctx = canvas.getContext("2d");
			ctx.font = "48px Arial";
			ctx.textAlign = "center";
			ctx.fillStyle = "white";
			ctx.fillText("Min: " + top.min_corner, canvas.width / 2, 60);
			ctx.fillText("Max: " + top.max_corner, canvas.width / 2, 140);
			ctx.fillText(`${obj.name} ${obj.confidence}`, canvas.width / 2, 220);
			const tex = new THREE.CanvasTexture(canvas);
			tex.needsUpdate = true;
			const spriteMat = new THREE.SpriteMaterial({
				map: tex,
				depthTest: false,
			});
			const sprite = new THREE.Sprite(spriteMat);
			const horiz = Math.max(size.x, size.y) * 5;
			sprite.scale.set(horiz, horiz * (canvas.height / canvas.width), 1);
			sprite.position.copy(center);
			sensorGroup.add(sprite);
		}
	};
	reinstantiateTiles();

	window.addEventListener("resize", onWindowResize);
	onWindowResize();

	const gui = new GUI();
	gui.width = 300;
	gui.add(params, "orthographic").onChange((v) => {
		controls.getPivotPoint(transition.fixedPoint);
		if (!transition.animating) {
			transition.syncCameras();
			controls.adjustCamera(transition.perspectiveCamera);
			controls.adjustCamera(transition.orthographicCamera);
		}
		transition.toggle();
	});
	gui.add(params, "fov", 40, 90, 1).onChange(() => {
		const { perspectiveCamera, orthographicCamera } = transition;
		perspectiveCamera.fov = params.fov;
		perspectiveCamera.updateProjectionMatrix();
		// onWindowResize();
	});
	const mapsOptions = gui.addFolder("Google Photorealistic Tiles");
	mapsOptions.add(params, "useBatchedMesh").listen();
	mapsOptions.add(params, "reload");

	const exampleOptions = gui.addFolder("Options");
	exampleOptions.add(params, "displayTopoLines").listen();
	exampleOptions.add(params, "errorTarget", 5, 100, 1).onChange(() => {
		tiles.getPluginByName("UPDATE_ON_CHANGE_PLUGIN").needsUpdate = true;
	});
	exampleOptions.add(params, "AltitudeOffset", 0, 100, 0.1);
	exampleOptions.add(params, "ZoomLevel", 25, 28, 1);
	exampleOptions.add(params, "DrawStaticSpatialID");
	exampleOptions.add(params, "DrawHelpers");

	gui.close();
	statsContainer = document.createElement("div");
	document.getElementById("info")?.appendChild(statsContainer);
	stats = new Stats();
	stats.showPanel(0);
	document.body.appendChild(stats.dom);
}

function onWindowResize() {
	const { perspectiveCamera, orthographicCamera } = transition;
	const aspect = window.innerWidth / window.innerHeight;
	perspectiveCamera.aspect = aspect;
	perspectiveCamera.updateProjectionMatrix();
	orthographicCamera.left = -orthographicCamera.top * aspect;
	orthographicCamera.right = -orthographicCamera.left;
	orthographicCamera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setPixelRatio(window.devicePixelRatio);
}

function animate() {
	requestAnimationFrame(animate);
	if (!tiles) return;
	controls.enabled = !transition.animating;
	controls.update();
	transition.update();
	const camera = transition.camera;

	tiles.setResolutionFromRenderer(camera, renderer);
	tiles.setCamera(camera);
	tiles2.setResolutionFromRenderer(camera, renderer);
	tiles2.setCamera(camera);

	if (tiles3) {
		tiles3.setResolutionFromRenderer(camera, renderer);
		tiles3.setCamera(camera);
		tiles3.errorTarget = params.errorTarget;
		tiles3.update();
	}

	tiles4.setResolutionFromRenderer(camera, renderer);
	tiles4.setCamera(camera);

	tiles5.setResolutionFromRenderer(camera, renderer);
	tiles5.setCamera(camera);

	const plugin = tiles.getPluginByName("TOPO_LINES_PLUGIN");
	plugin.topoOpacity = params.displayTopoLines ? 0.5 : 0;
	plugin.cartoOpacity = params.displayTopoLines ? 0.5 : 0;
	camera.updateMatrixWorld();
	tiles.errorTarget = params.errorTarget;
	tiles.update();
	tiles2.errorTarget = params.errorTarget;
	tiles2.update();

	tiles4.errorTarget = params.errorTarget;
	tiles4.update();

	tiles5.errorTarget = params.errorTarget;
	tiles5.update();

	renderer.render(scene, camera);
	stats.update();

	if (tiles) {
		const mat = tiles.group.matrixWorld.clone().invert();
		const vec = camera.position.clone().applyMatrix4(mat);

		WGS84_ELLIPSOID.getPositionToCartographic(vec, res);

		const attributions = tiles.getAttributions()[0]?.value || "";
		document.getElementById("credits").innerText =
			GeoUtils.toLatLonString(res.lat, res.lon, true) + "\n" + attributions;
		// console.log(camera.zoom);
	}

	// const result = GeoUtils.correctGeoCoordWrap(res.lat, res.lat);
	// const space = new Space({
	// 	lat: MathUtils.RAD2DEG * result.lat,
	// 	lng: MathUtils.RAD2DEG * result.lon,
	// 	alt: 20,
	// });
	// const verts = space.vertices3d();

	// const corners = verts.map((v) => {
	// 	const [lng, lat, alt] = Array.isArray(v) ? v : [v.lng, v.lat, v.alt];
	// 	return new Vector3(...projector.project(lat, lng, alt));
	// });
	// const voxelsizehorizontal = corners[1].distanceTo(corners[0]);
	// const voxelsizevertical = corners[4].distanceTo(corners[0]);
	camPos = transition.camera.position; // reuse your camPos vector
	if (voxelMesh && params.DrawStaticSpatialID) {
		// update camera pos once
		voxelGroup.position.copy(transition.camera.position);

		projScreenMatrix.multiplyMatrices(
			transition.camera.projectionMatrix,
			transition.camera.matrixWorldInverse
		);
		frustum.setFromProjectionMatrix(projScreenMatrix);
		camPos.copy(transition.camera.position);

		let count = 0;
		const maxNearSq = maxDistNear * maxDistNear;
		const maxFarSq = maxDistFar * maxDistFar;

		outer: for (const arr of visibleTilePositions.values()) {
			for (let i = 0; i < arr.length; i += 3) {
				const x = arr[i],
					y = arr[i + 1],
					z = arr[i + 2];

				// 1) simple distance‐sphere cull
				const dx = x - camPos.x;
				const dy = y - camPos.y;
				const dz = z - camPos.z;
				const d2 = dx * dx + dy * dy + dz * dz;
				if (d2 > maxFarSq || d2 < 0) continue;

				tmpV.set(x, y, z);
				if (!frustum.containsPoint(tmpV)) continue;
				// tmpV.set(x - camPos.x, y - camPos.y, z - camPos.z);
				// if (!frustum.containsPoint(tmpV)) continue;

				// // 3) LOD skip (same as before)
				const d = Math.sqrt(d2);
				let skip = 1;
				if (d > maxDistNear) {
					skip = Math.floor((d - maxDistNear) / lodFalloff) + 1;
				}
				if ((i / 3) % skip !== 0) continue;

				// 4) stamp

				tmpMat.identity().setPosition(dx, dy, dz);
				voxelMesh.setMatrixAt(count++, tmpMat);

				if (count >= MAX_VOXELS) break outer;
			}
		}

		voxelMesh.count = count;
		voxelMesh.instanceMatrix.needsUpdate = true;
	} else {
		if (voxelMesh) {
			voxelMesh.count = 0;
			voxelMesh.instanceMatrix.needsUpdate = true;
		}
	}

	if (voxelMesh2 && params.DrawStaticSpatialID) {
		voxelGroup.position.copy(transition.camera.position);

		projScreenMatrix.multiplyMatrices(
			transition.camera.projectionMatrix,
			transition.camera.matrixWorldInverse
		);
		frustum.setFromProjectionMatrix(projScreenMatrix);
		camPos.copy(transition.camera.position);

		let count = 0;
		const maxNearSq = maxDistNear * maxDistNear;
		const maxFarSq = maxDistFar * maxDistFar;

		outer: for (const arr of visibleTilePositions2.values()) {
			for (let i = 0; i < arr.length; i += 3) {
				const x = arr[i],
					y = arr[i + 1],
					z = arr[i + 2];

				// 1) simple distance‐sphere cull
				const dx = x - camPos.x;
				const dy = y - camPos.y;
				const dz = z - camPos.z;
				const d2 = dx * dx + dy * dy + dz * dz;
				if (d2 > maxFarSq || d2 < 0) continue;

				tmpV.set(x, y, z);
				if (!frustum.containsPoint(tmpV)) continue;
				// tmpV.set(x - camPos.x, y - camPos.y, z - camPos.z);
				// if (!frustum.containsPoint(tmpV)) continue;

				// // 3) LOD skip (same as before)
				const d = Math.sqrt(d2);
				let skip = 1;
				if (d > maxDistNear) {
					skip = Math.floor((d - maxDistNear) / lodFalloff) + 1;
				}
				if ((i / 3) % skip !== 0) continue;

				// 4) stamp

				tmpMat.identity().setPosition(dx, dy, dz);
				voxelMesh2.setMatrixAt(count++, tmpMat);

				if (count >= MAX_VOXELS) break outer;
			}
		}
		// console.log(voxelMesh2);
		voxelMesh2.count = count;
		voxelMesh2.instanceMatrix.needsUpdate = true;
	} else {
		if (voxelMesh2) {
			voxelMesh2.count = 0;
			voxelMesh2.instanceMatrix.needsUpdate = true;
		}
	}
}

init();
animate();

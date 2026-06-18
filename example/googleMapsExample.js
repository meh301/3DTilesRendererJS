import {
	WGS84_ELLIPSOID,
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
	OBBRegion,
} from "3d-tiles-renderer/plugins";
import {
	Scene,
	WebGLRenderer,
	PerspectiveCamera,
	OrthographicCamera,
	Vector3,
	Box3,
	Matrix4,
} from "three";
import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GUI } from "three/examples/jsm/libs/lil-gui.module.min.js";
import { TopoLinesPlugin } from "./src/plugins/topolines/TopoLinesPlugin.js";
import { Space } from "@spatial-id/javascript-sdk";
import projector from "ecef-projector";
import { VoxelTileManager } from "./src/spatialid/voxelTileManager.js";
import { createVoxelMaterial } from "./src/spatialid/voxelMaterial.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let controls, scene, renderer, tiles, tiles3, tiles4, transition;
let spatialIdTiles = null; // TilesRenderer for spatial ID 3D Tiles
let boundingtilesloaded = false;
let iref, irefRegion;
let sensorGroup;
let voxelManager;

const clippingPlanes = [];
const res = {};

const params = {
	orthographic: false,
	useBatchedMesh: Boolean(
		new URLSearchParams(window.location.hash.replace(/^#/, "")).get("batched")
	),
	displayTopoLines: false,
	errorTarget: 20,
	fov: 60,
	AltitudeOffset: 40,
	ZoomLevel: 28,
	DrawHelpers: false,
	City: "Tokyo",
	enableVoxels: true,
	voxelMaxDistance: 10000,
	voxelZoom: 23,
	voxelUseGPU: true,
	reload: reinstantiateTiles,
};

// ---------------------------------------------------------------------------
// Camera helpers
// ---------------------------------------------------------------------------

function setCameraOver(lat, lng, alt) {
	const pos = new THREE.Vector3(...projector.project(lat, lng, alt));
	const ground = new THREE.Vector3(...projector.project(lat, lng, 0));
	transition.perspectiveCamera.position.copy(pos);
	transition.perspectiveCamera.lookAt(ground);
	transition.perspectiveCamera.rotation.z = (-3 * Math.PI) / 4;
	transition.syncCameras();
	controls.setCamera(transition.camera);
	controls.update();
}

function goToTokyo() {
	// Center on tile 53394568 (Bunkyo ward, where test voxels are)
	setCameraOver(35.7195, 139.7345, 300);
	params.City = "Tokyo";
}
function goToOsaka() {
	setCameraOver(34.64807162801945, 135.38165144335463, 200);
	params.City = "Osaka";
}

window.addEventListener("keyup", (e) => {
	if (e.key === "T" || e.key === "t") goToTokyo();
	if (e.key === "O" || e.key === "o") goToOsaka();
});

// ---------------------------------------------------------------------------
// Spatial ID helpers (for real-time WebSocket sensor data)
// ---------------------------------------------------------------------------

function reorderSpatialId(zxyf) {
	const [z, x, y, f] = zxyf.split("/");
	return `${z}/${f}/${x}/${y}`;
}

function parseSpatialId(str) {
	const parts = str.replace(/^\/+/, "").split("/");
	return { zoom: +parts[0], f: +parts[1], x: +parts[2], y: +parts[3] };
}

function pickByZoom(spatialIds, zoom) {
	const exact = spatialIds.find((si) => si.zoom === zoom);
	if (exact) return exact;
	return spatialIds.reduce((a, b) => (a.zoom > b.zoom ? a : b));
}

// ---------------------------------------------------------------------------
// OBB Clipping (for I-REF geometry cutout)
// ---------------------------------------------------------------------------

function handleOBBClippingChange(box3, matrixWorld) {
	const normals = [
		new THREE.Vector3(-1, 0, 0),
		new THREE.Vector3(1, 0, 0),
		new THREE.Vector3(0, -1, 0),
		new THREE.Vector3(0, 1, 0),
		new THREE.Vector3(0, 0, -1),
		new THREE.Vector3(0, 0, 1),
	];

	const size = new THREE.Vector3();
	box3.getSize(size);
	const rotationMatrix = new THREE.Matrix4().extractRotation(matrixWorld);
	const position = new THREE.Vector3();
	matrixWorld.decompose(position, new THREE.Quaternion(), new THREE.Vector3());

	for (let i = 0; i < normals.length; i++) {
		const normalLocal = normals[i];
		const axis = Math.floor(i / 2);
		const halfExtent = size.getComponent(axis) / 2;
		const facePointLoc = new THREE.Vector3().copy(normalLocal).multiplyScalar(halfExtent);
		const normalWorld = normalLocal.clone().applyMatrix4(rotationMatrix).normalize();
		const facePointWorld = facePointLoc.clone().applyMatrix4(rotationMatrix).add(position);
		const constant = -facePointWorld.dot(normalWorld);
		clippingPlanes.push(new THREE.Plane(normalWorld, constant));
	}
}

// ---------------------------------------------------------------------------
// Tile setup
// ---------------------------------------------------------------------------

function reinstantiateTiles() {
	if (tiles) { scene.remove(tiles.group); tiles.dispose(); tiles = null; }
	if (tiles3) { scene.remove(tiles3.group); tiles3.dispose(); tiles3 = null; }
	if (tiles4) { scene.remove(tiles4.group); tiles4.dispose(); tiles4 = null; }

	// I-REF 2018 building model
	tiles4 = new TilesRenderer("./datasets/I-REF_2018/tileset.json");
	tiles4.registerPlugin(new TileCompressionPlugin());
	tiles4.registerPlugin(new UpdateOnChangePlugin());
	tiles4.registerPlugin(new UnloadTilesPlugin());
	scene.add(tiles4.group);

	tiles4.addEventListener("load-model", (e) => {
		e.scene.traverse((child) => {
			if (!child.isMesh) return;
			const hue = Math.random();
			const sat = 0.25 + Math.random() * 0.25;
			const lum = 0.15 + Math.random() * 0.25;
			child.material = new THREE.MeshBasicMaterial({
				color: new THREE.Color().setHSL(hue, sat, lum),
				transparent: true, opacity: 0.3,
				side: THREE.DoubleSide,
				polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
			});
			child.material.needsUpdate = true;
			const wireGeo = new THREE.WireframeGeometry(child.geometry);
			const wireMat = new THREE.LineBasicMaterial({ color: child.material.color, linewidth: 1 });
			const wireframe = new THREE.LineSegments(wireGeo, wireMat);
			wireframe.position.copy(child.position);
			wireframe.rotation.copy(child.rotation);
			wireframe.scale.copy(child.scale);
			wireframe.renderOrder = 1;
			wireframe.raycast = () => {};
			child.parent.add(wireframe);
		});
	});

	// Geometry cutout (for OBB clipping)
	tiles3 = new TilesRenderer("./datasets/geometrycutout/tileset.json");
	tiles3.registerPlugin(new TileCompressionPlugin());
	tiles3.registerPlugin(new UpdateOnChangePlugin());
	tiles3.registerPlugin(new UnloadTilesPlugin());
	tiles3.registerPlugin(new TilesFadePlugin());
	scene.add(tiles3.group);

	tiles3.addEventListener("load-model", () => {
		boundingtilesloaded = true;
		const boxMat = new THREE.Matrix4();
		if (!tiles3.getOrientedBoundingBox(iref, boxMat)) return;
		iref.max.set(iref.max.x + 2, iref.max.y + 2, iref.max.z + 2);
		handleOBBClippingChange(iref, boxMat);
		if (tiles3) { scene.remove(tiles3.group); tiles3.dispose(); tiles3 = null; }
	});

	// Google Photorealistic 3D Tiles
	tiles = new TilesRenderer();
	tiles.registerPlugin(new CesiumIonAuthPlugin({
		apiToken: import.meta.env.VITE_ION_KEY,
		assetId: "2275207",
		autoRefreshToken: true,
	}));
	tiles.registerPlugin(new TileCompressionPlugin());
	tiles.registerPlugin(new UpdateOnChangePlugin());
	tiles.registerPlugin(new UnloadTilesPlugin());
	tiles.registerPlugin(new TilesFadePlugin());
	tiles.registerPlugin(new TopoLinesPlugin({ projection: "ellipsoid" }));
	tiles.registerPlugin(new GLTFExtensionsPlugin({
		dracoLoader: new DRACOLoader().setDecoderPath(
			"https://unpkg.com/three@0.153.0/examples/jsm/libs/draco/gltf/"
		),
	}));

	if (params.useBatchedMesh) {
		tiles.registerPlugin(new BatchedTilesPlugin({
			renderer, discardOriginalContent: false, instanceCount: 250,
		}));
	}

	scene.add(tiles.group);

	tiles.addEventListener("load-model", () => {
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

	// Set cameras for all tile renderers
	tiles.setResolutionFromRenderer(transition.camera, renderer);
	tiles.setCamera(transition.camera);
	if (tiles3) {
		tiles3.setResolutionFromRenderer(transition.camera, renderer);
		tiles3.setCamera(transition.camera);
	}
	tiles4.setResolutionFromRenderer(transition.camera, renderer);
	tiles4.setCamera(transition.camera);

	controls.raycaster.layers.set(0);
	controls.setTilesRenderer(tiles);
}

// ---------------------------------------------------------------------------
// Voxel engine setup
// ---------------------------------------------------------------------------

function initSpatialId3DTiles() {
	// Clean up existing
	if (spatialIdTiles) {
		scene.remove(spatialIdTiles.group);
		spatialIdTiles.dispose();
		spatialIdTiles = null;
	}

	spatialIdTiles = new TilesRenderer("./datasets/bunkyo-3dtiles/tileset.json");
	spatialIdTiles.registerPlugin(new TileCompressionPlugin());
	spatialIdTiles.registerPlugin(new UpdateOnChangePlugin());
	spatialIdTiles.registerPlugin(new UnloadTilesPlugin());
	spatialIdTiles.registerPlugin(new TilesFadePlugin());

	// Apply voxel line material to loaded models
	const voxelMat = createVoxelMaterial();
	spatialIdTiles.addEventListener("load-model", (e) => {
		e.scene.traverse((child) => {
			if (!child.isMesh) return;
			child.material = voxelMat;
			child.material.needsUpdate = true;
		});
		console.log("[SpatialID] Applied voxel material to loaded model");
	});

	scene.add(spatialIdTiles.group);

	spatialIdTiles.setResolutionFromRenderer(transition.camera, renderer);
	spatialIdTiles.setCamera(transition.camera);

	console.log("[SpatialID] 3D Tiles renderer initialized");
}

async function initVoxelEngine() {
	// Dispose any existing voxel manager and clean up orphaned groups
	if (window.__voxelManager) {
		window.__voxelManager.dispose();
		window.__voxelManager = null;
	}
	// Also remove any orphaned voxelGroup children from tiles.group (from previous HMR runs)
	for (let i = tiles.group.children.length - 1; i >= 0; i--) {
		const child = tiles.group.children[i];
		if (child.name === "voxelGroup") {
			while (child.children.length > 0) {
				const m = child.children[0];
				child.remove(m);
				if (m.geometry) m.geometry.dispose();
			}
			tiles.group.remove(child);
		}
	}

	// Load manifest
	const resp = await fetch("./datasets/spatialid/manifest.json");
	const manifest = await resp.json();

	const loadingBar = document.getElementById("loading-bar");
	const loadingText = document.getElementById("loading-text");
	const loadingFill = document.getElementById("loading-fill");
	let hideTimeout = null;

	voxelManager = new VoxelTileManager(tiles.group, {
		baseUrl: "./datasets/spatialid/",
		manifest: manifest.tiles,
		maxDistance: params.voxelMaxDistance,
		altitudeOffset: params.AltitudeOffset,
		displayZoom: params.voxelZoom,
		useGPU: params.voxelUseGPU,
		onProgress: (text, progress) => {
			loadingBar.style.display = "block";
			loadingText.textContent = text;
			loadingFill.style.width = `${Math.round(progress * 100)}%`;
			clearTimeout(hideTimeout);
			if (progress >= 1.0) {
				hideTimeout = setTimeout(() => { loadingBar.style.display = "none"; }, 2000);
			}
		},
	});
	window.__voxelManager = voxelManager;
	console.log('[APP] voxelManager assigned to window, id:', voxelManager._id = Math.random().toString(36).slice(2, 8));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
	renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
	renderer.setClearColor(0x000000);
	renderer.localClippingEnabled = true;
	document.body.appendChild(renderer.domElement);

	scene = new Scene();
	transition = new CameraTransitionManager(
		new PerspectiveCamera(params.fov, window.innerWidth / window.innerHeight, 0.1, 160000000),
		new OrthographicCamera(-1, 1, 1, -1, 1, 160000000)
	);

	transition.autoSync = false;
	transition.addEventListener("camera-change", ({ camera, prevCamera }) => {
		tiles.deleteCamera(prevCamera);
		tiles.setCamera(camera);
		controls.setCamera(camera);
	});

	controls = new GlobeControls(scene, transition.camera, renderer.domElement, null);
	controls.enableDamping = true;
	controls.adjustHeight = false;
	controls.cameraRadius = 0;
	controls.minDistance = -5;
	controls.maxDistance = Infinity;
	controls.minZoom = 0.0000001;
	controls.maxZoom = 9999.0;

	goToTokyo();
	iref = new THREE.Box3();
	irefRegion = new OBBRegion();

	// WebSocket sensor group (for real-time spatial ID data)
	sensorGroup = new THREE.Group();
	scene.add(sensorGroup);

	// WebSocket handling (real-time sensor data from Node-RED)
	const socket = new WebSocket("wss://nodered.tlab.cloud/osaka");
	socket.onmessage = async (evt) => {
		for (let i = sensorGroup.children.length - 1; i >= 0; i--) {
			const c = sensorGroup.children[i];
			c.geometry?.dispose();
			c.material?.dispose();
			sensorGroup.remove(c);
		}
		let objs;
		try { objs = JSON.parse(evt.data); } catch { return; }

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
				wireframe: false, depthTest: true,
			});
			const center = corners[0].clone()
				.add(eastEdge.clone().multiplyScalar(countX / 2))
				.add(southEdge.clone().multiplyScalar(countY / 2))
				.add(upEdge.clone().multiplyScalar(countZ / 2));
			const mesh = new THREE.Mesh(geom, mat);
			mesh.applyMatrix4(mBasis);
			mesh.position.copy(center);
			sensorGroup.add(mesh);

			if (params.DrawHelpers) {
				const axes = new THREE.AxesHelper(5000);
				axes.applyMatrix4(mBasis);
				axes.position.copy(center);
				sensorGroup.add(axes);
			}

			const canvas = document.createElement("canvas");
			canvas.width = 720; canvas.height = 256;
			const ctx = canvas.getContext("2d");
			ctx.font = "24px Arial"; ctx.textAlign = "center"; ctx.fillStyle = "black";
			ctx.fillText("Min: " + top.min_corner, canvas.width / 2, 60);
			ctx.fillText("Max: " + top.max_corner, canvas.width / 2, 140);
			ctx.fillText(`${obj.name} ${obj.confidence}`, canvas.width / 2, 220);
			const tex = new THREE.CanvasTexture(canvas);
			tex.needsUpdate = true;
			const spriteMat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
			const sprite = new THREE.Sprite(spriteMat);
			const horiz = Math.max(size.x, size.y) * 5;
			sprite.scale.set(horiz, horiz * (canvas.height / canvas.width), 1);
			sprite.position.copy(center);
			sensorGroup.add(sprite);
		}
	};

	reinstantiateTiles();

	// Initialize spatial ID 3D Tiles (pre-processed, instant loading)
	initSpatialId3DTiles();

	// Legacy voxel engine (CSV-based, disabled by default now)
	// initVoxelEngine();

	// Debug access
	window._debug = { get tiles() { return tiles; }, get voxelManager() { return voxelManager; }, get scene() { return scene; }, setCameraOver };

	window.addEventListener("resize", onWindowResize);
	onWindowResize();

	// --- GUI ---
	const gui = new GUI();
	gui.width = 300;
	gui.add(params, "orthographic").onChange(() => {
		controls.getPivotPoint(transition.fixedPoint);
		if (!transition.animating) {
			transition.syncCameras();
			controls.adjustCamera(transition.perspectiveCamera);
			controls.adjustCamera(transition.orthographicCamera);
		}
		transition.toggle();
	});
	gui.add(params, "fov", 40, 90, 1).onChange(() => {
		transition.perspectiveCamera.fov = params.fov;
		transition.perspectiveCamera.updateProjectionMatrix();
	});

	const mapsOptions = gui.addFolder("Google Photorealistic Tiles");
	mapsOptions.add(params, "useBatchedMesh").listen();
	mapsOptions.add(params, "reload");

	const voxelOptions = gui.addFolder("Spatial ID Voxels");
	voxelOptions.add(params, "enableVoxels").name("Enable").onChange((v) => {
		if (voxelManager) voxelManager.enabled = v;
	});
	voxelOptions.add(params, "voxelZoom", 20, 25, 1).name("Zoom Level").onChange((v) => {
		if (window.__voxelManager) window.__voxelManager.setDisplayZoom(v);
	});
	voxelOptions.add(params, "voxelMaxDistance", 1000, 20000, 500).name("Max Distance (m)").onChange((v) => {
		if (window.__voxelManager) window.__voxelManager.maxDistance = v;
	});
	voxelOptions.add(params, "voxelUseGPU").name("WebGPU Mesher").onChange((v) => {
		if (window.__voxelManager) window.__voxelManager.useGPU = v;
	});
	voxelOptions.add({ clearCache: async () => {
		if (window.__voxelManager) { await window.__voxelManager.clearAll(); console.log("[VoxelEngine] Cache cleared"); }
	}}, "clearCache").name("Clear Cache");

	const exampleOptions = gui.addFolder("Options");
	exampleOptions.add(params, "displayTopoLines").listen();
	exampleOptions.add(params, "errorTarget", 5, 100, 1).onChange(() => {
		tiles.getPluginByName("UPDATE_ON_CHANGE_PLUGIN").needsUpdate = true;
	});
	exampleOptions.add(params, "AltitudeOffset", 0, 100, 0.1);
	exampleOptions.add(params, "ZoomLevel", 25, 28, 1);
	exampleOptions.add(params, "DrawHelpers");

	gui.add(params, "City", ["Tokyo", "Osaka"]).name("Jump to").onChange((v) => {
		if (v === "Tokyo") goToTokyo(); else goToOsaka();
	});

	gui.close();
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

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------

function animate() {
	requestAnimationFrame(animate);
	if (!tiles) return;

	controls.enabled = !transition.animating;
	controls.update();
	transition.update();
	const camera = transition.camera;

	// Update tile renderers
	tiles.setResolutionFromRenderer(camera, renderer);
	tiles.setCamera(camera);
	if (tiles3) {
		tiles3.setResolutionFromRenderer(camera, renderer);
		tiles3.setCamera(camera);
		tiles3.errorTarget = params.errorTarget;
		tiles3.update();
	}
	tiles4.setResolutionFromRenderer(camera, renderer);
	tiles4.setCamera(camera);

	const plugin = tiles.getPluginByName("TOPO_LINES_PLUGIN");
	plugin.topoOpacity = params.displayTopoLines ? 0.5 : 0;
	plugin.cartoOpacity = params.displayTopoLines ? 0.5 : 0;
	camera.updateMatrixWorld();
	tiles.errorTarget = params.errorTarget;
	tiles.update();
	tiles4.errorTarget = params.errorTarget;
	tiles4.update();

	// Update spatial ID 3D Tiles
	if (spatialIdTiles) {
		spatialIdTiles.setResolutionFromRenderer(camera, renderer);
		spatialIdTiles.setCamera(camera);
		spatialIdTiles.errorTarget = params.errorTarget;
		spatialIdTiles.update();
	}

	// Legacy voxel engine (disabled)
	// const vm = window.__voxelManager;
	// if (vm) {
	// 	const invMat = tiles.group.matrixWorld.clone().invert();
	// 	vm.update(camera, invMat);
	// }

	renderer.render(scene, camera);

	// Update footer credits
	if (tiles) {
		const mat = tiles.group.matrixWorld.clone().invert();
		const vec = camera.position.clone().applyMatrix4(mat);
		WGS84_ELLIPSOID.getPositionToCartographic(vec, res);
		const attributions = tiles.getAttributions()[0]?.value || "";
		document.getElementById("credits").innerText =
			GeoUtils.toLatLonString(res.lat, res.lon, true) + "\n" + attributions;
	}
}

init();
animate();

// Disable Vite HMR for this module — full page reload on changes
if (import.meta.hot) {
	import.meta.hot.decline();
}

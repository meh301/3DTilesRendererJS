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
} from "3d-tiles-renderer/plugins";
import {
	Scene,
	WebGLRenderer,
	PerspectiveCamera,
	MathUtils,
	OrthographicCamera,
} from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GUI } from "three/examples/jsm/libs/lil-gui.module.min.js";
import Stats from "three/examples/jsm/libs/stats.module.js";
import { TopoLinesPlugin } from "./src/plugins/topolines/TopoLinesPlugin.js";
import { Space } from "@spatial-id/javascript-sdk";
import * as THREE from "three";

let controls, scene, renderer, tiles, transition;
let statsContainer, stats;

const params = {
	orthographic: false,

	enableCacheDisplay: false,
	enableRendererStats: false,
	useBatchedMesh: Boolean(
		new URLSearchParams(window.location.hash.replace(/^#/, "")).get("batched")
	),
	displayTopoLines: false,
	errorTarget: 20,

	reload: reinstantiateTiles,
};

init();
animate();

function reinstantiateTiles() {
	if (tiles) {
		scene.remove(tiles.group);
		tiles.dispose();
		tiles = null;
	}

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
	tiles.registerPlugin(new TopoLinesPlugin({ projection: "ellipsoid" }));
	tiles.registerPlugin(
		new GLTFExtensionsPlugin({
			// Note the DRACO compression files need to be supplied via an explicit source.
			// We use unpkg here but in practice should be provided by the application.
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

	tiles.group.rotation.x = -Math.PI / 2;
	scene.add(tiles.group);

	tiles.setResolutionFromRenderer(transition.camera, renderer);
	tiles.setCamera(transition.camera);

	controls.setTilesRenderer(tiles);
}

async function parseSpatialCSV(url) {
	const raw = await fetch(url).then((r) => r.text());
	const lines = raw.trim().split("\n").slice(2); // Skip headers

	const spatialIDs = lines.map((line) => {
		const parts = line.split(",");
		return parts[1].trim(); // Get the spatial ID (second column)
	});

	return spatialIDs;
}

async function drawSpatialIDBounds(url, maxCount = 1500) {
	const ids = await parseSpatialCSV(url);
	const allPoints = [];

	const limitedIds = ids.slice(0, maxCount);

	for (const id of limitedIds) {
		let space;
		try {
			space = new Space(id); // may throw if invalid
		} catch (e) {
			console.warn("Skipping invalid Spatial ID:", id, e);
			continue;
		}

		const rawCorners = space.vertices3d();
		if (!rawCorners || rawCorners.length !== 8) continue;

		const vectors = rawCorners.map(([lng, lat, alt]) => {
			const vec = new THREE.Vector3();
			WGS84_ELLIPSOID.getCartographicToPosition(
				lat * MathUtils.DEG2RAD,
				lng * MathUtils.DEG2RAD,
				alt + 36,
				vec
			);
			vec.applyMatrix4(tiles.group.matrixWorld);
			allPoints.push(vec);
			return vec;
		});

		drawWireBox(vectors);
	}

	// Focus camera
	// if (allPoints.length > 0) {
	// 	const box = new THREE.Box3().setFromPoints(allPoints);
	// 	const center = new THREE.Vector3();
	// 	box.getCenter(center);

	// 	const size = new THREE.Vector3();
	// 	box.getSize(size);
	// 	const maxDim = Math.max(size.x, size.y, size.z);
	// 	const offset = maxDim * 2;

	// 	const camPos = center
	// 		.clone()
	// 		.add(new THREE.Vector3(offset, offset, offset));
	// 	transition.perspectiveCamera.position.copy(camPos);
	// 	transition.perspectiveCamera.lookAt(center);
	// 	transition.autoSync = false;
	// }
}

function drawWireBox(corners) {
	const indices = [
		[0, 1],
		[1, 3],
		[3, 2],
		[2, 0], // bottom
		[4, 5],
		[5, 7],
		[7, 6],
		[6, 4], // top
		[0, 4],
		[1, 5],
		[2, 6],
		[3, 7], // sides
	];

	const geometry = new THREE.BufferGeometry();
	const positions = [];

	for (const [a, b] of indices) {
		positions.push(corners[a].x, corners[a].y, corners[a].z);
		positions.push(corners[b].x, corners[b].y, corners[b].z);
	}

	geometry.setAttribute(
		"position",
		new THREE.Float32BufferAttribute(positions, 3)
	);
	const material = new THREE.LineBasicMaterial({ color: 0xff00ff });
	const lines = new THREE.LineSegments(geometry, material);
	scene.add(lines);
}

function init() {
	// renderer
	renderer = new WebGLRenderer({ antialias: true });
	renderer.setClearColor(0x151c1f);
	document.body.appendChild(renderer.domElement);

	// scene
	scene = new Scene();

	// camera and transition set up
	transition = new CameraTransitionManager(
		new PerspectiveCamera(
			60,
			window.innerWidth / window.innerHeight,
			1,
			160000000
		),
		new OrthographicCamera(-1, 1, 1, -1, 1, 160000000)
	);
	transition.perspectiveCamera.position.set(4800000, 2570000, 14720000);
	transition.perspectiveCamera.lookAt(0, 0, 0);
	transition.autoSync = false;

	transition.addEventListener("camera-change", ({ camera, prevCamera }) => {
		tiles.deleteCamera(prevCamera);
		tiles.setCamera(camera);
		controls.setCamera(camera);
	});

	// disable adjusting the orthographic camera position for zoom since globe controls will do this
	transition.orthographicPositionalZoom = false;

	// controls
	controls = new GlobeControls(
		scene,
		transition.camera,
		renderer.domElement,
		null
	);
	controls.enableDamping = true;

	// initialize tiles
	reinstantiateTiles();

	onWindowResize();
	window.addEventListener("resize", onWindowResize, false);
	window.addEventListener("hashchange", initFromHash);

	//SpatialID
	drawSpatialIDBounds(
		"https://s3.ap-northeast-1.wasabisys.com/filesharekenchitarujp/SpatialID/bunkyo/udx/bldg/spatialid/53394680_bldg_6697_op.csv"
	);

	// GUI
	const gui = new GUI();
	gui.width = 300;

	gui.add(params, "orthographic").onChange((v) => {
		controls.getPivotPoint(transition.fixedPoint);

		// don't update the cameras if they are already being animated
		if (!transition.animating) {
			// sync the camera positions and then adjust the camera views
			transition.syncCameras();
			controls.adjustCamera(transition.perspectiveCamera);
			controls.adjustCamera(transition.orthographicCamera);
		}

		transition.toggle();
	});

	const mapsOptions = gui.addFolder("Google Photorealistic Tiles");
	mapsOptions.add(params, "useBatchedMesh").listen();
	mapsOptions.add(params, "reload");

	const exampleOptions = gui.addFolder("Example Options");
	exampleOptions.add(params, "displayTopoLines").listen();
	exampleOptions.add(params, "enableCacheDisplay");
	exampleOptions.add(params, "enableRendererStats");
	exampleOptions.add(params, "errorTarget", 5, 100, 1).onChange(() => {
		tiles.getPluginByName("UPDATE_ON_CHANGE_PLUGIN").needsUpdate = true;
	});

	statsContainer = document.createElement("div");
	document.getElementById("info").appendChild(statsContainer);

	// Stats
	stats = new Stats();
	stats.showPanel(0);
	document.body.appendChild(stats.dom);

	// run hash functions
	initFromHash();
	setInterval(updateHash, 100);
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

function updateHash() {
	if (!tiles) {
		return;
	}

	const camera = transition.camera;
	const cartographicResult = {};
	const orientationResult = {};
	const tilesMatInv = tiles.group.matrixWorld.clone().invert();
	const localCameraPos = camera.position.clone().applyMatrix4(tilesMatInv);
	const localCameraMat = camera.matrixWorld.clone().premultiply(tilesMatInv);

	// get the data
	WGS84_ELLIPSOID.getPositionToCartographic(localCameraPos, cartographicResult);
	WGS84_ELLIPSOID.getAzElRollFromRotationMatrix(
		cartographicResult.lat,
		cartographicResult.lon,
		localCameraMat,
		orientationResult,
		CAMERA_FRAME
	);

	// convert to DEG
	orientationResult.azimuth *= MathUtils.RAD2DEG;
	orientationResult.elevation *= MathUtils.RAD2DEG;
	orientationResult.roll *= MathUtils.RAD2DEG;
	cartographicResult.lat *= MathUtils.RAD2DEG;
	cartographicResult.lon *= MathUtils.RAD2DEG;

	// update hash
	const urlParams = new URLSearchParams();
	urlParams.set("lat", cartographicResult.lat.toFixed(4));
	urlParams.set("lon", cartographicResult.lon.toFixed(4));
	urlParams.set("height", cartographicResult.height.toFixed(2));
	urlParams.set("az", orientationResult.azimuth.toFixed(2));
	urlParams.set("el", orientationResult.elevation.toFixed(2));
	urlParams.set("roll", orientationResult.roll.toFixed(2));

	if (params.useBatchedMesh) {
		urlParams.set("batched", 1);
	}
	window.history.replaceState(undefined, undefined, `#${urlParams}`);
}

function initFromHash() {
	const hash = window.location.hash.replace(/^#/, "");
	const urlParams = new URLSearchParams(hash);
	if (urlParams.has("batched")) {
		params.useBatchedMesh = Boolean(urlParams.get("batched"));
	}

	if (!urlParams.has("lat") && !urlParams.has("lon")) {
		return;
	}

	// update the tiles matrix world so we can use it
	tiles.group.updateMatrixWorld();

	// get the position fields
	const camera = transition.camera;
	const lat = parseFloat(urlParams.get("lat"));
	const lon = parseFloat(urlParams.get("lon"));
	const height = parseFloat(urlParams.get("height")) || 1000;

	if (urlParams.has("az") && urlParams.has("el")) {
		// get the az el fields for rotation if present
		const az = parseFloat(urlParams.get("az"));
		const el = parseFloat(urlParams.get("el"));
		const roll = parseFloat(urlParams.get("roll")) || 0;

		// extract the east-north-up frame into matrix world
		WGS84_ELLIPSOID.getRotationMatrixFromAzElRoll(
			lat * MathUtils.DEG2RAD,
			lon * MathUtils.DEG2RAD,
			az * MathUtils.DEG2RAD,
			el * MathUtils.DEG2RAD,
			roll * MathUtils.DEG2RAD,
			camera.matrixWorld,
			CAMERA_FRAME
		);

		// apply the necessary tiles transform
		camera.matrixWorld.premultiply(tiles.group.matrixWorld);
		camera.matrixWorld.decompose(
			camera.position,
			camera.quaternion,
			camera.scale
		);

		// get the height
		WGS84_ELLIPSOID.getCartographicToPosition(
			lat * MathUtils.DEG2RAD,
			lon * MathUtils.DEG2RAD,
			height,
			camera.position
		);
		camera.position.applyMatrix4(tiles.group.matrixWorld);
	} else {
		// default to looking down if no az el are present
		WGS84_ELLIPSOID.getCartographicToPosition(
			lat * MathUtils.DEG2RAD,
			lon * MathUtils.DEG2RAD,
			height,
			camera.position
		);
		camera.position.applyMatrix4(tiles.group.matrixWorld);
		camera.lookAt(0, 0, 0);
	}
}

function animate() {
	requestAnimationFrame(animate);

	if (!tiles) return;

	controls.enabled = !transition.animating;
	controls.update();
	transition.update();

	// update options
	const camera = transition.camera;
	tiles.setResolutionFromRenderer(camera, renderer);
	tiles.setCamera(camera);

	const plugin = tiles.getPluginByName("TOPO_LINES_PLUGIN");
	plugin.topoOpacity = params.displayTopoLines ? 0.5 : 0;
	plugin.cartoOpacity = params.displayTopoLines ? 0.5 : 0;

	// update tiles
	camera.updateMatrixWorld();
	tiles.errorTarget = params.errorTarget;
	tiles.update();

	renderer.render(scene, camera);
	stats.update();

	updateHtml();
}

function updateHtml() {
	// render html text updates
	let str = "";

	if (params.enableCacheDisplay) {
		const lruCache = tiles.lruCache;
		const cacheFullness = lruCache.cachedBytes / lruCache.maxBytesSize;
		str += `Downloading: ${tiles.stats.downloading} Parsing: ${tiles.stats.parsing} Visible: ${tiles.visibleTiles.size}<br/>`;
		str += `Cache: ${(100 * cacheFullness).toFixed(2)}% ~${(
			lruCache.cachedBytes /
			1000 /
			1000
		).toFixed(2)}mb<br/>`;
	}

	if (params.enableRendererStats) {
		const memory = renderer.info.memory;
		const render = renderer.info.render;
		const programCount = renderer.info.programs.length;
		str += `Geometries: ${memory.geometries} Textures: ${memory.textures} Programs: ${programCount} Draw Calls: ${render.calls}`;

		const batchPlugin = tiles.getPluginByName("BATCHED_TILES_PLUGIN");
		const fadePlugin = tiles.getPluginByName("FADE_TILES_PLUGIN");
		if (batchPlugin) {
			let tot = 0;
			batchPlugin.batchedMesh?._instanceInfo.forEach((info) => {
				if (info.visible && info.active) tot++;
			});

			fadePlugin.batchedMesh?._instanceInfo.forEach((info) => {
				if (info.visible && info.active) tot++;
			});

			str += ", Batched: " + tot;
		}
	}

	if (statsContainer.innerHTML !== str) {
		statsContainer.innerHTML = str;
	}

	const mat = tiles.group.matrixWorld.clone().invert();
	const vec = transition.camera.position.clone().applyMatrix4(mat);

	const res = {};
	WGS84_ELLIPSOID.getPositionToCartographic(vec, res);

	const attributions = tiles.getAttributions()[0]?.value || "";
	document.getElementById("credits").innerText =
		GeoUtils.toLatLonString(res.lat, res.lon) + "\n" + attributions;
}

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
} from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GUI } from "three/examples/jsm/libs/lil-gui.module.min.js";
import Stats from "three/examples/jsm/libs/stats.module.js";
import { TopoLinesPlugin } from "./src/plugins/topolines/TopoLinesPlugin.js";
import * as THREE from "three";
import { Space } from "@spatial-id/javascript-sdk";
import projector from "ecef-projector";
// import proj4 from "proj4";

let controls, scene, renderer, tiles, tiles2, tiles3, tiles4, transition;
let statsContainer, stats;
let boxRegion;
let boundingtilesloaded = false;
let iref, irefRegion, osakaexpo;
let helper;
let fov;
let sensorGroup;
const clippingPlanes = [];

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
	AltitudeOffset: 300,
	ZoomLevel: 25,
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

function pickByZoom(spatialIds, zoom) {
	// try exact match first
	const exact = spatialIds.find((si) => si.zoom === zoom);
	if (exact) return exact;

	// otherwise fall back to the highest‐zoom entry
	return spatialIds.reduce((a, b) => (a.zoom > b.zoom ? a : b));
}

// /**
//  * Build a properly oriented ECEF box from two SpatialID strings.
//  *
//  * @param {string} minId  Z/F/X/Y of the “lower‐southwest‐bottom” corner
//  * @param {string} maxId  Z/F/X/Y of the “upper‐northeast‐top” corner
//  * @param {number} color  THREE.Color or hex
//  * @returns {THREE.Mesh}
//  */
// function makeBoxFromSpatialIDs(minId, maxId, color) {
// 	// 1) parse + reorder if necessary
// 	minId = reorderSpatialId(minId);
// 	maxId = reorderSpatialId(maxId);

// 	// 2) build Space objects
// 	const smin = new Space(minId);
// 	const smax = new Space(maxId);

// 	// 3) grab their 8 geodetic corners
// 	const verts = smin.vertices3d().concat(smax.vertices3d());

// 	// 4) project to ECEF Vector3
// 	const pts = verts.map((v) => {
// 		const [lng, lat, alt] = Array.isArray(v) ? v : [v.lng, v.lat, v.alt];
// 		return new THREE.Vector3(
// 			...projector.project(lat, lng, alt + params.AltitudeOffset)
// 		);
// 	});

// 	// 5) find the true min/max in ECEF
// 	const minE = pts.reduce(
// 		(m, p) => m.min(p),
// 		new THREE.Vector3(Infinity, Infinity, Infinity)
// 	);
// 	const maxE = pts.reduce(
// 		(m, p) => m.max(p),
// 		new THREE.Vector3(-Infinity, -Infinity, -Infinity)
// 	);

// 	// 6) size + center
// 	const size = new THREE.Vector3().subVectors(maxE, minE);
// 	const center = new THREE.Vector3().addVectors(maxE, minE).multiplyScalar(0.5);

// 	// 7) build the box mesh (axis‐aligned in ECEF)
// 	const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
// 	const mat = new THREE.MeshBasicMaterial({
// 		color,
// 		wireframe: false,
// 		depthTest: true,
// 	});
// 	const mesh = new THREE.Mesh(geo, mat);
// 	mesh.position.copy(center);

// 	const axesHelper = new THREE.AxesHelper(5000);
// 	axesHelper.position.copy(center);
// 	scene.add(axesHelper);

// 	return mesh;
// }

// // geodetic WGS84
// proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");
// // geocentric (ECEF) WGS84
// proj4.defs("EPSG:4978", "+proj=geocent +datum=WGS84 +units=m +no_defs");

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

	tiles4 = new TilesRenderer("./datasets/I-REF_2018/tileset.json");
	tiles4.registerPlugin(new TileCompressionPlugin());
	tiles4.registerPlugin(new UpdateOnChangePlugin());
	tiles4.registerPlugin(new UnloadTilesPlugin());
	// tiles4.registerPlugin(
	// 	new DebugTilesPlugin({
	// 		enabled: true,
	// 		colorMode: 7,
	// 		displayBoxBounds: true,
	// 		displayRegionBounds: true,
	// 	})
	// );
	// tiles4.registerPlugin(new TilesFadePlugin());
	// tiles4.registerPlugin(
	// 	new GLTFExtensionsPlugin({
	// 		dracoLoader: new DRACOLoader().setDecoderPath(
	// 			"https://unpkg.com/three@0.153.0/examples/jsm/libs/draco/gltf/"
	// 		),
	// 		rtc: true,
	// 		metadata: true,
	// 		ktxLoader: new KTX2Loader()
	// 			.setTranscoderPath(
	// 				"https://unpkg.com/three@0.177.0/examples/jsm/libs/basis/"
	// 			)
	// 			.detectSupport(renderer),
	// 	})
	// );

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
		// if (boundingtilesloaded) {
		// 	boundingtilesloaded = false;
		// 	let plugin = tiles.getPluginByName("LOAD_REGION_PLUGIN");
		// 	plugin.addRegion(irefRegion);
		// 	let boundingboxmatrix = new Matrix4();
		// 	if (tiles3.getOrientedBoundingBox(iref, boundingboxmatrix)) {
		// 			irefRegion.errorTarget = params.errorTarget;
		// 			irefRegion.obb.box.copy(iref);
		// 			irefRegion.obb.transform.copy(boundingboxmatrix);
		// 			irefRegion.obb.update();

		// 			scene.remove(tiles3.group);
		// 			tiles3.dispose();
		// 			tiles3 = null;
		// 	} else {
		// 		console.log("failed to filter tile region");
		// 	}
		// }

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

	// tiles.addEventListener("load-model", (e) => {
	// 	if (!boundingtilesloaded) return;
	// 	boundingtilesloaded = false;

	// 	const boxMat = new THREE.Matrix4();
	// 	if (!tiles3.getOrientedBoundingBox(iref, boxMat)) return;

	// 	// 2) get a THREE.Box3 from your iref
	// 	const box3 = new THREE.Box3().copy(iref);

	// 	// 3) build exactly four vertical planes
	// 	const clippingPlanes = buildVerticalOBBPlanes(box3, boxMat);

	// 	// 4) (optional) debug helpers at roughly your box size
	// 	const diag = box3.getSize(new THREE.Vector3()).length();
	// 	const helperGroup = new THREE.Group();
	// 	clippingPlanes.forEach((pl) => {
	// 		helperGroup.add(new THREE.PlaneHelper(pl, diag, 0xff0000));
	// 	});
	// 	scene.add(helperGroup);

	// 	// 5) apply to each mesh in the loaded tile
	// 	e.scene.traverse((obj) => {
	// 		if (obj.isMesh) {
	// 			obj.material.clippingPlanes = clippingPlanes;
	// 			obj.material.clipIntersection = false; // keeps outside of any vertical wall → cuts a shaft
	// 			obj.material.needsUpdate = true;
	// 		}
	// 	});

	// 	scene.remove(tiles3.group);
	// 	tiles3.dispose();
	// 	tiles3 = null;
	// });

	tiles2 = new TilesRenderer();
	tiles2.registerPlugin(
		new CesiumIonAuthPlugin({
			apiToken: import.meta.env.VITE_ION_KEY,
			assetId: "3435658",
			autoRefreshToken: true,
		})
	);
	tiles2.registerPlugin(new TileCompressionPlugin());
	tiles2.registerPlugin(new UpdateOnChangePlugin());
	tiles2.registerPlugin(new UnloadTilesPlugin());
	tiles2.registerPlugin(new TilesFadePlugin());
	// tiles2.registerPlugin(new LoadRegionPlugin());
	tiles2.addEventListener("load-model", (e) => {
		e.scene.material.size = 2;
		e.scene.material.sizeAttenuation = false;
		e.scene.material.needsUpdate = true;
	});
	// scene.add(tiles2.group);

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

	//websocket handling
	const socket = new WebSocket("wss://nodered.tlab.cloud/osaka");

	socket.onmessage = async (evt) => {
		// 1) clear old boxes…
		for (let i = sensorGroup.children.length - 1; i >= 0; i--) {
			const c = sensorGroup.children[i];
			c.geometry.dispose();
			c.material.dispose();
			sensorGroup.remove(c);
		}

		// 2) parse JSON
		let objs;
		try {
			objs = JSON.parse(evt.data);
		} catch (err) {
			console.error("Bad JSON:", err);
			return;
		}

		const altOffset = params.AltitudeOffset || 0;

		// simple parser: "/z/f/x/y" → { z,f,x,y }
		function parseSpatialId(str) {
			const parts = str.replace(/^\/+/, "").split("/");
			return {
				zoom: +parts[0],
				f: +parts[1],
				x: +parts[2],
				y: +parts[3],
			};
		}

		for (const obj of objs) {
			// unmix any mangled IDs
			for (const si of obj.spatial_ids) {
				si.min_corner = reorderSpatialId(si.min_corner);
				si.max_corner = reorderSpatialId(si.max_corner);
			}

			// pick the requested zoom
			const top = pickByZoom(obj.spatial_ids, params.ZoomLevel);

			// build Spaces
			const spaceMin = new Space(top.min_corner);
			const spaceMax = new Space(top.max_corner);

			// 5) get geodetic corners
			const vertsMin = spaceMin.vertices3d();
			const vertsMax = spaceMax.vertices3d();

			// 6) project → ECEF
			const corners = vertsMin.concat(vertsMax).map((v) => {
				let [lng, lat, alt] = Array.isArray(v) ? v : [v.lng, v.lat, v.alt];
				return new THREE.Vector3(
					...projector.project(lat, lng, alt + altOffset)
				);
			});

			// edges from the *first* corner (NW bottom):
			const eastEdge = new THREE.Vector3().subVectors(corners[3], corners[0]);
			const southEdge = new THREE.Vector3().subVectors(corners[1], corners[0]);
			const upEdge = new THREE.Vector3().subVectors(corners[4], corners[0]);

			// lengths along each axis
			const size = new THREE.Vector3(
				eastEdge.length(),
				southEdge.length(),
				upEdge.length()
			);

			// local → world rotation
			const mBasis = new THREE.Matrix4().makeBasis(
				eastEdge.clone().normalize(),
				southEdge.clone().normalize(),
				upEdge.clone().normalize()
			);

			// parse out integer ranges from your top.min/max
			const minT = parseSpatialId(top.min_corner);
			const maxT = parseSpatialId(top.max_corner);

			const z = minT.zoom;
			const f0 = minT.f,
				f1 = maxT.f;
			const x0 = minT.x,
				x1 = maxT.x;
			const y0 = minT.y,
				y1 = maxT.y;

			// build a single BoxGeometry + Material
			const geom = new THREE.BoxGeometry(size.x, size.y, size.z);
			const mat = new THREE.MeshBasicMaterial({
				color: obj.name === "person" ? 0xff0000 : 0x0000ff,
				wireframe: false,
				depthTest: true,
			});

			// 11) for each voxel in that range, spawn one oriented cube
			for (let f = f0; f <= f1; f++) {
				for (let x = x0; x <= x1; x++) {
					for (let y = y0; y <= y1; y++) {
						const sid = `/${z}/${f}/${x}/${y}`;
						const space = new Space(sid);
						const { lat, lng, alt } = space.center;
						const center = new THREE.Vector3(
							...projector.project(lat, lng, alt + altOffset)
						);

						const box = new THREE.Mesh(geom, mat);
						box.applyMatrix4(mBasis);
						box.position.copy(center);
						sensorGroup.add(box);
						const axesHelper = new THREE.AxesHelper(5000);
						axesHelper.applyMatrix4(mBasis);
						axesHelper.position.copy(center);
						sensorGroup.add(axesHelper);
					}
				}
			}
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
	exampleOptions.add(params, "enableCacheDisplay");
	exampleOptions.add(params, "enableRendererStats");
	exampleOptions.add(params, "errorTarget", 5, 100, 1).onChange(() => {
		tiles.getPluginByName("UPDATE_ON_CHANGE_PLUGIN").needsUpdate = true;
	});
	exampleOptions.add(params, "AltitudeOffset", 0, 1500, 0.1);
	exampleOptions.add(params, "ZoomLevel", 25, 28, 1);

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

	renderer.render(scene, camera);
	stats.update();

	if (tiles) {
		const mat = tiles.group.matrixWorld.clone().invert();
		const vec = camera.position.clone().applyMatrix4(mat);

		const res = {};
		WGS84_ELLIPSOID.getPositionToCartographic(vec, res);

		const attributions = tiles.getAttributions()[0]?.value || "";
		document.getElementById("credits").innerText =
			GeoUtils.toLatLonString(res.lat, res.lon) + "\n" + attributions;
		// console.log(camera.zoom);
	}
}

init();
animate();

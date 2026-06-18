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
	CesiumIonAuthPlugin,
} from "3d-tiles-renderer/plugins";
import {
	Scene,
	Group,
	WebGLRenderer,
	PerspectiveCamera,
	OrthographicCamera,
	Vector3,
	Matrix4,
	Quaternion,
	Color,
	ConeGeometry,
	SphereGeometry,
	MeshBasicMaterial,
	InstancedMesh,
	DynamicDrawUsage,
} from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GUI } from "three/examples/jsm/libs/lil-gui.module.min.js";
import projector from "ecef-projector";
import { GP02Parser, POS_TYPE_RTK, POS_TYPE_FLOAT, POS_TYPE_SINGLE,
	posTypeString, timeQualityString, systemStateString, decodeFaults } from "./src/gp02/binaryParser.js";
import { PoseRingBuffer } from "./src/gp02/poseRingBuffer.js";

// Force full page reload on any code change — HMR creates stale closures
if (import.meta.hot) import.meta.hot.decline();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIX_COLORS = {
	rtk:    new Color(0x00ff00),  // green
	float:  new Color(0xffff00),  // yellow
	single: new Color(0xff3333),  // red
	pdr:    new Color(0xff00ff),  // magenta
};

const CONE_COLOR = new Color(0x00ffff); // cyan

const MAX_TRAIL_POINTS = 20000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let controls, scene, renderer, tiles, transition;
let trailMesh = null;       // Points for trail dots
let coneMesh = null;        // head orientation cone
let latestMarker = null;    // larger point at current pos
let vizGroup = null;        // RTC group — all visualization is a child of this

let socket = null;
const parser = new GP02Parser();
const poseBuffer = new PoseRingBuffer(1800); // 60s * 30Hz

let lastStatus = null; // latest STATUS message

const res = {};

// --- RTC (Relative To Center) positioning ---
// All visualization positions are stored as small offsets from _rtcCenter.
// _rtcCenter is in ECEF float64 (JS number). It's set to the first pose
// and updated when the user moves >500m from it (like the GP-02's sliding NED).
// vizGroup.position is set to _rtcCenter — Three.js model matrix handles the rest.
// Vertex positions in buffers stay small (<500m), preserving float32 precision.
const _rtcCenter = [0, 0, 0]; // ECEF float64
let _rtcInitialized = false;

// Smooth camera snap state
const _snapTarget = new Vector3();  // where we want the controls pivot to be
const _snapCurrent = new Vector3(); // interpolated current pivot
let snapInitialized = false;
const SNAP_LERP_FACTOR = 0.04; // lower = smoother/slower, higher = snappier

const params = {
	wsUrl: "wss://nodered.tlab.cloud/ws/rd/unreal",
	connected: false,
	historySeconds: 60,
	altitudeOffset: 1.5,
	showTrail: true,
	showCone: true,
	snapToTracker: true,
	errorTarget: 20,
	connect: () => wsConnect(),
	disconnect: () => wsDisconnect(),
};

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function wsConnect() {
	if (socket && socket.readyState <= 1) return;
	updateWsHud('connecting');
	try {
		socket = new WebSocket(params.wsUrl);
		socket.binaryType = "arraybuffer";

		socket.onopen = () => {
			params.connected = true;
			updateWsHud('connected');
			parser.reset();
		};

		let _lastHudUpdate = 0;
		socket.onmessage = (evt) => {
			// Debug: log first message to diagnose data format issues
			if (!socket._debugged) {
				socket._debugged = true;
				const d = evt.data;
				if (typeof d === 'string') {
					console.warn('[GP02] WebSocket received TEXT frame (expected binary):', d.substring(0, 100));
				} else if (d instanceof ArrayBuffer) {
					const bytes = new Uint8Array(d);
					const hex = Array.from(bytes.subarray(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ');
					console.log(`[GP02] First binary message: ${d.byteLength} bytes, hex: ${hex}`);
				} else {
					console.warn('[GP02] Unexpected data type:', typeof d, d);
				}
			}

			const messages = parser.feed(evt.data);
			const now = performance.now();
			let lastPose = null;
			for (const msg of messages) {
				if (msg.type === 'pose') {
					handlePose(msg, now);
					lastPose = msg;
				} else if (msg.type === 'raw_gnss') {
					handleRawGnss(msg, now);
				} else if (msg.type === 'status') {
					handleStatus(msg);
				}
			}

			// Throttle HUD updates to ~10Hz (DOM updates are expensive)
			if (lastPose && now - _lastHudUpdate > 100) {
				updatePoseHud(lastPose);
				_lastHudUpdate = now;
			}
		};

		socket.onclose = () => {
			params.connected = false;
			updateWsHud('disconnected');
		};

		socket.onerror = () => {
			params.connected = false;
			updateWsHud('disconnected');
		};
	} catch (e) {
		console.error("WebSocket connection failed:", e);
		updateWsHud('disconnected');
	}
}

function wsDisconnect() {
	if (socket) {
		socket.close();
		socket = null;
	}
	params.connected = false;
	updateWsHud('disconnected');
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

/**
 * Convert absolute ECEF to RTC-local coordinates.
 * Returns [x, y, z] relative to _rtcCenter. Values stay <500m.
 */
function ecefToRtc(ecef) {
	return [
		ecef[0] - _rtcCenter[0],
		ecef[1] - _rtcCenter[1],
		ecef[2] - _rtcCenter[2],
	];
}

/**
 * Initialize or re-center the RTC origin.
 * Invalidates all cached local positions.
 *
 * The vizGroup.matrixWorld is set manually (matrixAutoUpdate=false).
 * We store the ECEF translation in the JS matrix (float64).
 * The onBeforeRender callback on each child computes a double-precision
 * modelViewMatrix = viewMatrix * modelWorld, where the large ECEF values
 * cancel out (camera is also at ~4M ECEF), leaving small residuals
 * that fit in float32.
 */
function setRtcCenter(ecef) {
	_rtcCenter[0] = ecef[0];
	_rtcCenter[1] = ecef[1];
	_rtcCenter[2] = ecef[2];
	_rtcInitialized = true;

	if (vizGroup) {
		// Set position in JS (float64 precision preserved)
		vizGroup.position.set(ecef[0], ecef[1], ecef[2]);
		// Manually compose the world matrix
		vizGroup.updateMatrix();
		vizGroup.matrixWorld.copy(vizGroup.matrix);
		vizGroup.matrixWorldNeedsUpdate = false;
	}

	// Recompute all cached local positions relative to new center
	poseBuffer.forEach(e => {
		if (e._ecef) {
			e._cachedLocal = ecefToRtc(e._ecef);
		}
	});
}

/**
 * Install double-precision modelViewMatrix computation on a mesh.
 * This avoids float32 precision loss when the mesh is at ECEF ~4M from origin.
 *
 * The trick: Three.js computes modelViewMatrix = camera.matrixWorldInverse * object.matrixWorld
 * Both matrices have large ECEF translations that cancel out. In float64 (JS) the cancellation
 * is exact. In float32 (GPU), it's garbage. So we compute it in JS and upload the result.
 */
const _doublePrecisionMV = new Matrix4();

function installRtcRendering(mesh) {
	mesh.onBeforeRender = (renderer, scene, camera) => {
		_doublePrecisionMV.multiplyMatrices(camera.matrixWorldInverse, vizGroup.matrixWorld);
		mesh.modelViewMatrix.copy(_doublePrecisionMV);
	};
}

// Decimate 100Hz input to 30Hz for display.
// Uses local receipt time (performance.now), NOT firmware timestamp
// (which is BigInt nanoseconds exceeding Number.MAX_SAFE_INTEGER).
let _lastPoseLocalTime = 0;
const POSE_MIN_INTERVAL_MS = 33; // 33ms = ~30Hz

function handlePose(msg, localTime) {
	// Decimate FIRST — before any computation
	if (localTime - _lastPoseLocalTime < POSE_MIN_INTERVAL_MS) return;
	_lastPoseLocalTime = localTime;

	// Skip poses with no valid position (no GNSS fix yet)
	if (msg.latitude === 0 && msg.longitude === 0) return;

	const ecef = projector.project(msg.latitude, msg.longitude, msg.altitude_m + params.altitudeOffset);

	if (!_rtcInitialized) {
		setRtcCenter(ecef);
	}

	const dx = ecef[0] - _rtcCenter[0];
	const dy = ecef[1] - _rtcCenter[1];
	const dz = ecef[2] - _rtcCenter[2];
	if (dx * dx + dy * dy + dz * dz > 250000) {
		setRtcCenter(ecef);
	}

	const local = ecefToRtc(ecef);

	poseBuffer.push({
		lat: msg.latitude,
		lon: msg.longitude,
		alt: msg.altitude_m,
		_ecef: ecef,
		_cachedLocal: local,
		qw: msg.quat_w, qx: msg.quat_x, qy: msg.quat_y, qz: msg.quat_z,
		posSource: msg.pos_source,
		gnssType: msg.gnss_pos_type,
		travelHeading: msg.travel_heading,
	});
	markTrailDirty();
}

function handleRawGnss(msg, localTime) {
	const ecef = projector.project(msg.lat, msg.lon, msg.hgt + params.altitudeOffset);

	if (!_rtcInitialized) setRtcCenter(ecef);

	poseBuffer.push({
		lat: msg.lat,
		lon: msg.lon,
		alt: msg.hgt,
		_ecef: ecef,
		_cachedLocal: ecefToRtc(ecef),
		posSource: 0,
		gnssType: msg.pos_type,
		travelHeading: NaN,
	});
	markTrailDirty();
}

function handleStatus(msg) {
	lastStatus = msg;
	updateStatusHud(msg);
}

// ---------------------------------------------------------------------------
// HUD updates
// ---------------------------------------------------------------------------

function updateWsHud(state) {
	const indicator = document.getElementById('ws-indicator');
	const label = document.getElementById('hud-ws');
	indicator.className = `ws-${state}`;
	label.textContent = state.charAt(0).toUpperCase() + state.slice(1);
}

function updatePoseHud(msg) {
	const fixEl = document.getElementById('hud-fix');
	const pt = msg.pos_source === 1 ? 'pdr' :
		msg.gnss_pos_type === POS_TYPE_RTK ? 'rtk' :
		msg.gnss_pos_type === POS_TYPE_FLOAT ? 'float' :
		msg.gnss_pos_type === POS_TYPE_SINGLE ? 'single' : 'none';
	const label = msg.pos_source === 1 ? 'PDR' : posTypeString(msg.gnss_pos_type);
	fixEl.innerHTML = `<span class="fix-${pt}">${label}</span>`;
}

function updateStatusHud(msg) {
	// State
	document.getElementById('hud-state').textContent = systemStateString(msg.state);

	// Time quality
	const tq = msg.time_quality;
	const tqClass = tq === 3 ? 'time-fine' : tq === 2 ? 'time-coarse' : tq === 1 ? 'time-ntp' : 'time-none';
	document.getElementById('hud-time').innerHTML =
		`<span class="${tqClass}">${timeQualityString(tq)}</span>`;

	// IMU calibration
	const cal = msg.bno_accuracy;
	const calClass = `cal-${Math.min(cal, 3)}`;
	document.getElementById('hud-imu').innerHTML =
		`<span class="${calClass}">${cal}/3</span>`;

	// Altitude
	document.getElementById('hud-alt').textContent =
		isFinite(msg.filtered_altitude) ? `${msg.filtered_altitude.toFixed(1)} m` : '---';

	// Vertical velocity
	document.getElementById('hud-vvel').textContent =
		isFinite(msg.vertical_velocity) ? `${msg.vertical_velocity.toFixed(2)} m/s` : '---';

	// PPS
	document.getElementById('hud-pps').textContent = msg.pps_count;

	// Faults
	const faultStr = decodeFaults(msg.faults);
	const faultClass = msg.faults === 0 ? 'fault-ok' : 'fault-warn';
	document.getElementById('hud-faults').innerHTML =
		`<span class="${faultClass}">${faultStr}</span>`;

	// GNSS fix is shown from POSE messages (updatePoseHud), not STATUS.
	// STATUS gnss_fix can lag behind the actual fix type in the POSE stream.
}

// ---------------------------------------------------------------------------
// 3D Tiles setup
// ---------------------------------------------------------------------------

function initTiles() {
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
	tiles.registerPlugin(
		new GLTFExtensionsPlugin({
			dracoLoader: new DRACOLoader().setDecoderPath(
				"https://unpkg.com/three@0.153.0/examples/jsm/libs/draco/gltf/"
			),
		})
	);

	scene.add(tiles.group);

	tiles.setResolutionFromRenderer(transition.camera, renderer);
	tiles.setCamera(transition.camera);
	controls.setTilesRenderer(tiles);
}

// ---------------------------------------------------------------------------
// Visualization meshes
// ---------------------------------------------------------------------------

function initTrailMesh() {
	// InstancedMesh with tiny sphere — same proven pattern as the working cone
	const geo = new SphereGeometry(0.15, 4, 3);
	const mat = new MeshBasicMaterial({ color: 0xffffff });
	trailMesh = new InstancedMesh(geo, mat, MAX_TRAIL_POINTS);
	trailMesh.instanceMatrix.setUsage(DynamicDrawUsage);
	trailMesh.frustumCulled = false;
	trailMesh.count = 0;
	vizGroup.add(trailMesh);
}

function initConeMesh() {
	// ConeGeometry tip points along +Y by default.
	// BNO085 "forward" (identity quaternion) is +X in ENU.
	// Rotate cone so tip points along +X to match sensor forward direction.
	const geo = new ConeGeometry(0.4, 2.0, 8);
	geo.rotateZ(Math.PI / 2);
	const mat = new MeshBasicMaterial({
		color: CONE_COLOR,
		transparent: true,
		opacity: 0.7,
		depthTest: true,
	});
	coneMesh = new InstancedMesh(geo, mat, 1);
	coneMesh.frustumCulled = false;
	coneMesh.count = 0;
	vizGroup.add(coneMesh);
}

function initLatestMarker() {
	const geo = new SphereGeometry(0.35, 6, 4);
	const mat = new MeshBasicMaterial({ color: 0xffffff });
	latestMarker = new InstancedMesh(geo, mat, 1);
	latestMarker.frustumCulled = false;
	latestMarker.count = 0;
	vizGroup.add(latestMarker);
}

// ---------------------------------------------------------------------------
// Trail rendering
// ---------------------------------------------------------------------------

const _tmpMat = new Matrix4();
const _tmpColor = new Color();

function getFixColor(entry) {
	if (entry.posSource === 1) return FIX_COLORS.pdr;
	switch (entry.gnssType) {
		case POS_TYPE_RTK:    return FIX_COLORS.rtk;
		case POS_TYPE_FLOAT:  return FIX_COLORS.float;
		case POS_TYPE_SINGLE: return FIX_COLORS.single;
		default:              return FIX_COLORS.single;
	}
}

let _lastAltOffset = NaN;

function markTrailDirty() { }

function updateTrail() {
	if (!trailMesh || !_rtcInitialized) return;

	const len = poseBuffer.length;
	if (!params.showTrail || len === 0) {
		trailMesh.count = 0;
		return;
	}

	// If alt offset changed, reproject every entry
	if (params.altitudeOffset !== _lastAltOffset) {
		_lastAltOffset = params.altitudeOffset;
		poseBuffer.forEach((e) => {
			e._ecef = projector.project(e.lat, e.lon, e.alt + params.altitudeOffset);
			e._cachedLocal = ecefToRtc(e._ecef);
		});
	}

	let n = 0;
	poseBuffer.forEach((e) => {
		if (n >= MAX_TRAIL_POINTS) return;
		const local = e._cachedLocal;
		if (!local) return;
		_tmpMat.identity().setPosition(local[0], local[1], local[2]);
		trailMesh.setMatrixAt(n, _tmpMat);
		trailMesh.setColorAt(n, getFixColor(e));
		n++;
	});

	trailMesh.count = n;
	trailMesh.instanceMatrix.needsUpdate = true;
	if (trailMesh.instanceColor) trailMesh.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Head orientation cone
// ---------------------------------------------------------------------------

/**
 * Compute ENU-to-ECEF rotation matrix at a given lat/lon.
 * ENU: East-North-Up at the surface point.
 */
// Pre-allocated objects for updateCone — ZERO per-frame allocations
const _enuMat = new Matrix4();
const _enuQuat = new Quaternion();
const _ecefQuat = new Quaternion();
const _coneMat = new Matrix4();
const _conePos = new Vector3();
const _coneScale = new Vector3(1, 1, 1);

function enuToEcefMatrix(latDeg, lonDeg, out) {
	const lat = latDeg * Math.PI / 180;
	const lon = lonDeg * Math.PI / 180;
	const sinLat = Math.sin(lat);
	const cosLat = Math.cos(lat);
	const sinLon = Math.sin(lon);
	const cosLon = Math.cos(lon);
	out.set(
		-sinLon,           -sinLat * cosLon,  cosLat * cosLon,  0,
		cosLon,            -sinLat * sinLon,  cosLat * sinLon,  0,
		0,                 cosLat,            sinLat,           0,
		0,                 0,                 0,                1
	);
}

function updateCone() {
	if (!coneMesh) return;

	const latest = poseBuffer.latest();
	if (!latest || latest.qw === undefined || !params.showCone) {
		coneMesh.count = 0;
		return;
	}

	if (!latest._cachedLocal) {
		if (!latest._ecef) latest._ecef = projector.project(latest.lat, latest.lon, latest.alt + params.altitudeOffset);
		latest._cachedLocal = ecefToRtc(latest._ecef);
	}
	const local = latest._cachedLocal;

	enuToEcefMatrix(latest.lat, latest.lon, _enuMat);
	_enuQuat.set(latest.qx, latest.qy, latest.qz, latest.qw);
	_ecefQuat.setFromRotationMatrix(_enuMat);
	_ecefQuat.multiply(_enuQuat);

	_conePos.set(local[0], local[1], local[2]);
	_coneMat.compose(_conePos, _ecefQuat, _coneScale);

	coneMesh.setMatrixAt(0, _coneMat);
	coneMesh.count = 1;
	coneMesh.instanceMatrix.needsUpdate = true;
}

function updateLatestMarker() {
	if (!latestMarker) return;

	const latest = poseBuffer.latest();
	if (!latest) {
		latestMarker.count = 0;
		return;
	}

	if (!latest._cachedLocal) {
		if (!latest._ecef) latest._ecef = projector.project(latest.lat, latest.lon, latest.alt + params.altitudeOffset);
		latest._cachedLocal = ecefToRtc(latest._ecef);
	}
	const local = latest._cachedLocal;
	_tmpMat.identity().setPosition(local[0], local[1], local[2]);
	latestMarker.setMatrixAt(0, _tmpMat);
	latestMarker.setColorAt(0, getFixColor(latest));
	latestMarker.count = 1;
	latestMarker.instanceMatrix.needsUpdate = true;
	if (latestMarker.instanceColor) latestMarker.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Camera snap-to-tracker (position only, rotation stays free)
// ---------------------------------------------------------------------------

const _prevSnapTarget = new Vector3();
const _snapDelta = new Vector3(); // pre-allocated, no clone()

function snapToTracker() {
	if (!params.snapToTracker) {
		snapInitialized = false;
		return;
	}

	const latest = poseBuffer.latest();
	if (!latest) return;

	// Use absolute ECEF for camera snapping (float64 in JS, precision OK for camera)
	if (!latest._ecef) {
		latest._ecef = projector.project(latest.lat, latest.lon, latest.alt + params.altitudeOffset);
	}
	_snapTarget.set(latest._ecef[0], latest._ecef[1], latest._ecef[2]);

	if (!snapInitialized) {
		// First pose: teleport camera to tracker location
		snapInitialized = true;
		_prevSnapTarget.copy(_snapTarget);
		_snapCurrent.copy(_snapTarget);

		// Jump camera to tracker's lat/lon at current altitude
		setCameraOver(latest.lat, latest.lon, 200);
		return;
	}

	_snapCurrent.lerp(_snapTarget, SNAP_LERP_FACTOR);

	_snapDelta.copy(_snapCurrent).sub(_prevSnapTarget);
	_prevSnapTarget.copy(_snapCurrent);

	if (_snapDelta.lengthSq() < 1e-10) return;

	transition.perspectiveCamera.position.add(_snapDelta);
	transition.orthographicCamera.position.add(_snapDelta);
	controls.pivotPoint.add(_snapDelta);
}

// ---------------------------------------------------------------------------
// Debug: static pointcloud from testdata
// ---------------------------------------------------------------------------

function loadDebugPointcloud() {
	fetch('/datasets/debug-pointcloud.json')
		.then(r => r.json())
		.then(data => {
			console.log(`[Debug] Loading ${data.count} static points`);
			const positions = new Float32Array(data.count * 3);
			const colors = new Float32Array(data.count * 3);

			for (let i = 0; i < data.count; i++) {
				positions[i * 3] = data.positions[i][0];
				positions[i * 3 + 1] = data.positions[i][1];
				positions[i * 3 + 2] = data.positions[i][2];
				colors[i * 3] = data.colors[i][0];
				colors[i * 3 + 1] = data.colors[i][1];
				colors[i * 3 + 2] = data.colors[i][2];
			}

			const geo = new BufferGeometry();
			geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
			geo.setAttribute('color', new Float32BufferAttribute(colors, 3));

			const mat = new PointsMaterial({
				size: 4,
				sizeAttenuation: false,
				vertexColors: true,
				depthTest: true,
			});

			const points = new Points(geo, mat);
			points.frustumCulled = false;

			// Create its own RTC group with the pointcloud center
			const debugGroup = new Group();
			debugGroup.position.set(data.center[0], data.center[1], data.center[2]);
			debugGroup.matrixAutoUpdate = false;
			debugGroup.updateMatrix();
			debugGroup.matrixWorld.copy(debugGroup.matrix);
			debugGroup.add(points);
			scene.add(debugGroup);

			// Install double-precision rendering
			installRtcRendering(points);
			// Override to use debugGroup instead of vizGroup
			points.onBeforeRender = (renderer, scene, camera) => {
				_doublePrecisionMV.multiplyMatrices(camera.matrixWorldInverse, debugGroup.matrixWorld);
				points.modelViewMatrix.copy(_doublePrecisionMV);
			};

			console.log(`[Debug] Static pointcloud loaded. Center: [${data.center.map(v => v.toFixed(1)).join(', ')}]`);

			// Move camera to pointcloud location
			const midLat = (data.metadata.latRange[0] + data.metadata.latRange[1]) / 2;
			const midLon = (data.metadata.lonRange[0] + data.metadata.lonRange[1]) / 2;
			setCameraOver(midLat, midLon, 200);
		})
		.catch(err => console.warn('[Debug] No debug pointcloud:', err.message));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
	renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
	renderer.setClearColor(0x000000);
	document.body.appendChild(renderer.domElement);

	scene = new Scene();
	transition = new CameraTransitionManager(
		new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 160000000),
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

	// Default view: Tokyo
	setCameraOver(35.715848, 139.761099, 500);

	initTiles();
	// loadDebugPointcloud(); // disabled — enable for static test data overlay

	// RTC visualization group — all viz meshes are children.
	// vizGroup.position is set to the RTC center (ECEF) when first pose arrives.
	// We use onBeforeRender to compute a double-precision modelViewMatrix,
	// because the GPU float32 uniform can't hold ECEF (~4M) with sub-meter precision.
	vizGroup = new Group();
	vizGroup.frustumCulled = false;
	vizGroup.matrixAutoUpdate = false;
	scene.add(vizGroup);

	initTrailMesh();
	initConeMesh();
	initLatestMarker();

	// Install double-precision rendering on all viz meshes
	// All viz InstancedMeshes in vizGroup need double-precision rendering
	installRtcRendering(trailMesh);
	installRtcRendering(coneMesh);
	installRtcRendering(latestMarker);

	window.addEventListener("resize", onWindowResize);
	onWindowResize();

	// --- GUI (lil-gui, same style as spatial ID project) ---
	const gui = new GUI();
	gui.width = 300;

	const wsFolder = gui.addFolder("WebSocket");
	wsFolder.add(params, "wsUrl").name("URL");
	wsFolder.add(params, "connect").name("Connect");
	wsFolder.add(params, "disconnect").name("Disconnect");

	const vizFolder = gui.addFolder("Visualization");
	vizFolder.add(params, "historySeconds", 30, 120, 1).name("History (s)").onChange((v) => {
		poseBuffer._capacity = v * 30;
		while (poseBuffer._data.length > poseBuffer._capacity) {
			poseBuffer._data.shift();
		}
	});
	vizFolder.add(params, "altitudeOffset", 0, 50, 0.1).name("Alt Offset (m)").listen();
	vizFolder.add(params, "showTrail").name("Show Trail");
	vizFolder.add(params, "showCone").name("Show Head Cone");
	vizFolder.add(params, "snapToTracker").name("Snap to Tracker");

	const tilesFolder = gui.addFolder("Tiles");
	tilesFolder.add(params, "errorTarget", 5, 100, 1).name("Error Target").onChange(() => {
		tiles.getPluginByName("UPDATE_ON_CHANGE_PLUGIN").needsUpdate = true;
	});

	gui.close();
}

const _setCamPos = new Vector3();
const _setCamGround = new Vector3();

function setCameraOver(lat, lng, alt) {
	_setCamPos.set(...projector.project(lat, lng, alt));
	_setCamGround.set(...projector.project(lat, lng, 0));
	transition.perspectiveCamera.position.copy(_setCamPos);
	transition.perspectiveCamera.lookAt(_setCamGround);
	transition.perspectiveCamera.rotation.z = (-3 * Math.PI) / 4;
	transition.syncCameras();
	controls.setCamera(transition.camera);
	controls.update();
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

// Pre-allocated for animate loop — ZERO per-frame allocations
const _invMat = new Matrix4();
const _camVec = new Vector3();
let _creditsEl = null;
let _lastCreditsUpdate = 0;

function animate() {
	requestAnimationFrame(animate);
	if (!tiles) return;

	controls.enabled = !transition.animating;
	controls.update();
	transition.update();

	const camera = transition.camera;
	tiles.setResolutionFromRenderer(camera, renderer);
	tiles.setCamera(camera);
	tiles.errorTarget = params.errorTarget;
	tiles.update();

	// Update visualization
	updateTrail();
	updateCone();
	updateLatestMarker();
	snapToTracker();

	renderer.render(scene, camera);

	// Update footer credits — throttle to 4Hz (DOM writes are expensive)
	const now = performance.now();
	if (now - _lastCreditsUpdate > 250) {
		_lastCreditsUpdate = now;
		_invMat.copy(tiles.group.matrixWorld).invert();
		_camVec.copy(camera.position).applyMatrix4(_invMat);
		WGS84_ELLIPSOID.getPositionToCartographic(_camVec, res);
		const attrs = tiles.getAttributions();
		const attributions = attrs.length > 0 ? attrs[0].value : "";
		if (!_creditsEl) _creditsEl = document.getElementById("credits");
		_creditsEl.textContent =
			GeoUtils.toLatLonString(res.lat, res.lon, true) + "\n" + attributions;
	}
}

init();
animate();

// Debug globals
window._gp02 = {
	get bufLen() { return poseBuffer.length; },
	get rtcInit() { return _rtcInitialized; },
	get trailDraw() { return trailMesh?.geometry?.drawRange; },
	get trailVisible() { return trailMesh?.visible; },
	get trailParent() { return trailMesh?.parent?.constructor?.name; },
	get trailMaterial() { return { size: trailMesh?.material?.size, visible: trailMesh?.material?.visible, vertexColors: trailMesh?.material?.vertexColors }; },
	get vizGroupVisible() { return vizGroup?.visible; },
	get vizGroupInScene() { return vizGroup?.parent?.constructor?.name; },
	get showTrail() { return params.showTrail; },
	get latest() { const l = poseBuffer.latest(); return l ? { lat: l.lat, lon: l.lon, local: l._cachedLocal } : null; },
	get first3positions() {
		return [
			[_trailPositions[0], _trailPositions[1], _trailPositions[2]],
			[_trailPositions[3], _trailPositions[4], _trailPositions[5]],
			[_trailPositions[6], _trailPositions[7], _trailPositions[8]],
		];
	},
};

// Autoconnect to WebSocket on load
setTimeout(wsConnect, 500);

/**
 * Stream GP-02 binary test data to a remote WebSocket at 100Hz.
 * Usage: node tools/stream-testdata.js [dump-file] [ws-url] [speed]
 *
 * Default: testdata/fusion.dump → wss://nodered.tlab.cloud/ws/rd at 1x speed
 */

import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const dumpFile = process.argv[2] || "testdata/fusion.dump";
const wsUrl = process.argv[3] || "wss://nodered.tlab.cloud/ws/rd";
const speed = parseFloat(process.argv[4] || "1");

// Parse dump into individual frames
const SYNC_0 = 0xAA, SYNC_1 = 0x55;
const raw = readFileSync(dumpFile);
const frames = [];
let pos = 0;

while (pos < raw.length - 6) {
	if (raw[pos] !== SYNC_0 || raw[pos + 1] !== SYNC_1) { pos++; continue; }
	const payloadLen = raw[pos + 3] | (raw[pos + 4] << 8);
	const frameLen = 2 + 1 + 2 + payloadLen + 2;
	if (pos + frameLen > raw.length) break;
	frames.push(Buffer.from(raw.subarray(pos, pos + frameLen)));
	pos += frameLen;
}

console.log(`Loaded ${frames.length} frames from ${dumpFile}`);
console.log(`Target: ${wsUrl}`);
console.log(`Speed: ${speed}x (${(100 * speed).toFixed(0)} frames/sec)`);
console.log(`Duration: ${(frames.length / (100 * speed)).toFixed(1)}s per loop\n`);

const ws = new WebSocket(wsUrl);

ws.on("error", (err) => {
	console.error("WebSocket error:", err.message);
	process.exit(1);
});

ws.on("open", () => {
	console.log("Connected. Streaming...");
	let i = 0;
	let sent = 0;
	const interval = 1000 / (100 * speed); // ms between frames

	const timer = setInterval(() => {
		if (ws.readyState !== WebSocket.OPEN) {
			clearInterval(timer);
			console.log("\nConnection closed.");
			process.exit(0);
		}

		ws.send(frames[i]);
		i = (i + 1) % frames.length;
		sent++;

		if (i === 0) {
			console.log(`  Loop complete (${sent} frames sent), restarting...`);
		}
	}, interval);

	// Clean shutdown
	process.on("SIGINT", () => {
		clearInterval(timer);
		console.log(`\nStopped. ${sent} frames sent total.`);
		ws.close();
		process.exit(0);
	});
});

ws.on("close", () => {
	console.log("Disconnected.");
	process.exit(0);
});

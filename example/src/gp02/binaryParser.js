/**
 * GP-02 Binary Protocol Parser
 *
 * Frame format: [SYNC:2][TYPE:1][LEN:2 LE][PAYLOAD:N][CRC16:2 LE]
 * Sync bytes: 0xAA 0x55 (Fusion / No-Fusion mode)
 *
 * CRC-16/CCITT-FALSE: polynomial 0x1021, init 0xFFFF, no final XOR.
 * Computed over TYPE + LEN + PAYLOAD bytes.
 */

const SYNC_0 = 0xAA;
const SYNC_1 = 0x55;

// Message type IDs (Fusion / No-Fusion share sync bytes)
export const MSG_POSE     = 0x01;
export const MSG_RAW_GNSS = 0x02;
export const MSG_RAW_IMU  = 0x03;
export const MSG_RAW_BARO = 0x04;
export const MSG_STATUS   = 0x05;

// GNSS position types
export const POS_TYPE_SINGLE = 16;
export const POS_TYPE_FLOAT  = 34;
export const POS_TYPE_RTK    = 50;

// --- CRC-16/CCITT-FALSE ---------------------------------------------------

const crcTable = new Uint16Array(256);
(function buildTable() {
	for (let i = 0; i < 256; i++) {
		let crc = i << 8;
		for (let j = 0; j < 8; j++) {
			crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
			crc &= 0xFFFF;
		}
		crcTable[i] = crc;
	}
})();

function crc16(data, offset, length) {
	let crc = 0xFFFF;
	for (let i = offset; i < offset + length; i++) {
		crc = ((crc << 8) ^ crcTable[((crc >>> 8) ^ data[i]) & 0xFF]) & 0xFFFF;
	}
	return crc;
}

// --- Payload decoders ------------------------------------------------------

function decodePose(dv, off) {
	return {
		type: 'pose',
		latitude:      dv.getFloat64(off + 0, true),
		longitude:     dv.getFloat64(off + 8, true),
		altitude_m:    dv.getFloat32(off + 16, true),
		quat_w:        dv.getFloat32(off + 20, true),
		quat_x:        dv.getFloat32(off + 24, true),
		quat_y:        dv.getFloat32(off + 28, true),
		quat_z:        dv.getFloat32(off + 32, true),
		travel_heading: dv.getFloat32(off + 36, true),
		velocity_h:    dv.getFloat32(off + 40, true),
		velocity_v:    dv.getFloat32(off + 44, true),
		timestamp_ns:  dv.getBigUint64(off + 48, true),
		time_quality:  dv.getUint8(off + 56),
		pos_source:    dv.getUint8(off + 57),
		gnss_pos_type: dv.getUint8(off + 58),
		sigma_xy:      dv.getFloat32(off + 60, true),
		sigma_z:       dv.getFloat32(off + 64, true),
		pdr_step_count: dv.getUint32(off + 68, true),
	};
}

function decodeRawGnss(dv, off) {
	return {
		type: 'raw_gnss',
		timestamp_ns: dv.getBigUint64(off + 0, true),
		lat:          dv.getFloat64(off + 8, true),
		lon:          dv.getFloat64(off + 16, true),
		hgt:          dv.getFloat32(off + 24, true),
		pos_type:     dv.getUint8(off + 28),
		sol_stat:     dv.getUint8(off + 29),
	};
}

function decodeRawImu(dv, off) {
	return {
		type: 'raw_imu',
		timestamp_ns:    dv.getBigUint64(off + 0, true),
		qw:              dv.getFloat32(off + 8, true),
		qx:              dv.getFloat32(off + 12, true),
		qy:              dv.getFloat32(off + 16, true),
		qz:              dv.getFloat32(off + 20, true),
		lax:             dv.getFloat32(off + 24, true),
		lay:             dv.getFloat32(off + 28, true),
		laz:             dv.getFloat32(off + 32, true),
		quat_accuracy:   dv.getUint8(off + 36),
		accel_accuracy:  dv.getUint8(off + 37),
	};
}

function decodeRawBaro(dv, off) {
	return {
		type: 'raw_baro',
		timestamp_ns:  dv.getBigUint64(off + 0, true),
		pressure_kpa:  dv.getFloat32(off + 8, true),
		temperature_c: dv.getFloat32(off + 12, true),
		altitude_m:    dv.getFloat32(off + 16, true),
	};
}

function decodeStatus(dv, off) {
	return {
		type: 'status',
		timestamp_ns:      dv.getBigUint64(off + 0, true),
		faults:            dv.getUint32(off + 8, true),
		state:             dv.getUint8(off + 12),
		time_quality:      dv.getUint8(off + 13),
		gnss_fix:          dv.getUint8(off + 14),
		bno_accuracy:      dv.getUint8(off + 15),
		pps_count:         dv.getUint32(off + 16, true),
		filtered_altitude: dv.getFloat32(off + 20, true),
		vertical_velocity: dv.getFloat32(off + 24, true),
	};
}

const DECODERS = {
	[MSG_POSE]:     decodePose,
	[MSG_RAW_GNSS]: decodeRawGnss,
	[MSG_RAW_IMU]:  decodeRawImu,
	[MSG_RAW_BARO]: decodeRawBaro,
	[MSG_STATUS]:   decodeStatus,
};

// --- Streaming parser class ------------------------------------------------

/**
 * Stateful streaming parser for GP-02 binary protocol.
 * Feed it ArrayBuffer chunks from WebSocket; it emits parsed message objects.
 */
export class GP02Parser {

	constructor() {
		/** @type {Uint8Array} */
		this._buf = new Uint8Array(0);
		this._mergeBuf = null; // reusable merge buffer
		this._messages = [];   // reusable output array
	}

	/**
	 * Feed raw bytes into the parser.
	 * @param {ArrayBuffer|Uint8Array} chunk
	 * @returns {Array} Array of parsed message objects
	 */
	feed(chunk) {
		const incoming = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk;

		// append to internal buffer — avoid allocation if no leftover
		if (this._buf.length === 0) {
			this._buf = incoming;
		} else {
			// Reuse merge buffer if large enough
			const needed = this._buf.length + incoming.length;
			if (!this._mergeBuf || this._mergeBuf.length < needed) {
				this._mergeBuf = new Uint8Array(Math.max(needed, 4096));
			}
			this._mergeBuf.set(this._buf);
			this._mergeBuf.set(incoming, this._buf.length);
			this._buf = this._mergeBuf.subarray(0, needed);
		}

		const messages = this._messages;
		messages.length = 0;
		let pos = 0;

		while (pos < this._buf.length - 1) {
			// find sync bytes
			if (this._buf[pos] !== SYNC_0 || this._buf[pos + 1] !== SYNC_1) {
				pos++;
				continue;
			}

			// need at least header (2 sync + 1 type + 2 len = 5)
			if (pos + 5 > this._buf.length) break;

			const msgType = this._buf[pos + 2];
			const payloadLen = this._buf[pos + 3] | (this._buf[pos + 4] << 8);
			const frameLen = 2 + 1 + 2 + payloadLen + 2; // sync + type + len + payload + crc

			// wait for full frame
			if (pos + frameLen > this._buf.length) break;

			// CRC check over TYPE + LEN + PAYLOAD
			const crcData = this._buf.subarray(pos + 2, pos + 5 + payloadLen);
			const crcCalc = crc16(crcData, 0, crcData.length);
			const crcRecv = this._buf[pos + 5 + payloadLen] | (this._buf[pos + 5 + payloadLen + 1] << 8);

			if (crcCalc === crcRecv) {
				const decoder = DECODERS[msgType];
				if (decoder) {
					const dv = new DataView(this._buf.buffer, this._buf.byteOffset + pos + 5, payloadLen);
					messages.push(decoder(dv, 0));
				}
				pos += frameLen;
			} else {
				// CRC mismatch, skip this sync and try again
				pos++;
			}
		}

		// keep unconsumed bytes — use subarray when possible to avoid copy
		if (pos >= this._buf.length) {
			this._buf = new Uint8Array(0);
		} else if (pos > 0) {
			// Must copy because the underlying buffer may be reused
			this._buf = new Uint8Array(this._buf.subarray(pos));
		}

		return messages;
	}

	reset() {
		this._buf = new Uint8Array(0);
	}
}

// --- Utility ---------------------------------------------------------------

export function timeQualityString(q) {
	switch (q) {
		case 0: return 'None';
		case 1: return 'NTP';
		case 2: return 'GNSS coarse';
		case 3: return 'GNSS fine';
		default: return `Unknown (${q})`;
	}
}

export function posTypeString(t) {
	switch (t) {
		case POS_TYPE_RTK:    return 'RTK';
		case POS_TYPE_FLOAT:  return 'FLOAT';
		case POS_TYPE_SINGLE: return 'SINGLE';
		case 0:               return 'None';
		default:              return `Type ${t}`;
	}
}

export function systemStateString(s) {
	switch (s) {
		case 0: return 'Boot';
		case 1: return 'Initializing';
		case 2: return 'No GNSS';
		case 3: return 'RTK';
		case 4: return 'PDR';
		case 5: return 'GNSS Float';
		case 6: return 'GNSS Single';
		default: return `State ${s}`;
	}
}

export function decodeFaults(bitmask) {
	const faults = [];
	if (bitmask & 0x01) faults.push('IMU');
	if (bitmask & 0x02) faults.push('Baro');
	if (bitmask & 0x04) faults.push('GNSS');
	if (bitmask & 0x08) faults.push('WiFi');
	if (bitmask & 0x10) faults.push('I2C');
	if (bitmask & 0x20) faults.push('Timer');
	return faults.length > 0 ? faults.join(', ') : 'None';
}

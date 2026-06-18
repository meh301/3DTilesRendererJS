/**
 * Simple fixed-size ring buffer for GP-02 pose entries.
 * Push entries, draw them. No time-based eviction.
 * Old entries drop off when capacity is exceeded.
 */

export class PoseRingBuffer {

	constructor(capacity = 20000) {
		this._data = [];
		this._capacity = capacity;
	}

	push(entry) {
		this._data.push(entry);
		if (this._data.length > this._capacity) {
			this._data.shift();
		}
	}

	forEach(fn) {
		for (let i = 0; i < this._data.length; i++) {
			fn(this._data[i], i);
		}
	}

	latest() {
		return this._data.length > 0 ? this._data[this._data.length - 1] : null;
	}

	get length() {
		return this._data.length;
	}

	clear() {
		this._data.length = 0;
	}
}

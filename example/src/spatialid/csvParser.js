/**
 * CSV parser for Spatial ID files.
 *
 * CSV format:
 *   Line 1: "PLATEAU_3D-Spatial-ID_CSV,0100,25,0" (header)
 *   Line 2: "gml_id,spatial_id" (column names)
 *   Line 3+: "bldg_xxx,25/F/X/Y" (data rows)
 *
 * Preserves building IDs (gml_id) as numeric indices for per-building greedy meshing.
 * Duplicate spatial IDs within the SAME building are deduplicated.
 */

/**
 * Parse CSV text into compact typed arrays with building indices.
 * @param {string} text - Raw CSV text
 * @returns {{
 *   x: Int32Array, y: Int32Array, f: Int32Array,
 *   buildingIdx: Uint32Array,
 *   buildingIds: string[],
 *   count: number, zoom: number
 * }}
 */
export function parseCSV(text) {
	const lines = text.split("\n");

	// Parse header to get zoom level
	const header = lines[0];
	const headerParts = header.split(",");
	const zoom = parseInt(headerParts[2], 10) || 25;

	// Pre-allocate oversized arrays
	const maxRows = lines.length - 2;
	const xTemp = new Int32Array(maxRows);
	const yTemp = new Int32Array(maxRows);
	const fTemp = new Int32Array(maxRows);
	const bldgTemp = new Uint32Array(maxRows);

	// Building ID mapping
	const buildingMap = new Map(); // gml_id string → numeric index
	const buildingIds = [];        // index → gml_id string

	// Deduplicate: (buildingIdx, F, X, Y) tuples
	const seen = new Set();
	let count = 0;

	for (let i = 2; i < lines.length; i++) {
		const line = lines[i];
		if (line.length === 0) continue;

		const commaIdx = line.indexOf(",");
		if (commaIdx < 0) continue;

		// Extract gml_id
		const gmlId = line.substring(0, commaIdx);

		// Get or assign building index
		let bIdx = buildingMap.get(gmlId);
		if (bIdx === undefined) {
			bIdx = buildingIds.length;
			buildingMap.set(gmlId, bIdx);
			buildingIds.push(gmlId);
		}

		// Parse spatial_id: Z/F/X/Y
		const sid = line.substring(commaIdx + 1);
		const s1 = sid.indexOf("/");
		if (s1 < 0) continue;
		const s2 = sid.indexOf("/", s1 + 1);
		if (s2 < 0) continue;
		const s3 = sid.indexOf("/", s2 + 1);
		if (s3 < 0) continue;

		const f = parseInt(sid.substring(s1 + 1, s2), 10);
		const x = parseInt(sid.substring(s2 + 1, s3), 10);
		const y = parseInt(sid.substring(s3 + 1), 10);

		// Dedup key: building + spatial position
		const key = `${bIdx}/${f}/${x}/${y}`;
		if (seen.has(key)) continue;
		seen.add(key);

		xTemp[count] = x;
		yTemp[count] = y;
		fTemp[count] = f;
		bldgTemp[count] = bIdx;
		count++;
	}

	return {
		x: xTemp.slice(0, count),
		y: yTemp.slice(0, count),
		f: fTemp.slice(0, count),
		buildingIdx: bldgTemp.slice(0, count),
		buildingIds,
		count,
		zoom,
	};
}

/**
 * Fetch and parse a CSV file.
 * @param {string} url
 * @returns {Promise<ReturnType<typeof parseCSV>>}
 */
export async function fetchAndParseCSV(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
	const text = await response.text();
	return parseCSV(text);
}

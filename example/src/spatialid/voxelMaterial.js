/**
 * Voxel lines material — inspired by TopoLinesPlugin.
 *
 * Applied to the spatial ID geometry (which exists but is visually transparent).
 * Draws anti-aliased grid lines at every voxel boundary in all 3 axes,
 * using fwidth() for screen-space line thickness (same technique as topo lines).
 *
 * The geometry provides `gridPosition` (local integer coords) as a vertex attribute.
 * Lines appear at every integer boundary — the voxel edges.
 */

import { ShaderMaterial, DoubleSide, Color, Vector2 } from "three";

const vertexShader = /* glsl */ `
	attribute vec3 gridPosition;
	varying vec3 vGridPos;
	varying vec3 vWorldNormal;

	void main() {
		vGridPos = gridPosition;
		vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}
`;

const fragmentShader = /* glsl */ `
	uniform vec3 lineColor;
	uniform float lineOpacity;
	uniform float lineThickness;
	uniform vec2 resolution;
	uniform float pixelRatio;

	varying vec3 vGridPos;
	varying vec3 vWorldNormal;

	// From topo lines: screen-space-aware fwidth
	float fwidth2(float v) {
		return length(vec2(dFdx(v), dFdy(v)));
	}

	vec3 fwidth2(vec3 v) {
		return sqrt(dFdx(v) * dFdx(v) + dFdy(v) * dFdy(v));
	}

	void main() {
		// Grid position — lines at every integer boundary
		vec3 pos = vGridPos;
		float step = 1.0; // one line per voxel
		float halfStep = 0.5;

		// Screen-space derivative of grid position (pixels per grid unit)
		vec3 delta = max(fwidth2(pos), 1e-7);

		// Distance to nearest grid line in each axis
		vec3 stride = 2.0 * abs(mod(pos + halfStep, step) - halfStep);

		// Anti-aliased line using smoothstep (same technique as topo lines)
		float thick = lineThickness * pixelRatio;
		vec3 lines = smoothstep(delta * 0.5, delta * -0.5, stride - delta * thick);

		// Pick the two axes perpendicular to the face normal
		// (don't draw lines along the axis the face is facing)
		vec3 absN = abs(vWorldNormal);
		float lineIntensity;
		if (absN.x > absN.y && absN.x > absN.z) {
			// X-facing: draw Y and Z lines
			lineIntensity = max(lines.y, lines.z);
		} else if (absN.y > absN.z) {
			// Y-facing: draw X and Z lines
			lineIntensity = max(lines.x, lines.z);
		} else {
			// Z-facing: draw X and Y lines
			lineIntensity = max(lines.x, lines.y);
		}

		// Discard fully transparent pixels (the "invisible geometry" part)
		if (lineIntensity < 0.01) discard;

		gl_FragColor = vec4(lineColor, lineIntensity * lineOpacity);
	}
`;

export function createVoxelMaterial(options = {}) {
	const {
		color = 0xffffff,
		opacity = 0.9,
		thickness = 1.5,
	} = options;

	return new ShaderMaterial({
		vertexShader,
		fragmentShader,
		uniforms: {
			lineColor: { value: new Color(color) },
			lineOpacity: { value: opacity },
			lineThickness: { value: thickness },
			resolution: { value: new Vector2(1920, 1080) },
			pixelRatio: { value: 1.0 },
		},
		transparent: true,
		side: DoubleSide,
		depthWrite: false,
		depthTest: true,
		// Push voxel lines slightly in front of Google tiles to prevent z-fighting
		polygonOffset: true,
		polygonOffsetFactor: -2,
		polygonOffsetUnits: -2,
		extensions: { derivatives: true },
	});
}

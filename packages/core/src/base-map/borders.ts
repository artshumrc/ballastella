import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Flavor } from '@protomaps/basemaps';

import { dashArrayFor, type LineStyle } from '../annotation/annotation.js';
import { LINE_STYLES } from '../annotation/render.js';
import { asRecord } from '../store/project-store.js';

export type BaseMapBorders = 'none' | 'national' | 'all';

export const BASE_MAP_BORDERS: readonly BaseMapBorders[] = ['none', 'national', 'all'];
export const DEFAULT_BASE_MAP_BORDERS: BaseMapBorders = 'all';
export const PROJECT_BORDERS_KEY = 'borders';
export const PROJECT_BORDER_STYLE_KEY = 'borderStyle';

/** `null` in a property means automatic: derived from the flavor, as {@link strengthenedBorder} does. */
export type BaseMapBorderStyle = {
	readonly color: string | null;
	readonly lineStyle: LineStyle | null;
	readonly width: number | null;
};

export const DEFAULT_BASE_MAP_BORDER_STYLE: BaseMapBorderStyle = Object.freeze({
	color: null,
	lineStyle: null,
	width: null
});

export function isDefaultBorderStyle(style: BaseMapBorderStyle): boolean {
	return style.color === null && style.lineStyle === null && style.width === null;
}

export const MIN_BORDER_WIDTH = 0.5;
export const MAX_BORDER_WIDTH = 6;
const AUTOMATIC_NATIONAL_WIDTH = 1;
const AUTOMATIC_SUBNATIONAL_WIDTH = 0.64;

export function subnationalWidth(nationalWidth: number): number {
	return (
		Math.round(nationalWidth * (AUTOMATIC_SUBNATIONAL_WIDTH / AUTOMATIC_NATIONAL_WIDTH) * 100) / 100
	);
}

export function readBaseMapBorderStyle(document: unknown): BaseMapBorderStyle {
	const fields = asRecord(asRecord(document)?.[PROJECT_BORDER_STYLE_KEY]);
	if (fields === null) return DEFAULT_BASE_MAP_BORDER_STYLE;
	const colour = typeof fields.color === 'string' ? fields.color.trim().toLowerCase() : '';
	const lineStyle = typeof fields.lineStyle === 'string' ? fields.lineStyle.trim() : '';
	const width = fields.width;

	return {
		color: /^#[0-9a-f]{6}$/.test(colour) ? colour : null,
		lineStyle: LINE_STYLES.includes(lineStyle as LineStyle) ? (lineStyle as LineStyle) : null,
		width:
			typeof width === 'number' && Number.isFinite(width)
				? Math.min(MAX_BORDER_WIDTH, Math.max(MIN_BORDER_WIDTH, width))
				: null
	};
}

export const NATIONAL_BOUNDARY_LAYER = 'boundaries_country';
export const SUBNATIONAL_BOUNDARY_LAYER = 'boundaries';

export function bordersInclude(borders: BaseMapBorders, layerId: string): boolean {
	if (layerId === NATIONAL_BOUNDARY_LAYER) return borders !== 'none';
	if (layerId === SUBNATIONAL_BOUNDARY_LAYER) return borders === 'all';
	return true;
}

function isBaseMapBorders(value: unknown): value is BaseMapBorders {
	return BASE_MAP_BORDERS.includes(value as BaseMapBorders);
}

export function readBaseMapBorders(document: unknown): BaseMapBorders {
	const value = asRecord(document)?.[PROJECT_BORDERS_KEY];
	const trimmed = typeof value === 'string' ? value.trim() : value;
	return isBaseMapBorders(trimmed) ? trimmed : DEFAULT_BASE_MAP_BORDERS;
}

const BORDER_WIDTH: Record<string, number> = {
	[NATIONAL_BOUNDARY_LAYER]: AUTOMATIC_NATIONAL_WIDTH,
	[SUBNATIONAL_BOUNDARY_LAYER]: AUTOMATIC_SUBNATIONAL_WIDTH
};

const BORDER_CONTRAST = 4.5;
const BORDER_WARNING_CONTRAST = 3;

export function strengthenedBorder(
	layer: LayerSpecification,
	flavor: Flavor,
	style: BaseMapBorderStyle = DEFAULT_BASE_MAP_BORDER_STYLE
): LayerSpecification {
	const automaticWidth = BORDER_WIDTH[layer.id];
	if (automaticWidth === undefined || layer.type !== 'line') return layer;

	const width =
		style.width === null
			? automaticWidth
			: layer.id === NATIONAL_BOUNDARY_LAYER
				? style.width
				: subnationalWidth(style.width);

	return {
		...layer,
		paint: {
			...layer.paint,
			...(style.lineStyle === null
				? {}
				: { 'line-dasharray': [...(dashArrayFor(style.lineStyle) ?? [1, 0])] }),
			'line-color': style.color ?? legibleAgainst(flavor.boundaries, flavor.earth),
			'line-width': width
		}
	};
}

export function borderColorIsLegible(colour: string, ground: string): boolean {
	if (!isHex(colour) || !isHex(ground)) return true;
	return contrastRatio(colour, ground) >= BORDER_WARNING_CONTRAST;
}

/** `line` moved away from `ground` until it clears {@link BORDER_CONTRAST}, or as far as it goes. */
function legibleAgainst(line: string, ground: string): string {
	if (!isHex(line) || !isHex(ground)) return line;
	const lineRgb = channels(line);
	const groundLuminance = relativeLuminance(ground);
	const extreme = groundLuminance > 0.5 ? 0 : 255;
	const steps = 20;
	let adjusted = lineRgb;
	for (let step = 0; step <= steps; step += 1) {
		adjusted = lineRgb.map((channel) => channel + (extreme - channel) * (step / steps));
		if (ratio(luminance(adjusted), groundLuminance) >= BORDER_CONTRAST) break;
	}
	return `#${adjusted.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

const isHex = (colour: string): boolean => /^#[0-9a-f]{6}$/i.test(colour.trim());

function channels(colour: string): number[] {
	const value = Number.parseInt(colour.trim().slice(1), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function luminance(rgb: readonly number[]): number {
	const linear = (channel: number): number => {
		const unit = channel / 255;
		return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	};
	const [r = 0, g = 0, b = 0] = rgb;
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** WCAG relative luminance of a `#rrggbb` colour. */
export const relativeLuminance = (colour: string): number => luminance(channels(colour));

/** WCAG contrast ratio between two `#rrggbb` colours. */
export const contrastRatio = (a: string, b: string): number =>
	ratio(relativeLuminance(a), relativeLuminance(b));

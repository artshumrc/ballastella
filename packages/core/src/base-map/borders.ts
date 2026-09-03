// Which administrative boundaries the Base Map draws, and the one reader of `project.json`'s field
// for it.
//
// **No extra data, and that is the whole reason this is a filter rather than a source.** The
// Protomaps schema already carries a `boundaries` source-layer in the same archive every entry
// reads, split by `kind_detail` into the national line and everything inside it. So showing or
// hiding borders costs no request, no dependency, and no GeoJSON of anyone's — it is a choice about
// which of the layers `@protomaps/basemaps` already built get into the style document.
//
// **It is Project data, not a catalog entry and not a Reader preference.** Whether a modern national
// border belongs over a fourteenth-century itinerary is the author's argument, not a matter of
// taste, and it has to travel with the work to the Published Site. That is the opposite of
// `reader-preference.ts`, which is emphatic that a Reader's Base Map choice is never Project data:
// the two fields sit next to each other in `project.json` and mean deliberately different things.

import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Flavor } from '@protomaps/basemaps';

import { dashArrayFor, type LineStyle } from '../annotation/annotation.js';
import { LINE_STYLES } from '../annotation/render.js';

/**
 * How much of the boundary layer set a Project draws.
 *
 * - `all` — national borders and the divisions inside them: states, provinces, regions.
 * - `national` — the national line alone.
 * - `none` — no administrative boundaries at all. Coastlines and rivers are geography, not
 *   boundaries, and are untouched by every value here.
 */
export type BaseMapBorders = 'none' | 'national' | 'all';

/** In catalog order for a switcher: least to most. */
export const BASE_MAP_BORDERS: readonly BaseMapBorders[] = ['none', 'national', 'all'];

/**
 * What a Project that says nothing draws.
 *
 * `all` because that is what every Project drew before this field existed, and a build that started
 * hiding borders on upgrade would silently change what a shared map asserts. It is also why
 * `serialiseProjectFile` omits the field at this value: an unchanged Project's bytes stay what they
 * were (ADR-0010).
 */
export const DEFAULT_BASE_MAP_BORDERS: BaseMapBorders = 'all';

/** The key `project.json` records the author's boundary choice under. */
export const PROJECT_BORDERS_KEY = 'borders';

/** The key `project.json` records how those boundaries are *drawn* under. */
export const PROJECT_BORDER_STYLE_KEY = 'borderStyle';

/**
 * How a Project draws the boundaries it has chosen to draw.
 *
 * **A second key rather than a widening of `borders`**, and the split is the one the head of this
 * file already draws: `borders` says *what* is asserted — is a modern national line part of this
 * argument — and this says how the assertion looks. Keeping them apart means every reader of the
 * level keeps working unchanged, and a Project that styles its borders and then hides them has not
 * lost the styling.
 *
 * **Every property is independently `null`, and `null` means automatic** rather than a value written
 * here. Automatic is {@link strengthenedBorder}'s derivation — the flavor's own boundary colour
 * pushed to legibility, upstream's dash pattern, and the widths above — so a Project that has said
 * nothing draws exactly what it drew before this field existed, and an author who wants the line
 * red but its dashes left alone says only the one thing.
 */
export type BaseMapBorderStyle = {
	/** `#rrggbb`, or `null` for the colour derived from the flavor. */
	readonly color: string | null;
	/** `null` for upstream's own zoom-stepped pattern, which is solid low and dashed from z4. */
	readonly lineStyle: LineStyle | null;
	/** Width of the national line in pixels, or `null` for {@link BORDER_WIDTH}'s. */
	readonly width: number | null;
};

/** Nothing chosen: every property automatic. Deep-frozen so a caller cannot make it mean something. */
export const DEFAULT_BASE_MAP_BORDER_STYLE: BaseMapBorderStyle = Object.freeze({
	color: null,
	lineStyle: null,
	width: null
});

/** True when the author has chosen nothing, and the field is therefore not written at all. */
export function isDefaultBorderStyle(style: BaseMapBorderStyle): boolean {
	return style.color === null && style.lineStyle === null && style.width === null;
}

/**
 * The narrowest and widest a boundary line may be set to.
 *
 * Not from zero: zero is an invisible border, which is what `borders: 'none'` says properly, and a
 * width slider that can silently contradict the level control above it is two controls for one
 * thing. Six is where a line stops reading as a boundary and starts reading as a filled band.
 */
export const MIN_BORDER_WIDTH = 0.5;
export const MAX_BORDER_WIDTH = 6;

/**
 * What the divisions inside a nation are drawn at, given the national line's width.
 *
 * The ratio of the two automatic widths below, applied to whatever the author chose, because
 * `national` versus `all` has to stay legible *as a difference* — one width for both levels makes
 * a state line and an international one the same claim.
 */
export function subnationalWidth(nationalWidth: number): number {
	const ratio = BORDER_WIDTH[SUBNATIONAL_BOUNDARY_LAYER] / BORDER_WIDTH[NATIONAL_BOUNDARY_LAYER];
	return Math.round(nationalWidth * ratio * 100) / 100;
}

/**
 * The author's border styling from a parsed `project.json`.
 *
 * Tolerant in the way {@link readBaseMapBorders} is, and per-property rather than per-object: a
 * document whose `width` is a string still yields the colour beside it. Every unusable value means
 * "not chosen", which is automatic. Nothing here throws.
 */
export function readBaseMapBorderStyle(document: unknown): BaseMapBorderStyle {
	if (typeof document !== 'object' || document === null) return DEFAULT_BASE_MAP_BORDER_STYLE;
	const raw = (document as Record<string, unknown>)[PROJECT_BORDER_STYLE_KEY];
	if (typeof raw !== 'object' || raw === null) return DEFAULT_BASE_MAP_BORDER_STYLE;
	const fields = raw as Record<string, unknown>;

	const colour = typeof fields.color === 'string' ? fields.color.trim().toLowerCase() : '';
	const lineStyle = typeof fields.lineStyle === 'string' ? fields.lineStyle.trim() : '';
	const width = fields.width;

	return {
		color: /^#[0-9a-f]{6}$/.test(colour) ? colour : null,
		lineStyle: LINE_STYLES.includes(lineStyle as LineStyle) ? (lineStyle as LineStyle) : null,
		// Clamped rather than rejected: a width from a later build with a wider range is a number this
		// build can honour approximately, and drawing it at the nearest end is closer to the author's
		// intent than ignoring it. `NaN` and `Infinity` are not widths and fall through to automatic.
		width:
			typeof width === 'number' && Number.isFinite(width)
				? Math.min(MAX_BORDER_WIDTH, Math.max(MIN_BORDER_WIDTH, width))
				: null
	};
}

/**
 * The layer `@protomaps/basemaps` builds for the national line, filtered to `kind_detail <= 2`.
 *
 * Named rather than derived, and **asserted by `style.test.ts` against the layers the installed
 * package actually emits** — a Protomaps upgrade that renamed it would otherwise leave every value
 * here drawing the same map, which is the quiet failure a border control cannot afford.
 */
export const NATIONAL_BOUNDARY_LAYER = 'boundaries_country';

/** The layer for divisions inside a nation, filtered to `kind_detail > 2`. */
export const SUBNATIONAL_BOUNDARY_LAYER = 'boundaries';

/** Whether a built style layer survives this boundary choice. Non-boundary layers always do. */
export function bordersInclude(borders: BaseMapBorders, layerId: string): boolean {
	if (layerId === NATIONAL_BOUNDARY_LAYER) return borders !== 'none';
	if (layerId === SUBNATIONAL_BOUNDARY_LAYER) return borders === 'all';
	return true;
}

/** True for a value this build can draw. */
export function isBaseMapBorders(value: unknown): value is BaseMapBorders {
	return BASE_MAP_BORDERS.includes(value as BaseMapBorders);
}

/**
 * The author's boundary choice from a parsed `project.json`.
 *
 * Tolerant for the reason `readBaseMapId` is: the document comes off somebody's disk and an older
 * fork, a hand edit, or a newer build may have left the field in any shape. Every unusable shape
 * means "no choice recorded", which is {@link DEFAULT_BASE_MAP_BORDERS}. Nothing here throws.
 */
export function readBaseMapBorders(document: unknown): BaseMapBorders {
	if (typeof document !== 'object' || document === null) return DEFAULT_BASE_MAP_BORDERS;
	const value = (document as Record<string, unknown>)[PROJECT_BORDERS_KEY];
	if (typeof value !== 'string') return DEFAULT_BASE_MAP_BORDERS;
	const trimmed = value.trim();
	return isBaseMapBorders(trimmed) ? trimmed : DEFAULT_BASE_MAP_BORDERS;
}

/**
 * Line widths the boundary layers are drawn at, over the 0.7 and 0.4 `@protomaps/basemaps` ships.
 *
 * Upstream's hairlines are tuned for a map whose subject is the built environment, where a border
 * is context a reader should be able to ignore. Here it is the author's argument — see the head of
 * this file — and a 0.4px dashed line was not reliably visible at all. The national line stays the
 * heavier of the two, because the distinction between the two levels is the point of `national`.
 */
const BORDER_WIDTH: Record<string, number> = {
	[NATIONAL_BOUNDARY_LAYER]: 1,
	[SUBNATIONAL_BOUNDARY_LAYER]: 0.64
};

/**
 * Contrast a boundary line is pushed to against the land it crosses.
 *
 * Above WCAG 2.1 §1.4.11's 3:1 floor for a graphical object, and deliberately: that floor assumes a
 * mark you can see all of, where a dashed 1px line covers a fraction of the area a glyph does at
 * the same ratio. A flavor already at or past this is left exactly as it was drawn.
 */
const BORDER_CONTRAST = 4.5;

/**
 * One built style layer, with the Project's boundary line if that is what it is.
 *
 * Each of the three properties is the author's if they chose it and derived if they did not, which
 * is why this takes the whole {@link BaseMapBorderStyle} rather than three optional arguments: the
 * mixed state — a chosen colour over an automatic width — is the common one, not the edge case.
 *
 * The automatic colour is derived from the flavor rather than chosen here, for the reason
 * `emphasisedFlavor` derives landcover: a hardcoded border colour is a third theme, and it would be
 * the one drawn over both the pale and the dark map. **A colour the author chose is used exactly as
 * chosen, in both themes** — it is their argument and it travels to the Published Site, so silently
 * adjusting it would make the swatch they picked a lie about what is on the map. What stops that
 * being a trap is the editor, which warns when a chosen colour fails against either ground.
 */
export function strengthenedBorder(
	layer: LayerSpecification,
	flavor: Flavor,
	style: BaseMapBorderStyle = DEFAULT_BASE_MAP_BORDER_STYLE
): LayerSpecification {
	const automaticWidth = BORDER_WIDTH[layer.id];
	// The type check is not redundant: the ids above are upstream's to reuse, and silently rewriting
	// the paint of some future fill named `boundaries` is worse than drawing a thin line.
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
			...dasharrayFor(style.lineStyle),
			'line-color': style.color ?? legibleAgainst(flavor.boundaries, flavor.earth),
			'line-width': width
		}
	};
}

/**
 * The `line-dasharray` a chosen line style asks for, as a patch over upstream's paint.
 *
 * An empty patch for `null`, which leaves upstream's zoom-stepped expression in place: solid below
 * z4 and dashed above it is a considered pattern, and replacing it with a flat tuple whenever this
 * function is called would make "automatic" a change.
 *
 * **Solid is a `[1, 0]` tuple here, not the property's absence.** That is the opposite of ADR-0009's
 * rule for an Annotation, and it has to be: an Annotation's absent `stroke-dasharray` is read back
 * by a renderer that defaults to solid, whereas absence in *this* paint object means upstream's
 * expression survives the spread and the author's choice of solid is silently discarded.
 */
function dasharrayFor(line: LineStyle | null): { 'line-dasharray'?: number[] } {
	if (line === null) return {};
	// `[1, 0]` rather than `[1]`: MapLibre's dasharray is a sequence of dash and gap lengths in line
	// widths, and a zero gap is how the spec spells an unbroken line. Copied into a mutable array
	// because that is the shape the style spec's own types require.
	return { 'line-dasharray': [...(dashArrayFor(line) ?? [1, 0])] };
}

/**
 * Contrast below which a *chosen* border colour is called illegible, for the editor's warning.
 *
 * ⚠ **Deliberately lower than {@link BORDER_CONTRAST}, and the two must not be merged.** The
 * derivation aims at 4.5:1 against one ground at a time, which it can always hit because it derives
 * a different colour per theme. A colour the author chose is one colour for *both* grounds, and at
 * 4.5:1 no colour whatsoever clears both — the light earth demands a relative luminance under 0.13
 * and the dark earth demands over 0.24. A warning that fires on every possible choice is noise, and
 * would have taught scholars to ignore the one that matters.
 *
 * 3:1 is WCAG 2.1 §1.4.11's own floor for a graphical object, which is what a border line is, and
 * measured against the nine swatches it separates them: Red, Green and Blue clear both grounds,
 * while White, Black, Yellow, Orange, Grey and Purple each fail one. That is a warning worth
 * reading.
 */
const BORDER_WARNING_CONTRAST = 3;

/**
 * Whether a colour the author chose can actually be seen against a given map ground.
 *
 * The editor's one mitigation for using a chosen colour verbatim in both themes: the palette a
 * scholar picks from contains White and Black, and one of those is invisible on each of the two
 * grounds. Warning is the honest half of that trade — the swatch keeps telling the truth about what
 * is on the map, and the author is told where it will not be legible.
 */
export function borderColorIsLegible(colour: string, ground: string): boolean {
	const colourRgb = channels(colour);
	const groundRgb = channels(ground);
	// Unparseable means no claim rather than a warning: a colour this build cannot measure is not one
	// it should tell an author is wrong.
	if (colourRgb === null || groundRgb === null) return true;
	return contrast(luminance(colourRgb), luminance(groundRgb)) >= BORDER_WARNING_CONTRAST;
}

/**
 * `line` moved away from `ground` until it clears {@link BORDER_CONTRAST}, or as far as it goes.
 *
 * *Away from* rather than toward a fixed colour: on a pale flavor that darkens the line and on a
 * dark one it lightens it, so the bluish grey `dark` picked for its boundaries stays bluish. Either
 * colour in a shape this cannot parse means no adjustment, because a flavor is a fork's to edit and
 * an unreadable one must not be able to throw during prerender.
 */
function legibleAgainst(line: string, ground: string): string {
	const lineRgb = channels(line);
	const groundRgb = channels(ground);
	if (lineRgb === null || groundRgb === null) return line;

	const groundLuminance = luminance(groundRgb);
	const extreme = groundLuminance > 0.5 ? 0 : 255;
	const steps = 20;
	let adjusted = lineRgb;
	for (let step = 0; step <= steps; step += 1) {
		adjusted = lineRgb.map((channel) => channel + (extreme - channel) * (step / steps));
		if (contrast(luminance(adjusted), groundLuminance) >= BORDER_CONTRAST) break;
	}
	return toHex(adjusted);
}

/** The three channels of a `#rrggbb` string, or `null` for anything else. */
function channels(colour: string): number[] | null {
	const digits = /^#([0-9a-f]{6})$/i.exec(colour.trim())?.[1];
	if (digits === undefined) return null;
	const value = Number.parseInt(digits, 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function toHex(rgb: readonly number[]): string {
	return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance. */
function luminance(rgb: readonly number[]): number {
	const linear = (channel: number): number => {
		const unit = channel / 255;
		return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	};
	const [r = 0, g = 0, b = 0] = rgb;
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: number, b: number): number {
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

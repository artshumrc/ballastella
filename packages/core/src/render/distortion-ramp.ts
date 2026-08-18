// The distortion overlay's colours, taken from the theme rather than hardcoded (ADR-0013).
//
// Upstream's defaults are literal `red`, `darkblue`, `green`, `yellow`, `red`. They are legible
// against Allmaps' own interface and not against Tracy's, and ADR-0016 makes one theme signal drive
// both the interface and the map — a colourised Map Image is on the map, so it is on the same
// side of that rule as the Base Map flavour.
//
// daisyUI publishes its theme as CSS custom properties on the document, so the ramp is read from
// there. That is deliberately a *read of the live document* and not a table of colours copied out of
// the theme: a copy is the second `'light' | 'dark'` ADR-0016 warns about, agreeing with the theme
// until the day Tracy changes it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// EVERY COLOUR THAT LEAVES THIS MODULE IS `#rrggbb`, AND IT HAS TO BE
//
// `@allmaps/render` parses colours with `hexToFractionalRgb`, which is `hex-rgb` — **hex only**. It
// does not take `rgb(…)`, it does not take a named colour, and it does not take `oklch(…)`; it
// *throws* `TypeError: Expected a valid hex string`, inside the WebGL renderer's draw path, on every
// frame. Two things make that worth this comment. The throw happens where nothing surfaces it, so
// the visible symptom is a map that is simply not colourised — the same silent shape as the
// `fetchFn` defect. And the distortion values are computed in `TriangulatedWarpedMap`, which is a
// different object entirely, so `trianglePointsDistortion` is full of correct non-zero numbers while
// nothing is painted: a test that checks the measure was computed goes green.
//
// This was found by ticket 07's `pageerror` watch on an unrelated test, which is the only reason
// `rgb(…)` did not ship. The distortion test now watches for it too.

import type { DistortionRamp } from '../alignment/distortion.js';

/**
 * Which theme variable each stop of the ramp reads, and what to fall back to.
 *
 * The fallbacks are only reached where there is no document to read — server-side rendering, and a
 * test environment without the stylesheet — so they are chosen to be *legible* rather than to match
 * the theme: a ramp that silently resolved to nothing would draw an uncoloured map, which reads as
 * "this Alignment has no distortion".
 */
const RAMP_SOURCES: Readonly<Record<keyof DistortionRamp, readonly [string, string]>> = {
	// `log2sigma` above zero: drawn larger than reality. Warm, because "too big" is the direction a
	// reader intuits as expansion.
	distortionColor00: ['--color-warning', '#f59e0b'],
	// `log2sigma` below zero: drawn smaller. The other end of one diverging pair, so it has to be
	// clearly the opposite of the stop above and not merely a different colour.
	distortionColor01: ['--color-info', '#3b82f6'],
	// `twoOmega` and `airyKavr`, which are not offered (ADR-0013). Set anyway, because leaving them
	// at upstream's literal green and yellow would mean a measure added later arrives unthemed.
	distortionColor1: ['--color-success', '#22c55e'],
	distortionColor2: ['--color-accent', '#a855f7'],
	// The fold colour: painted flat wherever `signDetJ` is −1. Error, because a fold is a mistake
	// rather than a property of the original mapmaker's work.
	distortionColor3: ['--color-error', '#ef4444']
};

/** The graticule's colour: the neutral foreground, so it reads on both flavours. */
const GRID_SOURCE: readonly [string, string] = ['--color-base-content', '#111111'];

/**
 * The ramp and the graticule colour as the current theme has them.
 *
 * Read at the moment the layer's options are set rather than cached, because ADR-0016's one theme
 * signal changes `data-theme` on the document and every custom property with it — so a cached ramp
 * would be the previous flavour's.
 */
export function distortionRamp(): DistortionRamp & { renderGridColor: string } {
	const read = ([variable, fallback]: readonly [string, string]): string =>
		resolveThemeColour(variable) || fallback;

	return {
		distortionColor00: read(RAMP_SOURCES.distortionColor00),
		distortionColor01: read(RAMP_SOURCES.distortionColor01),
		distortionColor1: read(RAMP_SOURCES.distortionColor1),
		distortionColor2: read(RAMP_SOURCES.distortionColor2),
		distortionColor3: read(RAMP_SOURCES.distortionColor3),
		renderGridColor: read(GRID_SOURCE)
	};
}

/**
 * One theme colour as `#rrggbb`, or `''` when the document has nothing usable to say.
 *
 * **The conversion is the whole difficulty.** daisyUI 5 publishes its palette in `oklch()` —
 * measured: `--color-warning` is `oklch(82% .189 84.429)` — and the renderer takes hex only. Two
 * obvious routes both fail, and both fail quietly:
 *
 *   * passing the value through, which throws in the renderer's draw path (see the note above), and
 *   * `getComputedStyle(element).color`, which in Chrome **preserves** `oklch()` rather than
 *     serialising to `rgb()`. Measured, not assumed: the round trip comes back in exactly the
 *     notation that cannot be used.
 *
 * So the colour is rasterised — painted into a 1 × 1 canvas and read back as bytes. That is the
 * browser's own OKLCH conversion rather than an approximation of it, it works for any notation CSS
 * will ever add, and it needs no dependency.
 *
 * Validity is established by painting twice from two different starting colours. An unparseable
 * value leaves `fillStyle` at whatever it was, so the two runs disagree; a parseable one gives the
 * same pixel both times. That is exact where comparing against one sentinel is not: a theme whose
 * colour happened to *be* the sentinel would read as invalid.
 *
 * Alpha is dropped on purpose. The renderer reads these through `hexToFractionalRgb`, which takes
 * the first three channels, so an eight-digit hex would be silently truncated anyway — and a
 * half-transparent distortion ramp is not a thing the theme is trying to express.
 */
function resolveThemeColour(variable: string): string {
	if (typeof document === 'undefined') return '';
	const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
	if (raw === '') return '';

	const canvas = document.createElement('canvas');
	canvas.width = 1;
	canvas.height = 1;
	const context = canvas.getContext('2d');
	if (!context) return '';

	const paint = (from: string): string => {
		context.fillStyle = from;
		context.fillStyle = raw;
		context.clearRect(0, 0, 1, 1);
		context.fillRect(0, 0, 1, 1);
		const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
		const channel = (value: number) => value.toString(16).padStart(2, '0');
		return `#${channel(red)}${channel(green)}${channel(blue)}`;
	};

	const first = paint('#ff00ff');
	return first === paint('#00ff00') ? first : '';
}
// `INITIAL_DISTORTION_MEASURE` used to be re-exported from here so that a component reaching for the
// overlay's colours and its default measure had one import. It had no callers by the time this module
// moved into `core`, and the barrel now exports `DEFAULT_DISTORTION_MEASURE` itself — so a second name
// for it here would be an alias that can drift from the thing it aliases.

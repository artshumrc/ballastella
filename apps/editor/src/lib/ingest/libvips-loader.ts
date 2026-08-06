// Loading libvips, at the moment an image turns out to need it and not before.
//
// This module is the whole reason `@ballastella/core`'s streaming tiler takes its module through
// a loader instead of importing it: the `import()` below is the only mention of `wasm-vips` in the
// application, it is inside a function that ingest calls only above the decode ceiling, and
// `apps/viewer` does not contain this file or the dependency (ADR-0019). What is fetched, when it
// is fetched, is therefore visible in one place.
//
// **The guard is not defensive coding.** npm ships only the *threaded* build of `wasm-vips`, which
// needs `SharedArrayBuffer`, which needs a cross-origin isolated document — the COOP/COEP headers
// GitHub Pages cannot send. ADR-0003 asks for the single-threaded build for exactly this reason
// and no published artefact of it exists. Measured on 2026-08-05 over plain HTTP with no COOP or
// COEP: `Vips()` never settles at all. It hangs, in Chromium 151 and Firefox 153 alike, after the
// pthread worker's `postMessage` throws `DataCloneError`; with both headers set it initialises and
// reports libvips 8.18.3. A hang is the worst failure available here — an ingest that shows a
// progress bar and never moves — so this refuses first, in a sentence a user can act on.

import type { VipsModule } from '@ballastella/core';

/**
 * Why libvips cannot run in this document, or `''` when it can.
 *
 * Handed to `ingestImageFile` as `streamingTilerUnavailableReason`, so that an over-threshold
 * image is refused with **this** sentence before anything is imported. That is the whole point of
 * separating the question from the loading: asked afterwards, the refusal arrives as a rejection
 * from `open(file)` and is indistinguishable from a file the tiler could not read — which is how
 * a scholar with a valid 20000 × 15000 JPEG came to be told to convert a TIFF.
 *
 * It does not restate the image's size; `StreamingTilerUnavailableError` puts that in front of it.
 */
export function libvipsUnavailableReason(): string {
	if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) {
		return (
			'The streaming tiler cannot run here: it needs the Cross-Origin-Opener-Policy and ' +
			'Cross-Origin-Embedder-Policy headers, which this deployment does not send — static hosts ' +
			'such as GitHub Pages cannot. Use a smaller version of the image, or convert it to a IIIF ' +
			'pyramid outside the browser.'
		);
	}
	return '';
}

/**
 * The libvips module, fetched on first use.
 *
 * `dynamicLibraries: []` keeps it to `vips.wasm` alone — about 5 MB — rather than also fetching
 * the JPEG XL and HEIF modules, which nothing here reads.
 */
export async function loadLibvips(): Promise<VipsModule> {
	const reason = libvipsUnavailableReason();
	if (reason) throw new Error(reason);

	const { default: Vips } = await import('wasm-vips');
	return (await Vips({ dynamicLibraries: [] })) as unknown as VipsModule;
}

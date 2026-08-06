// The measured `createImageBitmap` decode ceiling, and the threshold it sets.
//
// This file exists because the number cannot be re-derived from the code. It is a property of
// the browsers, it decides which tiler runs (ADR-0003), and getting it wrong in the optimistic
// direction is not a slow ingest but a dead tab in the middle of one — so the measurement, the
// browsers, and the method are written down here rather than left as a constant somebody later
// has to trust.
//
// ## Method
//
// A greyscale PNG whose pixels are all zero compresses to almost nothing, so a probe image of
// any declared size costs nothing to build or transfer, while the bitmap the browser has to
// allocate to decode it is full size — about 4 bytes per pixel. Feeding a ladder of such images
// to `createImageBitmap(blob)` and binary-searching between the last success and the first
// failure therefore measures the decode ceiling directly, with no dependence on how well any
// real image compresses. Each probe ran in a fresh browser process, and each decoded bitmap was
// sampled at its far corner so that a lazy decode could not pass. The probe script is recorded
// in the ticket; it is not part of the app.
//
// ## Measurements — 2026-08-05, Linux x86-64, 62 GiB RAM
//
// | Browser                       | Largest decoded            | Smallest refused           |
// | ----------------------------- | -------------------------- | -------------------------- |
// | Chromium 151.0.7922.34        | 26733×20050 = 535,996,650  | 32767×16384 = 536,854,528  |
// | Firefox 153.0                 | 26533×19900 = 528,006,700  | 26733×20050 = 535,996,650  |
//
// Both refuse in single-digit milliseconds — 15 ms in Chromium, 3 ms in Firefox — with
// "The source image could not be decoded." and no allocation attempt. That says the ceiling is
// a **cap** rather than the host's free memory: 536,870,912 pixels is exactly 2 GiB at 4 bytes
// per pixel, and both engines refuse just below it. Firefox additionally caps a single side at
// 65535 pixels, which Chromium does not (200000×100 decodes there).
//
// Not measured: Safari. No WebKit build was available to drive here, and WebKit's limit is
// documented to be lower — ADR-0003 already notes its *canvas* area limit can be as low as
// 5,242,880 pixels, which the decode-and-crop path avoids by never making a canvas bigger than
// one tile, but its decode limit is a separate number nobody here has measured.

/**
 * The largest image both measured browsers decoded, in pixels.
 *
 * Recorded as the measurement, not as the threshold. Read {@link STREAMING_TILER_THRESHOLD_PIXELS}
 * for the number the tiler actually routes on.
 */
export const MEASURED_DECODE_CEILING_PIXELS = 528_006_700;

/**
 * Above this many pixels, ingest uses the streaming tiler (ADR-0003).
 *
 * 2^28 pixels — a little over half the measured ceiling. The margin is deliberate and is not
 * timidity about the measurement:
 *
 * - The measurement was taken on a workstation with 62 GiB of RAM. The cap is not the only
 *   limit; on a tablet with 4 GiB the allocation fails long before the cap does, and SPEC story
 *   22 is about the machine a scholar actually has.
 * - Safari is unmeasured, and it is the browser whose limits are historically lowest.
 * - **Where the streaming tiler can run**, the two outcomes are not symmetric. Routing an image to
 *   it that the decode path could have handled costs time. Routing one the other way costs the
 *   user their ingest, partway through, with an out-of-memory failure that reads as the tool being
 *   broken.
 *
 * A 2^28-pixel image is a 16384×16384 scan, comfortably above anything a camera produces and
 * above most library derivatives; the pyramid for one is around 4 700 tiles.
 *
 * ## The asymmetry does not hold on a static host, which is where the app actually runs
 *
 * That third argument is the one this number was chosen on, and on GitHub Pages it is false. npm
 * publishes only the threaded `wasm-vips`, so the streaming tiler refuses before it loads
 * (`StreamingTilerUnavailableError`), and **both directions cost the user their ingest** — one
 * with an out-of-memory failure, the other with a refusal. The conservative direction is still the
 * better failure, because a refusal names what is wrong and an OOM does not; but it is no longer
 * free, and it costs the ingest for images the browser demonstrably handles. A 300-megapixel scan
 * is refused here although both measured engines decoded 528.
 *
 * So this number is **conservative for a case that currently cannot be served either way**, and it
 * is left alone deliberately rather than raised, for two reasons: raising it would trade a legible
 * refusal for a dead tab on exactly the machines SPEC story 22 is about, and the blocker is
 * expected to be resolved rather than lived with (ticket 05 lists four options, and the choice is
 * not an implementer's).
 *
 * **Ticket 05's option 3 — "cap ingest at the decode ceiling" — is a different number from this
 * one, and choosing it means changing this constant.** This threshold exists to decide *which of
 * two tilers runs*. A cap exists to decide *whether ingest is possible at all*, and the honest
 * value for that is derived from {@link MEASURED_DECODE_CEILING_PIXELS} with a margin for the
 * machine and the browser — nearer 2^29 than 2^28 on the measurements above, and it would want
 * Safari measured first. Shipping option 3 while leaving 2^28 in place would refuse half the
 * images the cap is meant to admit.
 *
 * ## What this threshold does not cover
 *
 * Routing reads the container's header (`readImageHeader`, in `image-header.ts`), and one it does
 * not know
 * — AVIF, JPEG XL, an SVG — falls through with `undefined` and is handed to `createImageBitmap`
 * **at any declared size**. For those formats the ceiling is enforced by the decoder refusing,
 * which both measured engines do promptly and without attempting the allocation, so the outcome is
 * a decode error rather than a dead tab. It is nonetheless a different failure from the one above:
 * the message says the file could not be read, not that it is too large.
 */
export const STREAMING_TILER_THRESHOLD_PIXELS = 268_435_456;

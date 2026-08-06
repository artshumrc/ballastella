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
 * - The two outcomes are not symmetric. Routing an image to the streaming tiler that the decode
 *   path could have handled costs time. Routing one the other way costs the user their ingest,
 *   partway through, with an out-of-memory failure that reads as the tool being broken.
 *
 * A 2^28-pixel image is a 16384×16384 scan, comfortably above anything a camera produces and
 * above most library derivatives; the pyramid for one is around 4 700 tiles.
 */
export const STREAMING_TILER_THRESHOLD_PIXELS = 268_435_456;

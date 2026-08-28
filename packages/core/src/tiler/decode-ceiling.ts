// The measured `createImageBitmap` decode ceiling, and the cap it sets on ingest.
//
// This file exists because the number cannot be re-derived from the code. It is a property of
// the browsers, it decides whether an image can be ingested at all (ADR-0027), and getting it
// wrong in the optimistic direction is not a slow ingest but a dead tab in the middle of one —
// so the measurement, the browsers, and the method are written down here rather than left as a
// constant somebody later has to trust.
//
// ## Method
//
// A greyscale PNG whose pixels are all zero compresses to almost nothing, so a probe image of
// any declared size costs nothing to build or transfer, while the bitmap the browser has to
// allocate to decode it is full size — about 4 bytes per pixel. Feeding a ladder of such images
// to `createImageBitmap(blob)` and binary-searching between the last success and the first
// failure therefore measures the decode ceiling directly, with no dependence on how well any
// real image compresses. Each probe ran in a fresh browser process, and each decoded bitmap was
// sampled at its far corner so that a lazy decode could not pass. The probe script is not part of
// the app.
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
// one tile, but its decode limit is a separate number nobody here has measured. It is recorded
// as unmeasured rather than guessed at, here and in ADR-0027.

/**
 * The largest image both measured browsers decoded, in pixels.
 *
 * Firefox's number, because it is the lower of the two and a cap has to hold in the browser that
 * gives least. Recorded separately from {@link MAX_INGEST_PIXELS} because the two are different
 * kinds of fact — this one is a property of the browsers, that one is this project's policy — and
 * because a later margin, or a Safari measurement, changes one of them and not the other.
 */
export const MEASURED_DECODE_CEILING_PIXELS = 528_006_700;

/**
 * The largest image ingest will accept, in pixels. Anything above this is refused up front.
 *
 * **The measured ceiling exactly, with no margin** (ADR-0027, human decision of 2026-08-07). There
 * is one tiler — decode-and-crop — so this is not a routing threshold deciding which of two paths
 * runs; it is the answer to "can this be ingested at all", and the honest answer is "yes, up to
 * what a browser will decode".
 *
 * ### Why no margin, when the previous number was half this
 *
 * The constant this replaced was 2^28 (268,435,456), and it was argued down there on an asymmetry:
 * routing an image to the streaming tiler that decode-and-crop could have handled cost only time,
 * while routing it the other way cost the user their ingest. **That asymmetry is gone with the
 * streaming tiler** (ADR-0027, superseding ADR-0003's streaming clause). Both directions now cost
 * the ingest, and the conservative direction was costing it for images the browsers demonstrably
 * decode: a 300-megapixel scan was refused although both engines decoded 528.
 *
 * What remains of the old argument is the machine rather than the browser — a tablet with 4 GiB of
 * RAM will fail somewhere below this number. That is a real limit and this constant is not the
 * place for it: it is not a fixed number at all, it varies by device and by what else is open, and
 * no value written here can predict it. What this cap can do is refuse promptly and legibly the
 * images **no** browser will decode, which it now does at the measured boundary. Below it, a
 * machine that cannot allocate the bitmap gets `createImageBitmap`'s own rejection, surfaced as
 * {@link UnreadableImageError} — a worse message than the size refusal, and the reason ADR-0003's
 * `sharp` CLI escape hatch is still the documented answer for a scan this large.
 *
 * Safari is unmeasured (see the header), so its users may meet a decode rejection below this cap.
 * Firefox's 65535-pixel limit on a single side is likewise not enforced here: an image within this
 * cap but 70000 pixels wide is refused by the decoder rather than by this check.
 *
 * ## What this cap does not cover
 *
 * The check reads the container's header (`readImageHeader`, in `image-header.ts`), and one it does
 * not know — AVIF, JPEG XL, an SVG — falls through with `undefined` and is handed to
 * `createImageBitmap` **at any declared size**. For those formats the ceiling is enforced by the
 * decoder refusing, which both measured engines do promptly and without attempting the allocation,
 * so the outcome is a decode error rather than a dead tab. It is nonetheless a different failure
 * from the one above: the message says the file could not be read, not that it is too large.
 */
export const MAX_INGEST_PIXELS = MEASURED_DECODE_CEILING_PIXELS;

# No streaming tiler in v1: ingest is capped at the measured decode ceiling

Supersedes the streaming clause of [ADR-0003](./0003-every-image-is-tiled-client-side.md). `wasm-vips` is removed from the repository. There is one tiler — decode-and-crop — and an image larger than a browser will decode is refused up front, by a message that names its size in megapixels and tells the user to prepare a IIIF pyramid outside the browser.

Human decision, 2026-08-07. It is the third of the four options v1 ticket 05 listed and held open for a person: *drop the streaming tiler from v1, cap ingest at the decode ceiling, and lean on ADR-0003's already-documented `sharp` CLI as the escape hatch.*

## The path that was removed could not execute

Not "was slow", not "was rarely taken" — **could not run, anywhere this project deploys**.

`wasm-vips` publishes only the **threaded** build. Threads need `SharedArrayBuffer`, which needs a cross-origin isolated document, which needs the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` response headers. ADR-0003 asked for the single-threaded build for exactly this reason and **no published artefact of it exists**.

Measured 2026-08-05, serving the package's own files:

| Document                                 | Chromium 151                | Firefox 153                 |
| ---------------------------------------- | --------------------------- | --------------------------- |
| no COOP/COEP                             | `Vips()` **never settles**  | `Vips()` **never settles**  |
| COOP `same-origin` + COEP `require-corp` | initialises, libvips 8.18.3 | initialises, libvips 8.18.3 |

Without the headers it does not reject. It **hangs**, in both engines, after the pthread worker's `postMessage` throws `DataCloneError` — an ingest that shows a progress bar and never moves, which is the worst failure available on this path. That is why `libvipsUnavailableReason()` refused before importing anything, and why `ingestImageFile` consulted it *before* opening the tiler: so the module was never even fetched.

Nothing in this repository sends those headers, and nothing can. The deployment target is GitHub Pages ([ADR-0006](./0006-the-project-directory-is-the-published-site.md)), which cannot send them; there is no `_headers`, no `netlify.toml`, no `vercel.json`, no `server.headers` in either Vite config, and no header-setting in the e2e deployment support. So the refusal fired in dev, in preview, in e2e, and in production alike — the same state in every one of them.

**The consequence is that the app shipped 10.25 MB and 936 lines of code, tests, and fences to guard code that never ran.** `vite build` emitted `vips.wasm` twice, byte-identical at 5,084,535 bytes each, plus 79 KB of `vips-es6` glue. Measured on 2026-08-07, before and after:

| | Before | After |
| --- | --- | --- |
| `apps/editor/build` | 17,581,608 bytes | 7,251,129 bytes |
| `.wasm` files shipped | 2 | 0 |

That is 10,330,479 bytes, 59% of the editor's build, for a code path no user could reach. The 936 lines are four files deleted whole: `libvips-loader.ts` (55), `streaming-tiler.ts` (242), `streaming-tiler.test.ts` (385), and `check-tiler-lazy.mjs` (254).

The one place `wasm-vips` genuinely executed was `streaming-tiler.test.ts`, under core's **Node** vitest project — where `SharedArrayBuffer` always exists. That is why a test suite proving the streaming tiler correct sat green above a browser path that could not start it. A test that can only pass in an environment the product never runs in is evidence about the test, not about the product.

## Why not fix it instead

Three of ticket 05's four options were available and each was declined:

- **Vendor a single-threaded build.** Upstream can produce one; it is not published. It means committing a multi-megabyte binary to this repository and sharpening the LGPLv3 obligation rather than discharging it.
- **Inject COOP/COEP with a service worker** (the `coi-serviceworker` pattern), which does work on GitHub Pages. `require-corp` then breaks fetching remote IIIF tiles that carry no CORP header — which is the entire subject of referenced Historical Maps — and `credentialless` fixes that in Chromium and not in Safari. It is a site-wide restriction on how the page may load every other origin's files, and it would put the Base Map archive and every library's tiles at risk to enable a path used by a minority of images. It remains an open decision for a human, fenced out of the tickets that touch the service worker.
- **Raise the threshold and keep the tiler.** Meaningless while the tiler cannot start.

## What replaces it

**`MAX_INGEST_PIXELS` = 528,006,700 — the measured ceiling exactly, with no margin.** This is a *cap* and not a routing threshold, and the distinction is the whole of the change. The constant it replaces, `STREAMING_TILER_THRESHOLD_PIXELS`, was 2^28 (268,435,456): a number chosen to decide *which of two tilers ran*, argued down to half the measured ceiling on the grounds that routing an image to the streaming tiler unnecessarily cost only time while routing it the other way cost the user their ingest. With one tiler that asymmetry does not exist, and the conservative number was refusing images the browsers demonstrably decode.

**This therefore raises what a scholar can ingest, roughly twofold.** A 300-megapixel scan is accepted where it was refused. Both measured engines decode 528; Firefox's number is the lower and is the one taken.

The measurements are recorded in `packages/core/src/tiler/decode-ceiling.ts` — the method, the two engines, the largest decoded and the smallest refused for each — rather than as a bare constant. Both engines refuse just below 536,870,912 pixels, which is exactly 2 GiB at 4 bytes per pixel, and both refuse in single-digit milliseconds without attempting the allocation. So the ceiling is a browser cap rather than the host's free memory.

**Safari is unmeasured and stays recorded as unmeasured.** No WebKit build was available to drive, and WebKit's limits are historically the lowest. This decision does not measure it and must not be read as having done so.

**What the cap does not model is the machine.** A tablet with 4 GiB of RAM will fail below this number, and no constant written here can predict where — it varies by device and by what else is open. The cap's job is to refuse promptly and legibly the images *no* browser will decode. Below it, a machine that cannot allocate the bitmap meets `createImageBitmap`'s own rejection, reported as an unreadable image. That is a worse message than the size refusal, and it is why ADR-0003's `sharp` CLI escape hatch remains the documented answer for a scan this large.

## The refusal stops blaming the deployment

The old message named `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, and static hosting — accurate about the cause, and actionable by nobody. A scholar who has never heard of COEP could act on neither half of it.

`ImageTooLargeError` names the image's size in megapixels and the one thing the user can do: convert it to a IIIF pyramid outside the browser and add that instead. No user-facing string anywhere in the product now names COOP, COEP, cross-origin isolation, or `SharedArrayBuffer`.

The same correction reaches the offline-copy plan for a remote IIIF source. That plan used to *warn* that a copy this large "needs the streaming tiler", which was never true on this deployment; it now **refuses**, up front, before several thousand requests are made to somebody else's server. A copy has to exist as one full-resolution image before it can be re-cut — the `full-max` path downloads one and decodes it, the `assembled` path stitches pieces into one — so both inherit the same ceiling and neither had anywhere to escape to. This closes v1 ticket 15's `[~]` criterion, which routed an over-ceiling source "correctly" into a wall.

## Consequences

- **`scripts/check-tiler-lazy.mjs` is deleted**, and its two CI steps with it. It existed to prove `wasm-vips` was reachable only by dynamic import, and there is no such package. It is deleted rather than left passing over an absence: a fence that guards nothing is read as evidence.
- **`scripts/check-viewer-deps.mjs` stays** and still forbids `terra-draw` in `apps/viewer` and in every workspace package the viewer reaches. Only the `wasm-vips` name and core's devDependency allowance came out. Its rule that an allowance matching nothing is a *failure* is what forced the allowance to go rather than linger.
- **[ADR-0019](./0019-minimal-pnpm-monorepo.md)'s three forbidden names become two.** The viewer fence is about `terra-draw` and the tiler. The tiler that remains is `createImageBitmap` and an `OffscreenCanvas`, injected by whichever app has one, and it draws in no dependency for a manifest to name — so what keeps it out of the viewer is that there is nothing to keep out.
- **The LGPLv3 obligation is discharged by removal.** `wasm-vips` was the one dependency in this project where "MIT on npm" did not tell the whole story: the wrapper is MIT, the artefact is compiled libvips under LGPLv3, and twenty further bundled libraries travelled with it including `aom`'s patent grant. Its notice and the **outstanding open item** it carried — the LGPLv3 text was never fetched and committed — are removed from `THIRD-PARTY-NOTICES.md`. Verified rather than assumed: all 291 installed manifests were read on 2026-08-07 and none declares a GPL or LGPL licence. [ADR-0021](./0021-mit-licence-and-gpl-hygiene.md)'s `wasm-vips` section is superseded by this one.
- **The editor's service worker no longer has a 5 MB module to decline.** Its shell filter stays written as a rule — "code and styles from `build`" — rather than as a list of things to dodge, so it needs no edit now that the thing it was dodging has left. v1 ticket 18's decision not to add a COOP/COEP service worker is untouched and is still a human's to make.
- **`IngestProgress.tiler`, `IngestResult.tiler` and `TilerKind` are gone.** A discriminator with one possible value is not information.
- **The `TileSource` seam stays.** It is what lets everything above the tiler be tested in Node with no canvas, and it is where a `sharp`-based or worker-based implementation would attach if one is ever brought in-process.
- **The widening is asserted on real pixels, in real browsers.** `decode-and-crop-tiler.browser.test.ts` decodes a 300-megapixel image — above the old threshold, below the new cap — and checks that tiles cut from it carry the pixels of the region they name, at both ragged margins and the far corner. The fixture is built rather than committed: the image is flat in 256×256 blocks, so 300 MB of pixels never exist at once and the PNG is 2.3 MB. Without it, "an image between the two limits ingests successfully" would rest on a stub tiler that decodes nothing.

## What is deliberately not changed

- **No COOP/COEP service worker.** See above; it is a human's open decision and it risks referenced IIIF tiles and the Base Map archive.
- **Safari is not measured.** Recorded as unmeasured, as the code already did.
- **The AVIF / JPEG XL / JP2 / SVG header gap is not closed.** Those containers are not recognised by `readImageHeader`, so they skip the cap entirely and reach `createImageBitmap` at any declared size. Both measured engines refuse promptly rather than exhausting memory, so the outcome is a decode error rather than a dead tab — a worse *message* than the size refusal, not a worse failure. It is unchanged by this decision and is not this decision's to close.
- **`readImageHeader` stays.** It reads the cap's input, but it also serves the plain decode path's size check.
- **The decode-and-crop tiler stays exactly as it is.** It is the path every user already takes.

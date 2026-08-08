# Drop libvips for v1

## What to build

`wasm-vips` and the streaming tiler come out. The 268 MP routing threshold becomes a real cap set at the
measured decode ceiling, and the refusal that used to blame `Cross-Origin-Embedder-Policy` starts telling
the truth: the image is too large for a browser to decode, convert it to a IIIF pyramid outside the browser.

**This ticket removes a path that cannot execute.** `libvipsUnavailableReason()`
(`apps/editor/src/lib/ingest/libvips-loader.ts:31`) refuses whenever `crossOriginIsolated` is false, and
`packages/core/src/tiler/ingest.ts:255-272` consults it *before* opening the tiler, so `loadLibvips()` is
never called and the module is never fetched. Nothing in this repo sends COOP/COEP — there is no
`_headers`, no `netlify.toml`, no `vercel.json`, no `server.headers` in either vite config, and no
header-setting in `e2e/support/editor-deployment.ts` — and the deployment target is GitHub Pages
(ADR-0006), which cannot send them. `e2e/editor-image-ingest.e2e.ts:316-319` records that the preview
server is "exactly the state" in which the path is unavailable. So the app ships 10.25 MB and roughly 870
lines of code, tests and fences to guard code that is dead in dev, in preview, in e2e, and in production.

Demonstrable end to end: the built editor contains no `.wasm` file; an image between 268 MP and 528 MP
ingests successfully where it is refused today; an image above 528 MP is refused with a message that names
its size and the remedy and never mentions COOP, COEP, or cross-origin isolation.

Human decision, 2026-08-07: libvips is not needed for v1. The cap is the **measured** ceiling, not the
old routing number.

## Where to start

- `apps/editor/src/lib/ingest/libvips-loader.ts` — deleted whole. Read the measurement at `:12-15` before
  deleting it; it is the evidence for this ticket and must survive in the ADR.
- `packages/core/src/tiler/streaming-tiler.ts` (~230 lines) and its export at `packages/core/src/index.ts:539-541`.
- `packages/core/src/tiler/streaming-tiler.test.ts` (~380 lines) — the only place in the repo that executes
  real libvips, and it does so under the Node vitest project where `SharedArrayBuffer` always exists
  (`packages/core/vitest.config.ts:26-32`). That is why it passes while the browser path cannot run.
- `packages/core/src/tiler/decode-ceiling.ts` — `STREAMING_TILER_THRESHOLD_PIXELS` at `:100` and
  `MEASURED_DECODE_CEILING_PIXELS` (528,006,700). **Read `:70-88` first**: it already says 2^28 is
  "conservative for a case that currently cannot be served either way".
- `packages/core/src/tiler/ingest.ts:255-272` — the routing and refusal that becomes a cap.
- `apps/editor/src/lib/editor-session.svelte.ts:97, :706, :709, :1424` — the two wiring sites.
- `scripts/check-tiler-lazy.mjs` (253 lines, entirely about wasm-vips) and `scripts/check-viewer-deps.mjs:52, :67`.
- `.github/workflows/ci.yml:26-35` — the two dedicated fence steps.
- `apps/editor/src/service-worker.ts:30-66, :160-162` — ADR-0019 fence 5 and its justification.
- `THIRD-PARTY-NOTICES.md:19-76` — the LGPLv3 entry, its 20-library table, and the **outstanding open item**
  at `:52`/`:59` (the LGPLv3 text was never fetched and committed).

## Contract

**No `.wasm` file is shipped by either app.** Both `vips._dmTUXFO.wasm` and its byte-identical worker
duplicate (5,084,535 bytes each) and the 79 KB `vips-es6` glue are gone. `wasm-vips` is removed from
`apps/editor/package.json:23`, `packages/core/package.json:34`, and `pnpm-workspace.yaml:116`.

**The cap is `MEASURED_DECODE_CEILING_PIXELS` (528,006,700), not 268,435,456.** v1 ticket 05 line 415
warns precisely that 2^28 is a routing number and must not be reused as a cap. This *raises* what a user
can ingest: a 300 MP scan both measured engines decode is refused today only because a streaming route
exists in principle. The new number must be justified in a comment by the measurement that produced it —
Chromium decoded 536.0 MP and refused 536.9 MP; Firefox decoded 528.0 MP and also caps a side at 65535.

**Safari's ceiling remains unmeasured and must stay recorded as such** (`decode-ceiling.ts:34-36`). Do not
quietly imply it was measured. It was not, and this ticket does not measure it.

**The refusal message stops naming COOP, COEP, or cross-origin isolation.** It must name the image's size
and the remedy — convert it to a IIIF pyramid outside the browser. The existing e2e asserts on the old
wording (`e2e/editor-image-ingest.e2e.ts:337-351`, which checks for "Cross-Origin-Embedder-Policy") and
must be rewritten to assert the new one, still on text.

**The format error must keep not blaming the wrong thing.** `ingest.test.ts:326-343` exists so a TIFF
under the cap fails as unreadable-format rather than too-large. Nothing here changes that, and the test
must still pass — a 100 MP TIFF fails today regardless, because it never reached libvips anyway.

**The LGPLv3 obligation is discharged by removal, and the open item goes with it.** Delete the entry and
its table from `THIRD-PARTY-NOTICES.md`. Confirm no remaining dependency reintroduces LGPL; do not simply
assume the table was only ever about vips.

**An ADR records the decision.** ADR-0003 mandates streaming via `wasm-vips` and specifies the
single-threaded build (which does not exist on npm); ADR-0019 forbids `apps/viewer` depending on it. Write
a new ADR superseding ADR-0003's streaming clause. It must carry the measurement that justifies this: that
COOP/COEP is unavailable on the deployment target, that without it `Vips()` hangs forever after a pthread
`DataCloneError` (Chromium 151, Firefox 153), and that the path was therefore never reachable.

**The viewer fence stays.** `scripts/check-viewer-deps.mjs` still forbids `terra-draw`; only the
`wasm-vips` name and core's devDependency allowance come out. Do not delete the script.

## Out of scope

- **Do not add a COOP/COEP service worker.** You will be in `service-worker.ts` and it will look like the
  obvious way to keep libvips instead. It is a site-wide restriction on how the page may load other
  origins' files, it risks referenced IIIF tiles and the Base Map archive, and it is a human's open
  decision recorded in v1 ticket 18 and fenced out by workspace SPEC.md:362 and tickets 10 and 11.
- **Do not measure Safari.** Record it as unmeasured, as the code already does.
- **Do not fix the AVIF / JPEG XL / JP2 / SVG header gap** (`decode-ceiling.ts:93-99`). Those formats skip
  the threshold check entirely and reach `createImageBitmap` at any declared size. Both measured engines
  refuse promptly rather than OOM, so it is a decode error rather than a dead tab. It is unchanged by this
  ticket and is not this ticket's to close.
- **Do not remove `readImageHeader` or `image-header.ts`.** It routes, but it also serves the plain decode
  path's size check.
- **Do not change the decode-and-crop tiler.** It is the path every user already takes.

## Acceptance criteria

- [x] `find apps/editor/build apps/viewer/build -name '*.wasm'` returns nothing.
- [x] `wasm-vips` appears nowhere in any `package.json`, `pnpm-workspace.yaml`, or lockfile entry.
- [x] An image between 268 MP and 528 MP ingests successfully and produces a correct level-0 pyramid —
      asserted on tile output, not on the absence of an error.
- [x] An image above 528 MP is refused with a message naming its size in megapixels and the IIIF remedy.
- [x] No user-facing string anywhere names COOP, COEP, cross-origin isolation, or `SharedArrayBuffer`.
- [x] A TIFF under the cap still fails as an unreadable format, not as too large.
- [x] `THIRD-PARTY-NOTICES.md` carries no LGPLv3 entry and no outstanding open item for one.
- [x] `scripts/check-tiler-lazy.mjs` is deleted and its two CI steps with it; `check-viewer-deps.mjs` still
      fails if `apps/viewer` gains `terra-draw`.
- [x] The new ADR supersedes ADR-0003's streaming clause and carries the measurement.
- [x] The editor build is materially smaller; record the measured before and after.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
find apps/editor/build apps/viewer/build -name '*.wasm' | tee /dev/stderr | wc -l   # expect 0
du -sh apps/editor/build                                                            # expect ~7.8M, was 18M
grep -rn "wasm-vips" --include=package.json --include=*.yaml .                      # expect no hits
pnpm exec playwright test e2e/editor-image-ingest.e2e.ts
pnpm test:e2e
```

**Mutation checks are mandatory in this epic, not advisory.** Prove the cap by raising an image over it and
confirming the refusal goes red when the cap is removed; prove the viewer fence still fails by adding
`terra-draw` to `apps/viewer/package.json` and confirming a non-zero exit, then restoring. This repo has
already shipped a fence that printed its success message unconditionally, and ticket 10's review found an
offline assertion that passed vacuously because the resource it claimed to prove was cached was never
requested. Assert the failing direction.

## Blocked by

- Ticket 11 — it is live in `service-worker.ts`, and this ticket rewrites that file's precache
  justification. Sequencing avoids a certain conflict.

## Closes

- **v1 ticket 05's open question**, which is held open solely on this decision. Its lines 240-263 list four
  options and state that "none of which is an implementer's call"; this is its option 3, now chosen.
- **v1 ticket 15's `[~]` criterion** (`:68`), where an over-ceiling IIIF source "meets the same wall ticket
  05 is held open for".

Update both when this lands. Do not leave them pointing at a decision that has been made.

## Outcome

Implemented 2026-08-07. `wasm-vips`, the streaming tiler, and `scripts/check-tiler-lazy.mjs` are gone;
`MAX_INGEST_PIXELS` is 528,006,700; [ADR-0027](../../../docs/adr/0027-no-streaming-tiler-in-v1.md)
supersedes ADR-0003's streaming clause.

### Measured, before and after

| | Before | After |
| --- | --- | --- |
| `apps/editor/build` | 17,581,608 bytes (18M) | 7,251,129 bytes (7.7M) |
| `.wasm` files in either build | 2, byte-identical at 5,084,535 | 0 |
| `wasm-vips` in manifests, workspace catalog, lockfile | present | absent |

10,330,479 bytes, 59% of the editor's build. 936 lines deleted across four files: `libvips-loader.ts`
(55), `streaming-tiler.ts` (242), `streaming-tiler.test.ts` (385), `check-tiler-lazy.mjs` (254).

Full gate green: `pnpm -r build`, `pnpm test` (1372 unit + 26 script), `pnpm lint`, `pnpm check`, and
`pnpm test:e2e` at 399 passed / 1 flaky / 1 skipped, a retry rate of 0.25% against the 0.50% budget.

The one flake is `editor-stored-image-pane.e2e.ts:342`, which this ticket does not touch: it timed out
waiting for the second of two `layer-row`s. A browser vitest suite was running on the same machine at
that moment, which is this agent's doing rather than the suite's. Re-run alone, that spec is 6 of 6
green with no retries. Recorded rather than waved away, because it exercises ingest and this ticket
changed ingest.

### Mutation checks

**Run expecting to be wrong, and one of them was.** Each mutation was applied, the named suite run,
and the tree restored and re-run green.

| Mutation | Expected | Result |
| --- | --- | --- |
| Cap check removed from `ingest.ts` | refusals go red | 3 unit tests red; `editor-image-ingest.e2e.ts` red |
| `MAX_INGEST_PIXELS` lowered to 2^28 | the *widening* goes red | 4 unit tests red; **both** ingest e2e tests red, including the one that says a 300 MP file is not refused for its size |
| Plan refusal disabled in `mirror.ts` | the copy refusal goes red | `editor-mirroring.e2e.ts` red |
| `terra-draw` added to `apps/viewer/package.json` | non-zero exit | exit 1, names `@ballastella/viewer → dependencies.terra-draw` |
| `terra-draw` added to `packages/core/package.json` | non-zero exit via the transitive hop | exit 1, names `@ballastella/core → dependencies.terra-draw` |
| `region.x + 256` in the **fallback** `createImageBitmap` branch of `decode-and-crop-tiler.ts` | tile-pixel test goes red | **stayed green** — see below |
| `region.x + 256` in the **`resizeWidth`** branch | tile-pixel test goes red | red in Chromium and Firefox, reporting "read 13.0, expected 2" |

**The green mutation is not a hole in the test, and is recorded because it looked like one.** Both
measured engines support `createImageBitmap`'s `resizeWidth`, so the non-resizing branch beneath it is
unreachable in Chromium 151 and Firefox 153 — no test in this repository can turn it red on this
machine, and it exists for an engine that does not offer the option. The mutation on the branch that
*does* run fails loudly, in both engines.

### Criterion 3, and where it is actually asserted

"Asserted on tile output, not on the absence of an error" is met in
`packages/core/src/tiler/decode-and-crop-tiler.browser.test.ts`, in **real browsers on real pixels**: a
20,000 × 15,000 (300 MP) PNG in flat 256×256 blocks whose value is a function of tile row and column,
decoded for real, with five scale-factor-1 tiles — both ragged margins and the far corner — cut and
their centre pixels checked against the block they must have come from. A tiler cropping the wrong
rectangle produces a valid JPEG of the wrong value, which is the failure the assertion can see.

The fixture is built rather than committed, and costs little: 300 MB of pixels never exist at once
because there are only 59 distinct scanlines, written repeatedly into a `CompressionStream`. Measured
2026-08-07 — build 6.2 s / decode 3.2 s in Chromium 151, build 3.4 s / decode 2.0 s in Firefox 153,
about 25 ms per tile, PNG 2.3 MB.

Two supporting assertions, neither of which is the criterion on its own: `ingest.test.ts` drives a
500 MP image through the whole job against a stub tiler and checks **every** planned tile is written at
the path and geometry the plan names, and `editor-image-ingest.e2e.ts` shows the shipped app not
refusing a 300 MP file for its size. A real 300 MP ingest end to end is 6,270 tiles and minutes of
work, which is why it is not in the e2e suite.

### Decisions worth knowing

- **`mirror.ts` was in scope beyond the ticket's "Where to start".** Its plan named `SharedArrayBuffer`
  in a user-facing note — an acceptance criterion — and promised a copy "needs the streaming tiler",
  which was never true on this deployment. It now **refuses** above the same cap, on both paths, before
  a byte is fetched. Both of its effective caps rose from 268 MP to 528 MP, so no copy that previously
  succeeded is now refused.
- **The ADR-0008 ~1 GB hosting warning is no longer reachable from a single offline copy.** At
  0.7 bytes per pixel the largest copy the cap admits is about 370 MB. The cliff is a Workspace total
  and always was, so `editor-mirroring.e2e.ts` now seeds the Workspace to 700 MB with an OPFS
  `truncate` — real bytes through `crossesHostingLimit`, no transfer — and uses a 520 MP fixture.
- **`MEASURED_DECODE_CEILING_PIXELS` and `MAX_INGEST_PIXELS` are equal today and that is deliberately
  not asserted**, because `decode-ceiling.ts` keeps them apart precisely so a margin or a Safari
  measurement can move one without the other.
- **One rule for absence assertions, written down in `e2e/editor-pwa.e2e.ts`** and applied to all five
  sites of that shape: keep it when a plausible one-line change would make the name appear again,
  delete it when nothing could. The `.wasm` precache assertion was briefly deleted under the opposite
  reading and is restored.
- **No remaining dependency is GPL or LGPL** — checked by reading the `license` field of all 291
  installed manifests, not assumed.

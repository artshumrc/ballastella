# Tracker for ballastella-v1

## Purpose

This document tracks the status of all tickets in the epic. The goal of `ballastella-v1` is to deliver the first release of Ballastella: a browser application that aligns historical maps onto the modern world and annotates them, storing all work as standard-format files in a folder the user owns, and publishing that folder as a static website. Scope, decisions, and testing approach are defined in [SPEC.md](./SPEC.md); the reasoning behind individual decisions is in [docs/adr](../../docs/adr), and vocabulary is in [CONTEXT.md](../../CONTEXT.md).

## Current Status

Overall status: `In Progress`

Current ticket: 10 and 15 are in progress, and remediation of the 05/06, 07/08 and 09 reviews is in flight. Tickets 01–09, 12, 13, and 14 are merged; ticket 05 is green but is `Needs Human Validation or Intervention` (open question 3). Ticket 11 unblocks when 10 lands; 16 needs 10.

The tree runs **767 unit tests (plus 15 live-network tests skipped by default) and 142 e2e**, with lint, typecheck, build, and the ADR-0006 fence all clean.

**Correction, recorded because it was reported as a passing check several times and was not one.** Ticket 05's acceptance command `grep -rl "wasm-vips" apps/editor/build/_app/immutable/entry/` prints its success message **unconditionally**: the string `wasm-vips` appears nowhere in the built output, because the bundler renames the chunk to `_app/immutable/workers/vips-es6-*.js`. It also inspects only `entry/`, not the chunks the entry statically imports. The dependency genuinely *is* lazy — the only reference is an `await import(...)` — and `e2e/editor-image-ingest.e2e.ts` asserts that soundly by watching the network. But the grep is not what establishes it, and a real static check is owed. See ticket 05's follow-ups.

Ticket 12 passed ticket 02's shared adapter suite with **zero changes to the suite**, which is the outcome ADR-0001 was aiming for: a picked `FileSystemDirectoryHandle` and the OPFS root turned out to be the same interface, so the byte path is now shared by both backends via `directory-handle-store.ts`.

**Eight items need a human — see [Open questions for a human](#open-questions-for-a-human)** — plus [ticket 19](./tickets/19-upstream-allmaps-fetchfn-fix.md), which is human-only. Items 3 and 4 still constrain what v1 can claim. Item 5 is resolved locally by a patch; ticket 19 is what removes it.

### A note on how much to trust a green ticket

Worth recording, because it has held on every ticket so far. Each implementing agent reported all acceptance criteria passing, and the code reviews then found substantive defects anyway — including data loss in tickets 02, 04, and 13, and **three of ticket 02's criteria passing vacuously** (delete the code under test and the tests stayed green). Remediation in turn refuted several reviewer claims with harder evidence, and twice found defects *neither* the implementer nor the reviewer had seen: the `open()` keystroke-dropping race in ticket 02, and fflate's 16-bit entry count in ticket 13. Reviews caught what implementers missed; remediation caught what reviewers got wrong. **Neither layer alone was sufficient on any ticket.** Treat "the agent says the criteria pass" as a weak signal, and prefer the mutation check — break the behaviour, confirm the test goes red — which is what caught the vacuous tests in every case.

Last updated: 2026-08-06

## Ledger

`Fulfills` lists the [SPEC.md](./SPEC.md) user stories a ticket delivers. A number in *italics* is shared with another ticket and is not complete until all of them land; a number in **bold** is only partly delivered — see [User story coverage](./SPEC.md#user-story-coverage) for what is missing.

| Number | Filename | Status | Depends On | Fulfills |
| --- | --- | --- | --- | --- |
| 01 | [01-monorepo-skeleton-and-toolchain.md](./tickets/01-monorepo-skeleton-and-toolchain.md) | Completed | — | 102 |
| 02 | [02-workspace-and-project-lifecycle.md](./tickets/02-workspace-and-project-lifecycle.md) | Completed | 01 | *4*, *7*, 10, 11, 12, 73, 74, 75, 76, *77*, 97 |
| 03 | [03-image-pane-synthetic-projection.md](./tickets/03-image-pane-synthetic-projection.md) | Completed | 01 | — (groundwork for 31) |
| 04 | [04-base-map-pane-and-catalog.md](./tickets/04-base-map-pane-and-catalog.md) | Completed | 01 | 68, 69, *72*, *98*, 100, *101* |
| 05 | [05-local-image-to-level-0-pyramid.md](./tickets/05-local-image-to-level-0-pyramid.md) | Needs Human Validation or Intervention | 02 | 21, 23, **22** |
| 06 | [06-injection-layer-local-tiles-to-renderers.md](./tickets/06-injection-layer-local-tiles-to-renderers.md) | Completed | 03, 05 | 31 |
| 07 | [07-alignment-control-point-pairing.md](./tickets/07-alignment-control-point-pairing.md) | Completed | 04, 06 | 30, 32, 33, 34, 35, 36, 37, 91, *94* |
| 08 | [08-alignment-refinement.md](./tickets/08-alignment-refinement.md) | Completed | 07 | 39, 40, 41, 42, 43, 44, 45, 46, 47 |
| 09 | [09-layers.md](./tickets/09-layers.md) | Completed | 07 | *29*, 49, 50, 51, 52, 53, 54, *55*, *56* |
| 10 | [10-annotations.md](./tickets/10-annotations.md) | In Progress | 09 | *55*, *56*, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, *94* |
| 11 | [11-single-level-undo.md](./tickets/11-single-level-undo.md) | Not Started | 08, 10 | 38 |
| 12 | [12-file-system-access-adapter.md](./tickets/12-file-system-access-adapter.md) | Completed | 02 | 1, 2, 3, *4*, *7* |
| 13 | [13-zip-export-and-import.md](./tickets/13-zip-export-and-import.md) | Completed | 02 | 5, 13, 14, *56*, *87*, *93*, *94* |
| 14 | [14-remote-iiif-ingest.md](./tickets/14-remote-iiif-ingest.md) | Completed | 09 | 16, 17, 18, 19, 20, 24, 25, 26, 48 |
| 15 | [15-mirroring-offline-copies.md](./tickets/15-mirroring-offline-copies.md) | In Progress | 05, 14 | *15*, 27, 28 |
| 16 | [16-publish.md](./tickets/16-publish.md) | Not Started | 09, 10 | *15*, *29*, 78, 79, 80, 81, *82*, *87*, 88, 89, 90, 92, *93*, 99, *101* |
| 17 | [17-viewer-read-only-exploration.md](./tickets/17-viewer-read-only-exploration.md) | Not Started | 16 | 70, 71, *72*, *77*, *82*, 83, 84, 85, 86, *98* |
| 18 | [18-pwa-manifest-and-service-worker.md](./tickets/18-pwa-manifest-and-service-worker.md) | Not Started | 16 | 6, 8, 9 |
| 19 | [19-upstream-allmaps-fetchfn-fix.md](./tickets/19-upstream-allmaps-fetchfn-fix.md) | Needs Human Validation or Intervention | 06 | — (protects 30, 32–37, 78–92) |

**Ticket 19 is human-only and must not be assigned to an agent** — it means opening a pull request against a third-party repository, engaging its maintainers, and judging which of several fixes they should accept. It is numbered as a ticket rather than left as an open question because it has steps, acceptance criteria, and a definite end: the local `@allmaps/render` patch is deleted. Without an owner that patch becomes permanent debt that every `@allmaps/*` bump silently re-risks.

Stories **95 and 96** are deliberately absent from the table. Accessibility is a criterion inside every ticket that adds UI rather than a slice of its own (see Cross-cutting constraints below), so attributing them to any one ticket would be misleading in both directions. Story 97 is listed against ticket 02 because that is where the `<dialog>` + `showModal()` rule is established and asserted; later tickets reuse it. Every other story appears at least once.

## Open questions for a human

Raised by the code reviews of tickets 02–04 and 12–13, and by tickets 05, 06, and 07 in implementation. None is a defect an implementer can decide away.

1. **What is the canonical instance URL?** `BALLASTELLA_CANONICAL_URL` in `packages/core/src/project/project-file.ts` is currently `https://artshumrc.github.io/ballastella/`, derived from the git remote because nothing in the repo records one. ADR-0010 requires the format-refusal message to name a URL, and this is the one string a user reads at the moment their work is at risk. Two problems: it 404s unless Pages is enabled on that repo with no custom domain, and [ADR-0006](../../docs/adr/0006-relative-asset-paths.md) says we cannot know at build time whether a deployment lives at a subpath or a domain root — so a compile-time constant is wrong on every fork until hand-edited. Decide the value, or decide it must be deployment configuration with a guard like ADR-0020's catalog lint rule.

2. **Should the Playwright suite run on Firefox and WebKit too?** Largely resolved during remediation, and the premise the review started from turned out to be stale: `FileSystemFileHandle.move()` is **no longer Chromium-only** — Playwright's Firefox 153 has it. So the ProjectStore adapter suite now runs in both Chromium and Firefox (`packages/core/vitest.config.ts`, and CI installs both), and the in-place-overwrite fallback is covered by a test that hides `move` the way Safari still does. What remains is purely a CI cost decision: the **Playwright** suite is still Chromium-only, so the app's UI is unasserted on other engines even though the storage layer is not. Story 4 is no longer claimed-and-untested; it is claimed and tested at the layer where it can silently corrupt data.

3. **`wasm-vips` cannot run where ADR-0003 needs it to, so images above ~268 MP cannot be ingested on a static host.** This is the one item in the epic so far that an implementer could not decide away, and it is why ticket 05 is `Needs Human Validation or Intervention` rather than `Completed`.

   npm publishes **only the threaded `wasm-vips` build**, which requires `SharedArrayBuffer` and therefore COOP/COEP headers — the headers GitHub Pages cannot send, which is exactly why [ADR-0003](../../docs/adr/0003-every-image-is-tiled-client-side.md) mandates the single-threaded build. **No published artefact of that build exists.** Measured on 2026-08-05: with COOP+COEP it initialises (libvips 8.18.3); without them `Vips()` never settles at all — it hangs in Chromium 151 and Firefox 153 after a `DataCloneError` from the pthread worker.

   Nothing was improvised around it: the loader refuses up front when `crossOriginIsolated` is false (so nothing hangs), ingest refuses an over-threshold image when no streaming tiler is supplied, and the vips tiler's geometry is fully asserted against real libvips in the Node project. **Everything at or below the threshold works and is green.** Story 22 is therefore partly delivered — hence **22** in bold in the ledger.

   Options are laid out in the ticket: vendor a single-threaded build, ship a COI service worker, drop streaming from v1, or something else. Each has consequences for tickets 14 and 18 and for the LGPLv3 obligation. **Ticket 06 is not blocked by this** — it needs the pyramid format and the injection layer, both of which exist.

4. **`fflate`'s zip writer has no zip64, so export now refuses a Project of more than 65,535 files.** Found during ticket 13's remediation, by an agent verifying a different finding — **not by either code review.**

   fflate counts entries in 16 bits. Measured: exporting 70,000 entries produced an archive whose index claimed `70000 & 0xffff` = **4,464** files, and `unzipSync` read it back as 4,464 files **with no error at all** — a plausible-looking zip missing 94% of a pyramid, on ADR-0001's only-way-out and story 94's deposit path. SPEC puts "tens of thousands of files" on a single 2 GB pyramid, so this is reachable, not theoretical.

   `exportProjectZip` now refuses with `ProjectTooLargeToZipError`, naming the folder Workspace as the way out. That is honest but it means **a legitimately large Project is un-exportable for exactly the Firefox, Safari, and iPad users for whom zip is the only way out** — the users ADR-0001 built this path for. The real fix is zip64 in the writer: either fflate gains it, or the central directory is written here. Related and also open: import holds the whole compressed archive in the JS heap, so a ~400 MB export cannot be re-imported on an iPad (recorded in ticket 13 with two fix shapes — `File.slice()`, or a quarantine directory).

5. **An upstream `@allmaps/render` bug blocked warped rendering, ticket 07's central act — now patched locally, and [ticket 19](./tickets/19-upstream-allmaps-fetchfn-fix.md) owns getting it upstream.** Found by ticket 06.

   `@allmaps/render@1.0.0-beta.83` passes `fetchFn` into a Comlink worker **unproxied** — the abort callback in the very same argument list *is* wrapped in `Comlink.proxy()` — and `postMessage` cannot clone a function. Verified in Chromium against a real ingested pyramid: `addGeoreferencedMap` succeeds and the layer reports bounds, then **every tile fails with `DataCloneError`**, naming our own ADR-0011 shim as the unclonable object. Upstream logs and swallows it, so **the symptom is a blank warped map with nothing surfaced.**

   **RESOLVED locally on 2026-08-06 by `patches/@allmaps__render@1.0.0-beta.83.patch`.** Tiles now arrive: `e2e/editor-warped-fetch.e2e.ts` asserts `cachedTiles > 0` — bytes fetched *and* decoded — rather than an absence of console errors, because the pre-patch failure *was* a swallowed error and a console-only check went green while the map rendered blank.

   Note the fix is **not** the one line it appears to be, and this is worth knowing before anyone touches it. Wrapping `fetchFn` in `proxy()` trades `DataCloneError` for `TypeError("Unserializable return value")`, because the worker's `fetchUrl` does `await fetchFn(...)` and expects a `Response` — which is not structured-cloneable either. The patch instead runs a custom `fetchFn` on the main thread, where the closure lives, and hands the worker a `blob:` URL, keeping the decode off the main thread.

   `scripts/check-allmaps-patch.mjs` (in `pnpm lint` and CI) fails the build if the patch stops applying, is stale, or names a version other than the one installed — verified against all three failure modes. It exists because `@allmaps/render` arrives *transitively* through `@allmaps/maplibre`, so bumping maplibre moves render underneath us, and the failure is silent.

   **What remains for a human is [ticket 19](./tickets/19-upstream-allmaps-fetchfn-fix.md): upstream the fix and delete our patch.** Until that lands, every `@allmaps/*` bump — already an ADR-0010 migration event — must re-verify the patch.

6. **The two licence texts still do not ship** — now three, with LGPLv3. OFL 1.1 and BSD-3-Clause both require the text to accompany redistribution, and neither is in this repository or in `node_modules` — `@protomaps/basemaps` ships no `LICENSE`, and substituting `maplibre-gl`'s BSD text would fabricate an attribution to the wrong copyright holder. Recorded in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) under "Open: two licence texts do not ship"; the texts must be fetched from upstream by a human.

7. **[ADR-0013](../../docs/adr/0013-transformation-types.md) says to store the explicit `polynomial1`, and that string cannot be written.** Found by ticket 07 and asserted there, so nothing is broken — but the ADR now says something the code cannot do, and an ADR that contradicts the code is worse than one that is silent.

   `@allmaps/annotation@1.0.0-beta.37`'s Zod enum has no `polynomial1` member, and its `.or()` fallback is unreachable dead code because `parseIfValid` always succeeds first. So `generateAnnotation` writes **no transformation at all**, and parsing a file that contains `polynomial1` returns `undefined`. Ticket 07 instead writes `{ type: 'polynomial', options: { order: 1 } }` through upstream's own `transformationTypeToTypeAndOrder`, which round-trips and reads back as exactly `polynomial1` — so the *behaviour* ADR-0013 wants holds, via a different serialisation than it names.

   Reword the ADR to describe the `{ type, options.order }` form as the wire representation, or record why the literal is required and treat the upstream gap as a blocker. Do not leave the ADR reading as though the literal is what ships.

8. **[ADR-0005](../../docs/adr/0005-maplibre-and-terra-draw.md) mandates `terra-draw` for all drawing, and two tickets have now deliberately declined it — the ADR needs amending or superseding, and that is a person's call.** An amendment is being drafted for your ratification; do not treat it as settled.

   ADR-0005 says "All drawing and editing — control points, resource masks, and annotations — goes through `terra-draw`". [SPEC.md](./SPEC.md) repeats it, and ticket 10's *Where to start* claims the dependency "arrived in ticket 07". **None of that is true**: `terra-draw` is in no manifest and no source file. Tickets 07 and 08 both chose ticket 03's `overlayPoints` seam instead, and a third-party reviewer independently endorsed the call.

   The decisive reason is not preference: **terra-draw edits inside MapLibre GL layers, and a WebGL canvas is not focusable per-feature**, so anything it drew would be the app's first mouse-only editable object — against a standing accessibility criterion. `overlayPoints` gives real `<button>` elements with names, arrow-key movement and Delete. Three lesser reasons compound it: per-coordinate change events against ADR-0017 rule 1, synthetic lng/lat escaping the image pane against ADR-0005's own projection rule, and ADR-0019's dependency cost.

   Ticket 10 may still choose terra-draw for annotations — free-form geometry over real geography is the case it is actually for — so the amendment should record Control Points and the Resource Mask as settled and leave annotations open. **What must not persist is a repository whose ADR and spec mandate a library it does not contain**, which is how the next contributor is misled.

## Sequencing notes

Ticket 01 is a prefactor and must land first: it fixes the commands (`pnpm -r test`, `pnpm test:e2e`, and the rest) that every other ticket's acceptance criteria are written against. In a greenfield repo nothing else can have runnable criteria until it exists.

**After 01, three tickets run in parallel: 02, 03, and 04.** Ticket 03 is deliberately unblocked by the storage work so the project's largest unknown can be attacked immediately — see below. The long pole is 01 → 04 → 07 → 09 → 10 → 16 → 17.

### The four risk items, and where they live

The spec's build order is dictated by risk, not feature order. Each of these produces a number or a validation that later tickets depend on:

1. **The synthetic projection for the image pane** — ticket 03. The largest unknown, and its failure is *silent*: Control Points that drift as the user zooms. Must land with a numeric pixel → lng/lat → pixel round-trip assertion at every zoom level. Visual confirmation does not satisfy it.
2. **The `createImageBitmap` decode ceiling** — ticket 05. **MEASURED: 528,006,700 pixels** (Firefox 153.0 decoded 26533×19900 and refused 26733×20050; Chromium 151.0.7922.34 decoded 26733×20050 = 535,996,650 and refused 32767×16384). Linux x86-64, 62 GiB RAM, 2026-08-05. Method: all-zero greyscale PNGs — which compress to nothing but force a full-size bitmap allocation — through `createImageBitmap(blob)`, binary-searched between last success and first failure, a fresh browser process per probe, each bitmap sampled at its far corner so a lazy decode could not pass. Both engines refuse in 3–15 ms with no allocation attempt, so it is a **hard cap, not host memory** — 2^29 px is exactly 2 GiB at 4 B/px. Threshold set at 2^28 = 268,435,456 px; the margin is argued in `packages/core/src/tiler/decode-ceiling.ts`. **WebKit's ceiling is unmeasured.**
3. **A generated `info.json` validated against Allmaps end to end** — ticket 05. **DONE, against the real Allmaps editor:** a 29-tile pyramid from the shipped `ingestImageFile`, served at an HTTPS origin with the `id` stamped, was opened in `editor.allmaps.org` in Chromium 151. Allmaps parsed the `info.json`, derived tile requests from `tileZoomLevels` itself, fetched 6 tiles at scale factor 2 — all 200, zero 404s, including the ragged `1024,0,176,512/88,256` — and rendered the map correctly. `manifest.json` also loaded standalone. Caveat: Allmaps refuses non-HTTPS IIIF URLs and Chrome blocks public→loopback fetches, so the transport was a Playwright route on a public-looking origin; everything above the transport was Allmaps' own code.
4. **`@allmaps/*` fixture round-trips** — ticket 07. Every one of those packages is pre-1.0, so this test is what stands between a beta bump and every Alignment in the field being subtly misplaced.

### Cross-cutting constraints

These will otherwise be rediscovered, or missed, per ticket:

- **`ProjectStore` is built OPFS-first**, before the File System Access adapter (ticket 12), so the abstraction is not shaped around one backend (ADR-0001). Ticket 12 must pass ticket 02's shared adapter suite *unchanged*; needing to widen the interface is a signal the interface was wrong, not that the adapter is special.
- **`apps/viewer` must never depend on `terra-draw`, the tiler, or `wasm-vips`** (ADR-0019). Ticket 01 adds a CI check; treat it as a standing review item, not a one-off.
- **`maplibre-gl` is held at `^5`, and raising it is a migration event.** Tickets 03 and 04 were built in parallel and disagreed: 03 used `^6.1.0`, 04 found that v6 computes its worker URL from `import.meta.url` at runtime so the built app 404s and the map never loads. Settled at `^5.24.0` on merge, which is also the peer range `@allmaps/maplibre` and `@allmaps/basemap` declare — **ticket 07 needs those, and two MapLibre copies in one page is a broken map, not a warning.** Ticket 03's projection round-trip was re-verified against v5 after the merge.
- **The Playwright suite is flaky under its own parallelism, and this needs attention before it grows.** Measured on the wave-3 tree (68 tests, 7 workers): a flake in roughly one full run in three, and **not the same test twice** — observed so far in `editor-workspace.e2e.ts` "pagehide flushes a write that is still inside its debounce window" (a `NotReadableError` from the test's OPFS read racing the app's temp-file→move) and `editor-base-map.e2e.ts` "changes the Base Map flavor in the same action as the interface". Neither reproduces in isolation at `--repeat-each=10 --workers=6`, which points at resource contention — every worker drives a real WebGL map and real OPFS — rather than a defect in either test. `retries: 1` means CI goes green, which is exactly why this is recorded: **a suite that flakes is a suite that can absorb a real race without anyone noticing**, and tickets 06–11 all add map-driven e2e. Cap workers or serialise the map-heavy projects before that.
- **`terra-draw` has not arrived, and two tickets have now declined it — a reviewer should confirm the call rather than let it accrete by default.** The spec names it for the Control Point pairing (ticket 07), the Resource Mask (ticket 08), and annotations (ticket 10). Tickets 07 and 08 both chose ticket 03's `overlayPoints` seam instead, independently and for the same load-bearing reason: **terra-draw edits inside WebGL layers, which are not focusable**, so anything it draws would be the first mouse-only editable object in the app — against a standing accessibility criterion. Three lesser reasons compound it: the seam commits once on gesture end where terra-draw's change events fire per coordinate (ADR-0017 rule 1); its store would hold *synthetic* lng/lat, the geography ADR-0005 says must not escape the image pane; and ADR-0019 counts the dependency cost. Ticket 08's own view is that **annotations are the case terra-draw is actually for** — free-form geometry over real geography, not a four-vertex ring — so ticket 10 may well decide the other way, and should. **Note ticket 10's ticket file wrongly states terra-draw "arrived in ticket 07"**; that line is being corrected. If it is never added, ADR-0022 and the tickets that name it need rewording so the repo does not read as though a dependency it lacks is load-bearing.
- **The e2e flake rate tracks total machine load, not this suite's `workers`.** Capping Playwright at 4 removed the flakes when the suite ran alone (three consecutive clean runs, previously ~1 in 3). But a run taken while four sibling agents were building and driving browsers produced **5 flaky out of 142 and took 4.8 minutes instead of ~30 seconds** — every one green on retry. So the cap is necessary but not sufficient: on a loaded machine the contention is cross-process. Do not read a flake under load as a regression, and do not raise `workers` on the strength of a quiet run.
- **A Playwright config outside the repository silently breaks in two ways**, which is worth knowing because running on isolated ports is the standard workaround when several agents share a machine. `testDir` and the `webServer` `cwd` both resolve against the *config file's* directory, so `pnpm --filter …` runs where there is no workspace and Playwright reports only "Process from config.webServer exited early". Pin `testDir` to an absolute path and set `cwd` explicitly.
- **Two e2e files still count Historical Maps with a bare `getByRole('listitem')`**, so any new list on the Project page breaks them. Ticket 08 hit this and routed around it with a `<div>` of `<p>`s rather than churn files a parallel slice was editing; ticket 09's Layer list could not avoid being a list. Fix the locators rather than contorting markup — this is a trap that will keep firing as tickets 10 and 11 add UI.
- **Accessibility is an acceptance criterion inside every ticket that adds UI**, not a slice of its own. Keyboard reach, focus management, announced status, and ADR-0016's mandated component methods. A single accessibility pass at the end reliably becomes a graveyard.
- **Autosave lands in ticket 02**, not late, so tickets 05–15 do not each improvise their own saving and then get retrofitted — which is how ADR-0017's atomic-write rule quietly fails to happen.
- **Format migration is deliberately not a ticket.** Ticket 02 writes `formatVersion` and implements the *refusal* of anything newer, which is the part that protects users from old forks. Migration machinery with zero migrations would be speculative and untestable; the first real format change brings its own ticket.
- **Markdown sanitisation is asserted twice** — in ticket 10 where it is written, and again in ticket 17 where the viewer runs on the user's own domain. It is the one place in this epic where a bug is a security vulnerability rather than a defect.
- **User-story traceability is bidirectional and must be kept so.** The ledger's `Fulfills` column and each ticket's `Fulfills` line record the same mapping from two directions; changing a ticket's scope means updating both, and the partial-coverage table in SPEC's [User story coverage](./SPEC.md#user-story-coverage) section. The story numbers in SPEC.md are load-bearing identifiers — **renumbering them silently invalidates every reference in this epic.**

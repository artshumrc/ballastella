# Tracker for ballastella-v1

## Purpose

This document tracks the status of all tickets in the epic. The goal of `ballastella-v1` is to deliver the first release of Ballastella: a browser application that aligns historical maps onto the modern world and annotates them, storing all work as standard-format files in a folder the user owns, and publishing that folder as a static website. Scope, decisions, and testing approach are defined in [SPEC.md](./SPEC.md); the reasoning behind individual decisions is in [docs/adr](../../docs/adr), and vocabulary is in [CONTEXT.md](../../CONTEXT.md).

## Current Status

Overall status: `In Progress`

Current ticket: 06 is in progress. Tickets 12 and 13 are reviewed and remediated; ticket 05 is merged and green but is `Needs Human Validation or Intervention` — see open question 3.

The tree runs **475 unit tests and 82 e2e**, with lint, typecheck, build, the ADR-0006 fence, and the `wasm-vips`-is-lazy and viewer-carries-no-vips checks all clean.

Ticket 12 passed ticket 02's shared adapter suite with **zero changes to the suite**, which is the outcome ADR-0001 was aiming for: a picked `FileSystemDirectoryHandle` and the OPFS root turned out to be the same interface, so the byte path is now shared by both backends via `directory-handle-store.ts`.

**Five items need a human — see [Open questions for a human](#open-questions-for-a-human).** Items 3 and 4 constrain what v1 can claim; none blocks ticket 06.

### A note on how much to trust a green ticket

Worth recording, because it has held on every ticket so far. Each implementing agent reported all acceptance criteria passing, and the code reviews then found substantive defects anyway — including data loss in tickets 02, 04, and 13, and **three of ticket 02's criteria passing vacuously** (delete the code under test and the tests stayed green). Remediation in turn refuted several reviewer claims with harder evidence, and twice found defects *neither* the implementer nor the reviewer had seen: the `open()` keystroke-dropping race in ticket 02, and fflate's 16-bit entry count in ticket 13. Reviews caught what implementers missed; remediation caught what reviewers got wrong. **Neither layer alone was sufficient on any ticket.** Treat "the agent says the criteria pass" as a weak signal, and prefer the mutation check — break the behaviour, confirm the test goes red — which is what caught the vacuous tests in every case.

Last updated: 2026-08-05

## Ledger

`Fulfills` lists the [SPEC.md](./SPEC.md) user stories a ticket delivers. A number in *italics* is shared with another ticket and is not complete until all of them land; a number in **bold** is only partly delivered — see [User story coverage](./SPEC.md#user-story-coverage) for what is missing.

| Number | Filename | Status | Depends On | Fulfills |
| --- | --- | --- | --- | --- |
| 01 | [01-monorepo-skeleton-and-toolchain.md](./tickets/01-monorepo-skeleton-and-toolchain.md) | Completed | — | 102 |
| 02 | [02-workspace-and-project-lifecycle.md](./tickets/02-workspace-and-project-lifecycle.md) | Completed | 01 | *4*, *7*, 10, 11, 12, 73, 74, 75, 76, *77*, 97 |
| 03 | [03-image-pane-synthetic-projection.md](./tickets/03-image-pane-synthetic-projection.md) | Completed | 01 | — (groundwork for 31) |
| 04 | [04-base-map-pane-and-catalog.md](./tickets/04-base-map-pane-and-catalog.md) | Completed | 01 | 68, 69, *72*, *98*, 100, *101* |
| 05 | [05-local-image-to-level-0-pyramid.md](./tickets/05-local-image-to-level-0-pyramid.md) | Needs Human Validation or Intervention | 02 | 21, 23, **22** |
| 06 | [06-injection-layer-local-tiles-to-renderers.md](./tickets/06-injection-layer-local-tiles-to-renderers.md) | In Progress | 03, 05 | 31 |
| 07 | [07-alignment-control-point-pairing.md](./tickets/07-alignment-control-point-pairing.md) | Not Started | 04, 06 | 30, 32, 33, 34, 35, 36, 37, 91, *94* |
| 08 | [08-alignment-refinement.md](./tickets/08-alignment-refinement.md) | Not Started | 07 | 39, 40, 41, 42, 43, 44, 45, 46, 47 |
| 09 | [09-layers.md](./tickets/09-layers.md) | Not Started | 07 | *29*, 49, 50, 51, 52, 53, 54, *55*, *56* |
| 10 | [10-annotations.md](./tickets/10-annotations.md) | Not Started | 09 | *55*, *56*, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, *94* |
| 11 | [11-single-level-undo.md](./tickets/11-single-level-undo.md) | Not Started | 08, 10 | 38 |
| 12 | [12-file-system-access-adapter.md](./tickets/12-file-system-access-adapter.md) | Completed | 02 | 1, 2, 3, *4*, *7* |
| 13 | [13-zip-export-and-import.md](./tickets/13-zip-export-and-import.md) | Completed | 02 | 5, 13, 14, *56*, *87*, *93*, *94* |
| 14 | [14-remote-iiif-ingest.md](./tickets/14-remote-iiif-ingest.md) | Not Started | 09 | 16, 17, 18, 19, 20, 24, 25, 26, 48 |
| 15 | [15-mirroring-offline-copies.md](./tickets/15-mirroring-offline-copies.md) | Not Started | 05, 14 | *15*, 27, 28 |
| 16 | [16-publish.md](./tickets/16-publish.md) | Not Started | 09, 10 | *15*, *29*, 78, 79, 80, 81, *82*, *87*, 88, 89, 90, 92, *93*, 99, *101* |
| 17 | [17-viewer-read-only-exploration.md](./tickets/17-viewer-read-only-exploration.md) | Not Started | 16 | 70, 71, *72*, *77*, *82*, 83, 84, 85, 86, *98* |
| 18 | [18-pwa-manifest-and-service-worker.md](./tickets/18-pwa-manifest-and-service-worker.md) | Not Started | 16 | 6, 8, 9 |

Stories **95 and 96** are deliberately absent from the table. Accessibility is a criterion inside every ticket that adds UI rather than a slice of its own (see Cross-cutting constraints below), so attributing them to any one ticket would be misleading in both directions. Story 97 is listed against ticket 02 because that is where the `<dialog>` + `showModal()` rule is established and asserted; later tickets reuse it. Every other story appears at least once.

## Open questions for a human

Raised by the code reviews of tickets 02–04 and 12–13, and by ticket 05's implementation. None is a defect an implementer can decide away.

1. **What is the canonical instance URL?** `BALLASTELLA_CANONICAL_URL` in `packages/core/src/project/project-file.ts` is currently `https://artshumrc.github.io/ballastella/`, derived from the git remote because nothing in the repo records one. ADR-0010 requires the format-refusal message to name a URL, and this is the one string a user reads at the moment their work is at risk. Two problems: it 404s unless Pages is enabled on that repo with no custom domain, and [ADR-0006](../../docs/adr/0006-relative-asset-paths.md) says we cannot know at build time whether a deployment lives at a subpath or a domain root — so a compile-time constant is wrong on every fork until hand-edited. Decide the value, or decide it must be deployment configuration with a guard like ADR-0020's catalog lint rule.

2. **Should the Playwright suite run on Firefox and WebKit too?** Largely resolved during remediation, and the premise the review started from turned out to be stale: `FileSystemFileHandle.move()` is **no longer Chromium-only** — Playwright's Firefox 153 has it. So the ProjectStore adapter suite now runs in both Chromium and Firefox (`packages/core/vitest.config.ts`, and CI installs both), and the in-place-overwrite fallback is covered by a test that hides `move` the way Safari still does. What remains is purely a CI cost decision: the **Playwright** suite is still Chromium-only, so the app's UI is unasserted on other engines even though the storage layer is not. Story 4 is no longer claimed-and-untested; it is claimed and tested at the layer where it can silently corrupt data.

3. **`wasm-vips` cannot run where ADR-0003 needs it to, so images above ~268 MP cannot be ingested on a static host.** This is the one item in the epic so far that an implementer could not decide away, and it is why ticket 05 is `Needs Human Validation or Intervention` rather than `Completed`.

   npm publishes **only the threaded `wasm-vips` build**, which requires `SharedArrayBuffer` and therefore COOP/COEP headers — the headers GitHub Pages cannot send, which is exactly why [ADR-0003](../../docs/adr/0003-every-image-is-tiled-client-side.md) mandates the single-threaded build. **No published artefact of that build exists.** Measured on 2026-08-05: with COOP+COEP it initialises (libvips 8.18.3); without them `Vips()` never settles at all — it hangs in Chromium 151 and Firefox 153 after a `DataCloneError` from the pthread worker.

   Nothing was improvised around it: the loader refuses up front when `crossOriginIsolated` is false (so nothing hangs), ingest refuses an over-threshold image when no streaming tiler is supplied, and the vips tiler's geometry is fully asserted against real libvips in the Node project. **Everything at or below the threshold works and is green.** Story 22 is therefore partly delivered — hence **22** in bold in the ledger.

   Options are laid out in the ticket: vendor a single-threaded build, ship a COI service worker, drop streaming from v1, or something else. Each has consequences for tickets 14 and 18 and for the LGPLv3 obligation. **Ticket 06 is not blocked by this** — it needs the pyramid format and the injection layer, both of which exist.

4. **`fflate`'s zip writer has no zip64, so export now refuses a Project of more than 65,535 files.** Found during ticket 13's remediation, by an agent verifying a different finding — **not by either code review.**

   fflate counts entries in 16 bits. Measured: exporting 70,000 entries produced an archive whose index claimed `70000 & 0xffff` = **4,464** files, and `unzipSync` read it back as 4,464 files **with no error at all** — a plausible-looking zip missing 94% of a pyramid, on ADR-0001's only-way-out and story 94's deposit path. SPEC puts "tens of thousands of files" on a single 2 GB pyramid, so this is reachable, not theoretical.

   `exportProjectZip` now refuses with `ProjectTooLargeToZipError`, naming the folder Workspace as the way out. That is honest but it means **a legitimately large Project is un-exportable for exactly the Firefox, Safari, and iPad users for whom zip is the only way out** — the users ADR-0001 built this path for. The real fix is zip64 in the writer: either fflate gains it, or the central directory is written here. Related and also open: import holds the whole compressed archive in the JS heap, so a ~400 MB export cannot be re-imported on an iPad (recorded in ticket 13 with two fix shapes — `File.slice()`, or a quarantine directory).

5. **The two licence texts still do not ship** — now three, with LGPLv3. OFL 1.1 and BSD-3-Clause both require the text to accompany redistribution, and neither is in this repository or in `node_modules` — `@protomaps/basemaps` ships no `LICENSE`, and substituting `maplibre-gl`'s BSD text would fabricate an attribution to the wrong copyright holder. Recorded in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) under "Open: two licence texts do not ship"; the texts must be fetched from upstream by a human.

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
- **Accessibility is an acceptance criterion inside every ticket that adds UI**, not a slice of its own. Keyboard reach, focus management, announced status, and ADR-0016's mandated component methods. A single accessibility pass at the end reliably becomes a graveyard.
- **Autosave lands in ticket 02**, not late, so tickets 05–15 do not each improvise their own saving and then get retrofitted — which is how ADR-0017's atomic-write rule quietly fails to happen.
- **Format migration is deliberately not a ticket.** Ticket 02 writes `formatVersion` and implements the *refusal* of anything newer, which is the part that protects users from old forks. Migration machinery with zero migrations would be speculative and untestable; the first real format change brings its own ticket.
- **Markdown sanitisation is asserted twice** — in ticket 10 where it is written, and again in ticket 17 where the viewer runs on the user's own domain. It is the one place in this epic where a bug is a security vulnerability rather than a defect.
- **User-story traceability is bidirectional and must be kept so.** The ledger's `Fulfills` column and each ticket's `Fulfills` line record the same mapping from two directions; changing a ticket's scope means updating both, and the partial-coverage table in SPEC's [User story coverage](./SPEC.md#user-story-coverage) section. The story numbers in SPEC.md are load-bearing identifiers — **renumbering them silently invalidates every reference in this epic.**

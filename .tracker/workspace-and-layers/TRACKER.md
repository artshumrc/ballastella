# Tracker for workspace-and-layers

## Purpose

This document tracks the status of all tickets in the epic. The goal of `workspace-and-layers` is to reshape Ballastella around one working screen and one shared pool of material: a Project is a Base Map with a Layer sidebar and the scholar stays there; Historical Maps and their Alignments belong to the Workspace so one map is prepared and aligned once and used by any number of Projects; a map on a Library's server can be aligned in place; the Base Map opens on the scholar's own work and is cached offline only when asked for; and backup, handoff, and review become three distinct, honest artefacts. Scope, decisions, and testing approach are in [SPEC.md](./SPEC.md); the reasoning behind individual decisions is in [docs/adr](../../docs/adr) — principally [ADR-0023](../../docs/adr/0023-historical-maps-and-alignments-live-in-the-workspace.md), [ADR-0024](../../docs/adr/0024-backup-and-handoff-are-different-artefacts.md), [ADR-0025](../../docs/adr/0025-no-base-map-ships-offline-is-per-project-and-opt-in.md), and [ADR-0026](../../docs/adr/0026-the-opening-view-is-computed-from-the-projects-content.md) — and vocabulary is in [CONTEXT.md](../../CONTEXT.md).

## Current Status

Overall status: `In Progress`

Merged to `main`: 01, 02, 03, 04, 08, 09, 10, 11, 12, 17, 18, 19. **16 is in flight.**

**Unblocked and ready:** 05. It is held only until 16 lands — 16 is a repo-wide rename and 05 carves `ProjectScreen.svelte`, so running them together would mean resolving a rename against a restructure across the same files.

**The e2e fixture is now one composed root.** `e2e/support/test.ts` is the root and `network-fence.ts` is the layer beneath it; `check-e2e-network-fence.mjs` enforces both halves, because an import rule alone cannot see a composition quietly unpicked. It caught two real defects the day it landed — `expectWorkspaceNamed` was satisfied by the popover it was nested inside, so `switchToWorkspace` returned before switching, and `seedWorkspaceBytes` wrote 700 MB of ballast into the OPFS root so the hosting warning it seeds for never appeared. Both were green tests proving nothing.

**No test may depend on the network — a human decision on 2026-08-07, now enforced rather than merely followed.** `demo-bucket.protomaps.com/v4.pmtiles` began answering 404 and turned three specs red on `main` with nothing in this repo having changed; ADR-0025 had already recorded that bucket as having no uptime promise. The e2e fence rides the `context` fixture every test gets, and `scripts/check-e2e-network-fence.mjs` fails any spec importing `test` from `@playwright/test` — the spelling every Playwright example uses, and the way a new spec would drift outside it. The vitest fence is `setupFiles` on both projects and covers `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon` and `node:http`/`https`. Two limits are stated rather than implied: a Node test can still open a raw `node:net` socket, and `BALLASTELLA_NETWORK_TESTS=1` disables the vitest fence for a whole run (one legitimate user, `live-services.test.ts`, excluded from `pnpm test`).

**`apps/editor/` has no unit test seam at all** — no `*.test.ts` anywhere in it, no vitest project. `EditorSession` is ~1800 lines holding the app's central state, and its only test seam is the 7-minute browser suite. That is why a silent-return guard sat unexercised for the whole epic, and why the regression test for it had to be an e2e test. Every ticket that carves `ProjectScreen.svelte` — 05 and 06 next — pays this, and it is the most valuable structural work not currently on the ledger.

**A flake twice attributed to machine load was neither load nor timing.** `editor-stored-image-pane.e2e.ts:354` retried 3 times in 10 runs *in isolation on a quiet machine*. `EditorSession.ingestImage` discarded a second file in complete silence when one was already in flight, and the only guard was the file input's transient `disabled` attribute — which Playwright's `setInputFiles` does not respect, since it performs no enabled actionability check. The lesson is ticket 17's, arriving a second time: **a healthy run took ~6s and a failing one spent 30s watching a DOM that had already settled.** Work that never started is not slow work, and load cannot produce a settled-but-wrong DOM. Before attributing anything to contention, find the number that rules it out.

**The archive is still dead, and that is now the *product's* problem rather than the suite's.** The editor says so honestly — `BaseMapPane` listens for MapLibre's source error, which nobody did, and that is exactly how an outage rendered as a grey rectangle. **The published viewer has no equivalent notice and still shows a Reader a silent blank map.** All four catalog entries read the same dead archive, so the "try another Base Map" remedy is currently empty.

**`pagehide` is not a race the user sometimes loses — for a real navigation it is never won.** Measured in a real browser: a debounced Project rename plus `page.reload()` inside the 400 ms window **lost the edit 8 times out of 8**. The event does fire and the flush takes 32 ms; the edit is lost anyway, because the store write is asynchronous and an unloading document does not run the continuation. A synchronous `localStorage.setItem` in the same handler survived 5/5, so a write-ahead journal is demonstrably viable — but it puts user bytes outside the ProjectStore, against ADR-0001, and needs an ADR-0017 amendment. **This needs a decision, not code**, and it is the largest known correctness hole in the product. Affected today: renaming a Layer or a Project, and annotation text and style edits.

Smaller, recorded in 17's follow-ups: `expectWarpedDrawn` used to pass against a Base Map with no tiles at all — that is now fixed and is red against an all-zero archive.

**11's deferral is discharged, and it cost more than expected.** The tile cache is now `base-map/tiles/<key>/{z}/{x}/{y}.mvt`, keyed on the catalog entry's own `archive` *string* rather than the resolved URL — a Workspace published to another host would otherwise compute a different key for its own files. That is a published-format change, and 12's first cut shipped it at `formatVersion` 1 with no fallback: a pre-12 Published Site drew no cached geography and never said why, and `CACHED_TILE_PATH` stopped matching the old layout so a pre-12 Workspace's tiles were invisible to the hub's size *and* to clearing. Now version 2, with both paths reading the legacy shape. **The code says plainly that the version bump protects nobody and the fallback is the part that works** — a bump only helps a reader that has already been taught to refuse, which is why story 114 matters.

**17 is done, and it settled the flake's cause rather than its symptoms.** There were never any browser crashes — zero `Protocol error` or `Target closed` in 11,970 executions. The "crashes" earlier implementers reported predate the port derivation and were parallel checkouts testing each other's builds. Runs with at least one failure went from 6/10 to 1/10; the failure rate from 0.20% to 0.025%, measured before the archive routing landed, which can only have improved it.

**What that ticket demonstrated twice over: the plausible cause is not the cause.** Its own first cut mis-diagnosed the archive failure as "no Base Map means no warped render" and wrote that into three files; the mandated mutation check disproved it — routed-but-404 is *green*, unrouted-and-404 is red, because an unrouted request is cross-origin and the bucket's preflight answers 403, so the page gets no response at all rather than an error it can handle. Four of the six defects review found in that ticket were in the parts of the work whose whole subject is results that mean nothing: an untested lock, a listing that reported success while short, an assertion that could observe nothing and pass.

**`retries` no longer hides anything.** Every retry is printed with file and line, and the run fails above 0.5%. A `--reporter=` flag on the command line replaces Playwright's whole reporter list and silently disables that budget — stated in `playwright.config.ts` and `CONTRIBUTING.md`, since nothing can pin it.

Last updated: 2026-08-08 (12, 17 and 19 merged; the network fence landed)

## Standing constraints

These apply to every remaining ticket. They are not advice.

- **The mutation check is mandatory, not advisory.** Break the behaviour, confirm the test goes red, restore. Every reviewed ticket in v1 *and* in this epic has yielded substantive defects after its implementer reported all criteria passing — including criteria passing **vacuously**, where the code under test can be deleted and the test stays green. Assume your own green report is wrong until you have watched each assertion fail.
- **Stories 111–114 are cross-cutting and deliberately absent from the ledger.** Visible text rather than tooltips, screen-reader announcement of what the map does, no silent service-worker activation, and refusal of a newer `formatVersion` belong inside every ticket that adds UI, the same treatment v1 gave accessibility. Attributing them to one ticket would be misleading in both directions.
- **Story 96 — publishing from one place — is already built and only has to keep working.** Several tickets assert that it does.
- **Two spec claims rest on documentation rather than measurement, and no ticket may commit to them unverified:** `modern-tar`'s streaming and PAX behaviour, and the tile counts and byte totals for a realistic Project extent. **The tile claim is discharged.** Ticket 11 measured it against a real Protomaps basemaps v4 extract and ADR-0025 survives: a city-centre Project at every zoom from 0 to 14 is 23 tiles and 3.49 MB. The numbers are not prose — `e2e/support/editor-deployment.ts` re-measures them and `tile-cache.test.ts` asserts the totals, so the figures in the module comment cannot rot unnoticed. The tar claim is still open and carries more weight: ADR-0024 justifies the entire format change on it.

## What 18 established, and what it does not cover

Worth reading before writing any other "one writer of one file" rule; tickets 13 and 14 will need it.

Every Alignment write now goes through `alignment/alignment-file.ts` and names which of create / update / replace it means. Two layers hold that: `alignmentPath` returns a branded `AlignmentPath` that `ProjectStore.write`, `Autosave.commit` and `Autosave.queue` refuse, and `scripts/check-alignment-writers.mjs` covers the spellings a type cannot see — the hand-written literal, a path laundered through a local, a detached write method, a second cast. A `@ts-expect-error` pair makes removing the brand fail the build.

**Copy the two layers, and copy the honesty.** 18's first cut claimed the blind write was inexpressible and it was not: `Autosave.queue` was never narrowed, the local-variable spelling walked past the fence, and a third existence check sat unnoticed in the Project-zip importer. All three were found by review, not by anything failing. The brand's real limit is now stated rather than claimed away — `WritablePath` brands with an *optional* property so ordinary paths stay assignable without casts, which means a path the compiler sees as a plain `string` is accepted. Write the escape out, watch it pass, then close it.

**One gap 18 deliberately left open, for whoever writes the conflict story:** nothing detects a concurrent edit. `update` writes over whatever is there, so a colleague's change arriving through a synced Workspace between read and write is lost. ADR-0023 accepts this — the mitigation is visibility, not prevention — and `alignment-file.ts` says so rather than implying coverage.

## Ledger

`Fulfills` lists the [SPEC.md](./SPEC.md) user stories a ticket delivers.

| Number | Filename | Status | Depends On | Fulfills |
| --- | --- | --- | --- | --- |
| 01 | [01-historical-maps-move-to-the-workspace.md](./tickets/01-historical-maps-move-to-the-workspace.md) | Completed | — | 61, 62, 66, 67 |
| 02 | [02-a-layer-is-created-when-a-map-is-added.md](./tickets/02-a-layer-is-created-when-a-map-is-added.md) | Completed | 01 | 18, 34, 35, 68 |
| 03 | [03-aligning-becomes-its-own-route.md](./tickets/03-aligning-becomes-its-own-route.md) | Completed | 01 | 37, 38, 41–55, 57–60 |
| 04 | [04-the-project-screen-replaces-the-project-page.md](./tickets/04-the-project-screen-replaces-the-project-page.md) | Completed | 03 | 1, 2, 3, 10–13, 109, 110 |
| 05 | [05-the-layer-sidebar-opens-one-layer-at-a-time.md](./tickets/05-the-layer-sidebar-opens-one-layer-at-a-time.md) | Not Started | 02, 04 | 14–17, 20 |
| 06 | [06-add-a-historical-map-from-three-sources.md](./tickets/06-add-a-historical-map-from-three-sources.md) | Not Started | 02, 05 | 21–30, 33, 36, 106 |
| 07 | [07-align-a-referenced-historical-map-in-place.md](./tickets/07-align-a-referenced-historical-map-in-place.md) | Not Started | 06 | 31, 32, 39, 40, 56, 80, 81 |
| 08 | [08-the-workspaces-historical-maps-on-the-hub.md](./tickets/08-the-workspaces-historical-maps-on-the-hub.md) | Completed | 01 | 23, 63, 64, 65, 98 |
| 09 | [09-the-project-opens-on-its-own-content.md](./tickets/09-the-project-opens-on-its-own-content.md) | Completed | 01 | 4, 5, 7, 8, 9, 100 |
| 10 | [10-no-base-map-ships.md](./tickets/10-no-base-map-ships.md) | Completed | 09 | 74, 102, 103 |
| 11 | [11-make-a-project-available-offline.md](./tickets/11-make-a-project-available-offline.md) | Completed | 08, 10 | 6, 69–73, 75–79, 97, 99 |
| 12 | [12-the-opfs-root-holds-several-named-workspaces.md](./tickets/12-the-opfs-root-holds-several-named-workspaces.md) | Completed | 04 | 88, 105, 107, 108 |
| 13 | [13-back-up-and-restore-a-workspace-as-a-tar.md](./tickets/13-back-up-and-restore-a-workspace-as-a-tar.md) | Not Started | 01, 12 | 82–87 |
| 14 | [14-hand-off-a-project-and-review-one.md](./tickets/14-hand-off-a-project-and-review-one.md) | Not Started | 13 | 89–95 |
| 15 | [15-remove-the-editors-unwarped-view.md](./tickets/15-remove-the-editors-unwarped-view.md) | Not Started | 07 | 101 |
| 16 | [16-the-offline-copy-has-one-name.md](./tickets/16-the-offline-copy-has-one-name.md) | In Progress | 02, 03, 09 | — |
| 17 | [17-the-e2e-suite-tells-the-truth.md](./tickets/17-the-e2e-suite-tells-the-truth.md) | Completed | 02, 03, 09 | — |
| 18 | [18-a-shared-alignment-is-not-overwritten-by-accident.md](./tickets/18-a-shared-alignment-is-not-overwritten-by-accident.md) | Completed | 02, 03 | 60 |
| 19 | [19-drop-libvips-for-v1.md](./tickets/19-drop-libvips-for-v1.md) | Completed | 11 | — |

**16, 17 and 19 were added after planning.** 16 and 17 are debt the epic's own reviews surfaced: 16 is a rename the ubiquitous language already mandates and the code never did, and 17 is the e2e suite. 19 is a scope reduction on a human decision — libvips is not needed for v1, and the path it removes cannot execute on this deployment target, so it is almost entirely deletion. Its reasoning and measurements are in the ticket; it also closes v1 ticket 05's open question and ticket 15's `[~]` criterion, both of which have been waiting on that decision.

## Critical path

**04 → 05 → 06 → 07 → 15 is what remains of the long chain**, five deep, and 04 is in flight. Everything else is a short tail: 12 hangs off 04, the transfer pair 13 → 14 hangs off 12, and 19 hangs off 11.

The two tickets most likely to hurt are **06** (three sources for adding a Historical Map, fulfilling thirteen stories) and **13** (the tar format, whose justification in ADR-0024 rests on an unverified claim — see Standing constraints). 05 and 06 both carve down `ProjectScreen.svelte`, which 04 leaves large and coherent-under-instruction at ~1400 lines; the ticket forbade rewriting the state layer, so that carving is deliberately theirs.

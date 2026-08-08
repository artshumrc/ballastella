# Tracker for workspace-and-layers

## Purpose

The goal of `workspace-and-layers` is to reshape Ballastella around one working screen and one shared pool of material: a Project is a Base Map with a Layer sidebar and the scholar stays there; Historical Maps and their Alignments belong to the Workspace so one map is prepared and aligned once and used by any number of Projects; a map on a Library's server can be aligned in place; the Base Map opens on the scholar's own work and is cached offline only when asked for; and backup, handoff, and review become three distinct, honest artefacts.

Scope and testing approach are in [SPEC.md](./SPEC.md); decisions are in [docs/adr](../../docs/adr) — principally [ADR-0023](../../docs/adr/0023-historical-maps-and-alignments-live-in-the-workspace.md), [ADR-0024](../../docs/adr/0024-backup-and-handoff-are-different-artefacts.md), [ADR-0025](../../docs/adr/0025-no-base-map-ships-offline-is-per-project-and-opt-in.md), [ADR-0026](../../docs/adr/0026-the-opening-view-is-computed-from-the-projects-content.md); vocabulary is in [CONTEXT.md](../../CONTEXT.md).

## Current status

Overall: `In Progress`. Merged: 01–05, 08–13, 16–20. **Remaining: 06, 07, 14, 15.** Nothing in flight.

**Ready now: 06 and 14.** They do not collide — 06 carves `ProjectScreen.svelte`, 14 is transfer — so they can run together. 07 waits on 06; 15 waits on 07.

Last updated: 2026-08-08.

## Open leads — unclosed, and not to be absorbed into the flake budget

1. **`editor-workspace.e2e.ts:1006`, "does not put an edit back into a Project the user deleted".** Measured at **2 retries in 10 runs in isolation on a quiet machine**, then 8 clean. Forty times the 0.5% budget. No failure text was captured, so the reproduction rate is known and the failure mode is not — capturing it is the first job. **It guards a data-loss path**: whether a replayed edit can return to a Project the user deleted. A deletion/replay race would present exactly like this, and if the app is racy the honest outcome is an app fix, not a steadier test.

2. **`Cannot set properties of undefined (setting 'forceRedraw')`** — OpenSeadragon by way of triiiceratops, on the unwarped→map navigation the spec's own comment records as a hazard. `pnpm flake:check --against main` returned **SUSPECT**, not "consistent with flake". Ticket 20 ruled itself out with evidence (`git diff main -- apps/viewer` empty; the built viewer bundle carries none of its code). Whether it still reproduces is unverified.

3. **The published viewer has no unreachable-archive notice.** The editor got one in ticket 20's session — `BaseMapPane` listens for MapLibre's source error, which nothing did, and that is how an outage rendered as a grey rectangle. A Reader on a published site still gets a silent blank map. Related: all four catalog entries read the same archive, so the editor's "try another Base Map" remedy is currently empty, and `demo-bucket.protomaps.com/v4.pmtiles` has answered 404 since 2026-08-07. ADR-0025 predicted this; `pnpm check:deployment` refuses that URL and runs inside `pnpm test`.

## Standing constraints

These apply to every remaining ticket. They are not advice.

- **The mutation check is mandatory.** Break the behaviour, confirm the test goes red, restore, and record what you broke. Every reviewed ticket in v1 *and* in this epic has yielded substantive defects after its implementer reported all criteria passing — including criteria passing **vacuously**, where the code under test can be deleted and the test stays green.
- **Before attributing anything to load or contention, find the number that rules it out.** This epic has been wrong about a flake's cause three times, and each time the real cause was a defect: a silently discarded second ingest (twice called "machine load"), and a Base Map story its own mutation check disproved. A healthy run of ~6s versus a failing one that spends 30s watching a DOM that had already settled is the shape to look for — work that never started is not slow work.
- **Stories 111–114 are cross-cutting and deliberately absent from the ledger**: visible text rather than tooltips, screen-reader announcement, no silent service-worker activation, refusal of a newer `formatVersion`. They belong inside every ticket that adds UI.
- **Story 96 — publishing from one place — is already built and only has to keep working.**
- **No test may depend on the network** (human decision, 2026-08-07). Enforced, not merely followed: `e2e/support/test.ts` is the one composed root fixture and `scripts/check-e2e-network-fence.mjs` fails any spec importing `test` from `@playwright/test`; vitest has `setupFiles` fences on both projects. Two stated limits: a Node test can still open a raw `node:net` socket, and `BALLASTELLA_NETWORK_TESTS=1` disables the vitest fence for a whole run.
- **A version bump protects nobody; the fallback is the part that works.** Ticket 12 shipped a keyed Base Map cache at `formatVersion` 1 with no fallback, and a pre-12 Published Site drew no cached geography and never said why. A bump only helps a reader already taught to refuse — which is what story 114 is for.

## Traps that cost real time

- **Never pass `--reporter=` on the command line.** It replaces Playwright's whole reporter list and silently disables the retry budget, which prints every retry with file and line and fails the run above 0.5%.
- **Do not pipe gate output through `grep`, and read exit codes rather than summary lines.** A lint failure survived on `main` because a filter matched "error" but not Prettier's `[warn]`; a failing run was classified as unexplained because its output had been discarded.
- **`optimizeDeps.include` in `packages/core/vitest.config.ts` is not tuning.** Vite re-optimizes when the lockfile changes, mid-run, then reloads; it hung the browser project for forty minutes twice. The second run always passes because the cache is warm, so it presents as flake. **Adding a dependency used by a browser test means adding it there.**
- **A rename is the change most likely to be 95% done and look finished.** Ticket 16 left four e2e assertions on the old spelling and a fixture whose *type* said one thing and *default* said another, so fixtures laid down files for a mode the app never reports. `pnpm check` missed it. Re-run the whole suite, not the specs you touched.

## What the remaining tickets need

**06 — what to carve first, from 05's reading rather than your re-derivation.** `ProjectScreen.svelte` is 1776 lines. The extraction is the **369-line annotation state block**, from the `// Annotations` banner to `// Making this Project available offline`; 05's ticket lists every member and its three edges to the rest of the screen (`session`, `documents`, `layers`). The Historical Maps section is a further 95 lines and is 06's own subject.

**06 — `apps/editor/` has no unit test seam at all.** No `*.test.ts` anywhere in it, no vitest project. `EditorSession` is ~1800 lines of the app's central state whose only test seam is the 7-minute browser suite; that is why a silent-return guard survived the whole epic. The annotation-state extraction above is the same change that would make a seam worth having. Adding one is real value and real scope — decide deliberately, do not drift into it.

**14 — read ticket 18 before writing any "one writer of one file" rule.** Every Alignment write goes through `alignment/alignment-file.ts` and names create / update / replace. Two layers hold it: `alignmentPath` returns a branded `AlignmentPath` that `ProjectStore.write`, `Autosave.commit` and `Autosave.queue` refuse, and `scripts/check-alignment-writers.mjs` catches the spellings a type cannot see. **Copy both layers and copy the honesty** — 18's first cut claimed the blind write was inexpressible and it was not, and the brand's real limit is now stated: `WritablePath` brands with an *optional* property, so a path the compiler sees as a plain `string` is accepted. Write the escape out, watch it pass, then close it. Ticket 13 and ticket 20 both found paths computed at runtime that the fence cannot see, and both said so rather than relying on the gap.

**14 — two live gaps in what 13 and 18 left.** Nothing detects a concurrent edit: `update` writes over whatever is there, so a colleague's change arriving through a synced Workspace between read and write is lost. ADR-0023 accepts this — the mitigation is visibility, not prevention. And `writeRestored`'s declined-write path is unreachable today only because a restore destination is always new; **Review Workspaces reach it.**

**14 — the tar is measured and the measurements re-run themselves.** `packages/core/src/transfer/tar-format.test.ts` pins `modern-tar` 0.8.2: PAX carries the real 121-character annotation paths and Devanagari, CJK, Arabic and astral emoji; 70,000 entries round-trip, the count at which `fflate` produced an index claiming 4,464 and read it back with no error; the decoder stalls its producer 9 MiB into a 64 MiB entry held unread; and **a truncated tar throws**, cut mid-header or mid-body. That last is not in ADR-0024 and matters most — the zip is going because a short archive came back silently short.

**Anyone measuring memory: read the comment at `tar-format.test.ts:254` first.** Three instruments were tried and rejected with their numbers. `heapUsed` does not count a `Uint8Array`'s payload at all, so a consumer retaining 512 MiB moved it +5.24 MiB against a streaming consumer's +3.17 MiB — the bound could not fail. What is asserted instead is streamed consumption, in bytes moved rather than bytes collected.

**Autosave now has a Write-Ahead Journal** (ticket 20, ADR-0017 rule 3 as amended, ADR-0001's exception). Recording happens **at the edit, not at `pagehide`**, because `localStorage` quota can only be reported while there is still a screen to report it on. Its first cut opened two fresh data-loss paths — a refusal that deleted the identical rescue copy, and an empty listing read as proof a file was gone — so if you touch replay, the rule that survived is **"unreadable is not absent"**.

## Ledger

`Fulfills` lists the [SPEC.md](./SPEC.md) user stories a ticket delivers.

| Number | Filename | Status | Depends On | Fulfills |
| --- | --- | --- | --- | --- |
| 01 | [01-historical-maps-move-to-the-workspace.md](./tickets/01-historical-maps-move-to-the-workspace.md) | Completed | — | 61, 62, 66, 67 |
| 02 | [02-a-layer-is-created-when-a-map-is-added.md](./tickets/02-a-layer-is-created-when-a-map-is-added.md) | Completed | 01 | 18, 34, 35, 68 |
| 03 | [03-aligning-becomes-its-own-route.md](./tickets/03-aligning-becomes-its-own-route.md) | Completed | 01 | 37, 38, 41–55, 57–60 |
| 04 | [04-the-project-screen-replaces-the-project-page.md](./tickets/04-the-project-screen-replaces-the-project-page.md) | Completed | 03 | 1, 2, 3, 10–13, 109, 110 |
| 05 | [05-the-layer-sidebar-opens-one-layer-at-a-time.md](./tickets/05-the-layer-sidebar-opens-one-layer-at-a-time.md) | Completed | 02, 04 | 14–17, 20 |
| 06 | [06-add-a-historical-map-from-three-sources.md](./tickets/06-add-a-historical-map-from-three-sources.md) | Not Started | 02, 05 | 21–30, 33, 36, 106 |
| 07 | [07-align-a-referenced-historical-map-in-place.md](./tickets/07-align-a-referenced-historical-map-in-place.md) | Not Started | 06 | 31, 32, 39, 40, 56, 80, 81 |
| 08 | [08-the-workspaces-historical-maps-on-the-hub.md](./tickets/08-the-workspaces-historical-maps-on-the-hub.md) | Completed | 01 | 23, 63, 64, 65, 98 |
| 09 | [09-the-project-opens-on-its-own-content.md](./tickets/09-the-project-opens-on-its-own-content.md) | Completed | 01 | 4, 5, 7, 8, 9, 100 |
| 10 | [10-no-base-map-ships.md](./tickets/10-no-base-map-ships.md) | Completed | 09 | 74, 102, 103 |
| 11 | [11-make-a-project-available-offline.md](./tickets/11-make-a-project-available-offline.md) | Completed | 08, 10 | 6, 69–73, 75–79, 97, 99 |
| 12 | [12-the-opfs-root-holds-several-named-workspaces.md](./tickets/12-the-opfs-root-holds-several-named-workspaces.md) | Completed | 04 | 88, 105, 107, 108 |
| 13 | [13-back-up-and-restore-a-workspace-as-a-tar.md](./tickets/13-back-up-and-restore-a-workspace-as-a-tar.md) | Completed | 01, 12 | 82–87 |
| 14 | [14-hand-off-a-project-and-review-one.md](./tickets/14-hand-off-a-project-and-review-one.md) | Not Started | 13 | 89–95 |
| 15 | [15-remove-the-editors-unwarped-view.md](./tickets/15-remove-the-editors-unwarped-view.md) | Not Started | 07 | 101 |
| 16 | [16-the-offline-copy-has-one-name.md](./tickets/16-the-offline-copy-has-one-name.md) | Completed | 02, 03, 09 | — |
| 17 | [17-the-e2e-suite-tells-the-truth.md](./tickets/17-the-e2e-suite-tells-the-truth.md) | Completed | 02, 03, 09 | — |
| 18 | [18-a-shared-alignment-is-not-overwritten-by-accident.md](./tickets/18-a-shared-alignment-is-not-overwritten-by-accident.md) | Completed | 02, 03 | 60 |
| 19 | [19-drop-libvips-for-v1.md](./tickets/19-drop-libvips-for-v1.md) | Completed | 11 | — |
| 20 | [20-a-real-navigation-does-not-lose-an-edit.md](./tickets/20-a-real-navigation-does-not-lose-an-edit.md) | Completed | 12 | — |

**16, 17, 19 and 20 were added after planning** — debt and defects the epic's own work surfaced rather than slices of the plan. Each carries its reasoning and measurements in its own ticket.

## Critical path

**06 → 07 → 15** is all that remains of the long chain, and **14** hangs off the merged 13. 06 and 14 can run in parallel.

**06 is the ticket most likely to hurt**: three sources for adding a Historical Map, thirteen stories, and it carves `ProjectScreen.svelte` — which 05 left larger than it found it, deliberately and with the extraction named.

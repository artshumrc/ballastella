# Tracker for workspace-and-layers

## Purpose

The goal of `workspace-and-layers` is to reshape Ballastella around one working screen and one shared pool of material: a Project is a Base Map with a Layer sidebar and the scholar stays there; Historical Maps and their Alignments belong to the Workspace so one map is prepared and aligned once and used by any number of Projects; a map on a Library's server can be aligned in place; the Base Map opens on the scholar's own work and is cached offline only when asked for; and backup, handoff, and review become three distinct, honest artefacts.

Scope and testing approach are in [SPEC.md](./SPEC.md); decisions are in [docs/adr](../../docs/adr) — principally [ADR-0023](../../docs/adr/0023-historical-maps-and-alignments-live-in-the-workspace.md), [ADR-0024](../../docs/adr/0024-backup-and-handoff-are-different-artefacts.md), [ADR-0025](../../docs/adr/0025-no-base-map-ships-offline-is-per-project-and-opt-in.md), [ADR-0026](../../docs/adr/0026-the-opening-view-is-computed-from-the-projects-content.md); vocabulary is in [CONTEXT.md](../../CONTEXT.md).

## Current status

Overall: `In Progress`. Merged: 01–06, 08–14, 16–20. **Remaining: 07, 15, 21, 22.** In flight: 07, 21 and 22, running in parallel.

**21 is open lead 1, promoted to a ticket** (human decision, 2026-08-08): a deleted Project's `project.json` comes back at a measured ~20% rate, and the epic should not close carrying a known data-loss path. It is independent of 07 — autosave and deletion, not the align route — so the two run together. 15 waits on 07.

06 and 14 merged 2026-08-08. The full gate on merged `main` is green: install / build / lint / check / test all exit 0, and `pnpm test:e2e` is **487 passed, 1 skipped, retry budget 0 of 488 (0.00%)**.

Last updated: 2026-08-08.

## Where to pick up — session ended on a usage limit, 2026-08-08

**Nothing below is merged.** Four branches exist, none on `main`. Two carry **unverified WIP** committed by the orchestrator to stop a dirty worktree losing it — they had no gate run and must not be read as green.

| Branch | Head | State |
| --- | --- | --- |
| `ticket-07-align-referenced-map` | `d6738a8` | Implemented, **gate green** (495 passed, 0.20% budget). Two-axis review done; **fix round never started** — see below. |
| `ticket-21-deleted-project-stays-deleted` | `b434e73` | Rounds 1–2 committed and green at `d55eb48`. Round 3 is **WIP, UNVERIFIED**. |
| `ticket-22-reader-base-map-notice` | `be6092a` | Round 1 committed and green at `591989d`. Round 2 is **WIP, UNVERIFIED**, and its agent believed it was near done. |
| — | — | **15** not started. Unblocked now that 07 exists. |

Each WIP commit message lists exactly what that round was fixing. Read it before touching the branch.

### 07's fix round — never dispatched, findings below

Both reviews converged on one thing: **ADR-0023's mitigation is visibility, and the visibility is the only part with no test.** Delete `AlignmentWorkspace.svelte:759-812` (the whole changed-elsewhere alert), or `livePane = pane` at `:309`, or `livePane = undefined` at `:234`, or the `reload()` at `:791-795` — each keeps the entire suite green. The last is the fix for a real data-loss path (the screen keeps drawing Control Points the user gave up, and the next drag writes them back) and is claimed in a comment only. The only coverage asserts a **session field**, which SPEC's Testing Decisions rules out as a proxy.

Also found, and not yet fixed:

- **A false alarm from 07's own save path.** `save()` fires without awaiting (`AlignmentWorkspace.svelte:359`); `writeAlignment` reads its baseline at entry and updates it only after `commit` resolves. Two gestures inside one store write give the second a stale baseline, `changedSince` sees the *first call's own bytes*, and the user gets "written over a change" against their own document — the "frightening sentence about a colleague who does not exist" the code itself names as the worst outcome. The guarding test uses three sequentially awaited saves and cannot reach it.
- **Story 56 is absent, not partial.** "Told which Projects use this Historical Map while I am aligning it." `usedBy` renders only on the hub.
- **The fence's honesty statement is wrong.** `check-alignment-writers.mjs:30-36` and `alignment-file.ts:48-52` say "exactly **two**" runtime-computed paths, both tar readers. There are **three** — `replay.ts:165-172` says so itself. Routed correctly, so not an overwrite hazard; it is the honesty failure the fence's own header warns about, and 07 re-asserted the count without recounting.
- An `aria-live` region created together with its content (`HistoricalMapPane.svelte:260-268`), which this repo has settled twice in writing; no focus management on buttons that remove themselves; two inert baseline moves whose comment describes an unreachable scenario; untested reactivity guards; a dead fixture whose message contradicts 07's new one.

### The one thing that is not a ticket

**`origin/main` is 105 commits behind local `main`** (`14f9c7f`, pre-epic). The entire epic — every merged ticket — exists only on this machine and has never been pushed. That is the largest risk here by a distance, it is a decision for the repository owner, and it also explains why every worktree arrives stale: they branch from `origin/main`.

## Open leads — unclosed, and not to be absorbed into the flake budget

1. **CLOSED by ticket 21 (2026-08-08) — and the diagnosis this lead carried all epic was wrong.** Kept here because the mistake is instructive.

   The lead said a Write-Ahead Journal replay put the deleted Project's `project.json` back, and the captured evidence seemed to support it: the two `toHaveCount(0)` assertions passed, then the file was on disk. Every reader of this lead, including the ticket written from it, started from that hypothesis.

   **The replay was never involved.** Instrumented with durable `localStorage` markers — console messages in the last ~80 ms before a navigation are dropped, which cost one wrong reading first — the failing runs show: the startup replay restores the rename and forgets the entry correctly (ticket 20 working), `deleteProject`'s sweep then finds **zero** journal entries, and `Workspace.deleteProject`'s own first `await` — the `store.list` — **never resolves before the reload**. The deletion never removed anything. *The file that came back is the file that never went.*

   That is **ticket 20's own measurement in a mirror**: ADR-0017 rule 3 as amended says an unloading document does not run an async continuation. Ticket 20 read that as being about *edits*; a deletion is the same shape with none of the protection. Weakening the journal would have fixed nothing and cost ticket 20's subject.

   **The fix**: `DeletedProjects` records the gesture synchronously before the first `await`, `finishInterruptedDeletions()` runs in the startup recovery chain ahead of the replay, and `replay.ts` gains `ReplaySkipReason: 'project-deleted'` — the only evidence that reaches inside the `<project>/project.json` exemption, because no question asked *of the store* separates an interrupted `createProject` from an edit to a just-deleted Project. "Unreadable is not absent" is untouched; this adds a fact it could never derive. Measured `--repeat-each=20`: **before 4 flaky / 16 passed (20.00%), after 0 flaky / 20 passed (0.00%)**.

   **The lesson worth keeping: captured evidence told us *what* happened and we inferred *why*, and the inference was wrong for months.** "The file is present after a delete" is consistent with "something rewrote it" and with "nothing ever removed it", and only instrumentation separated them.

   **Still open, from this work:** `deleteHistoricalMap` has the identical shape and is presumably identically exposed. Not measured, not claimed fixed. And `FinishedDeletions.unfinished` is returned but not rendered — a notice beside `RecoveredEdits` (stories 111, 112) is the honest end state.

2. **`Cannot set properties of undefined (setting 'forceRedraw')`** — OpenSeadragon by way of triiiceratops, on the unwarped→map navigation the spec's own comment records as a hazard. `pnpm flake:check --against main` returned **SUSPECT**, not "consistent with flake". Ticket 20 ruled itself out with evidence (`git diff main -- apps/viewer` empty; the built viewer bundle carries none of its code). **It reproduces — verified 2026-08-08** on ticket 14's branch, which touches no viewer code. `viewer-reader.e2e.ts:1044` "opens over HTTP by link, and the navigation throws nothing" failed on the first attempt and passed on retry, and the failure text is now captured rather than inferred:

   ```
   Error: the navigation back to the map
   expect(received).toEqual(expected)
   + "pageerror: Cannot set properties of undefined (setting 'forceRedraw')"
   ```

   So the assertion is doing its job: a real `pageerror` is thrown during the navigation, intermittently. This is a defect in the app, not a slow test — the test asserts *nothing was thrown*, and something was.

   **Root-caused 2026-08-08. Load was measured out, not assumed:** `--repeat-each=12 -j 14` (oversubscribed) gave 1 failure in 24; at the configured `workers: 4`, 0 in 16. Load *widens* the window, it does not cause it.

   The defect is in the dependency: `triiiceratops/dist/components/OSDViewer.svelte:567-571` tears down with `viewer?.destroy()` but never poisons `lastTileSourceStr`, which is the only guard on three async continuations (`:698`, `:755`, `:813`). Those still call `viewer.open()` / `addTiledImage()` on a destroyed viewer, and — unlike `close()` and `destroy()` — neither early-returns on `!THIS[hash]`, so `world`'s `add-item` handler (`openseadragon.js:8236`) does `THIS[_this.hash].forceRedraw = true` on `undefined`, inside a bare `setTimeout` that the app cannot catch. The unwarped viewer runs its resolve→open cycle twice per mount, the second `info.json` landing ~130 ms before the click away, with tiles still arriving 200–350 ms after unmount.

   **Triaged 2026-08-08: left for later, deliberately.** The error is thrown from a `setTimeout` after the component is destroyed, on the way out of a page — the destination renders, nothing is lost, no state is corrupted, and a Reader sees nothing. Its real cost is developer-facing: one retry per full suite run, which consumes most of the 0.5% budget and leaves little room for a second genuine flake. Note that **ticket 15 does not remove this**: 15 takes triiiceratops out of the *editor* only, the published viewer keeps its unwarped view by contract, and the failing spec is the viewer's.

   **The fix is one line** — `lastTileSourceStr = '\0destroyed'` in the teardown — but it was deliberately not applied from a transfer ticket. It patches a third-party dist file, the repo's patch mechanism carries a fence obligation (`check-allmaps-patch.mjs` is the precedent), and triiiceratops is this project author's own package, so **upstream plus a version bump is the right end state**. Proving it in a test needs a delay injected into a dependency, which cannot be committed.

3. **The published viewer has no unreachable-archive notice** — **now ticket 22**, the last open part of this lead. The editor got one in ticket 20's session (`BaseMapPane` listens for MapLibre's source error, which nothing did, and that is how an outage rendered as a grey rectangle). A Reader on a published site still gets a silent blank map.

   **The catalog half of this lead is closed by decision, not by work** (repository owner, 2026-08-08): **the demo tiles stay.** Ballastella is a proof of concept and they are sufficient for it. `demo-bucket.protomaps.com` refusing since 2026-08-07 is therefore an accepted condition, not an open issue — **do not re-raise it.** Recorded as an amendment to [ADR-0025](../../docs/adr/0025-no-base-map-ships-offline-is-per-project-and-opt-in.md).

   No test relies on the demo archive, and that is enforced rather than followed — every Base Map assertion routes to the committed Amsterdam extract, and the URL appears in tests only as the example of a *blocked* host. `pnpm check:deployment` is deliberately unchanged: it still refuses a **production** deployment reading an archive it does not control, which is the right relationship between a proof of concept and a real one.

4. **A `commit` that reports success and never writes the bytes — `autosave.ts:292`.** Found 2026-08-09 while reviewing ticket 07, by a reviewer looking for the cause of a once-seen "DOM shows 3 Control Points, disk holds 2, no error". **Not yet confirmed by instrumentation** — it is a traced mechanism, and the next person should measure it before trusting this write-up.

   ```js
   file.draining ??= this.#drainLoop(path, file).finally(() => { file.draining = undefined; … });
   ```

   `#drainLoop` clears `file.pending` and exits its `while` synchronously, then resolves; the `.finally` callback runs **one microtask later**. A `commit` landing in that gap sees `file.draining` still set, so `#drain` hands back the *old* promise, sets `file.pending = bytes2`, and nothing drains again. The caller's `commit` resolves successfully, the bytes are never written, and if it was the last write of a burst it is lost permanently. One microtask wide, and it self-heals on the next commit to the same path — so it presents as a flake and would be absorbed by any budget above zero.

   **Ticket 07's per-map Alignment write queue closes it for `alignments/<id>.json`**, because `port.commit` only resolves after the `finally` has run, so write *n+1* cannot enter the gap. **It is still live for `project.json`** — the manifest. That is where it should be fixed, and it wants its own ticket and its own mutation check rather than being folded into a ticket that happens to be open.

   Note the shape, because this epic keeps meeting it: the reviewer's brief was to test the implementer's own hypothesis (their new write queue), and the honest answer was that the queue is clean and the cause is somewhere nobody had been looking.

5. **An uncaught `pageerror` when the connection is cut with a warped Layer on screen.** Found 2026-08-09 during ticket 22, and **measured rather than absorbed: 3 failures in 8 runs (37%), and 3 in 8 at the base commit too** — so neither that ticket's change nor machine contention.

   `@allmaps/render`'s `loadImage` asks for the Historical Map's `info.json` when tiles are needed, and the store's `SiteFileUnreachableError` escapes it **uncaught**, arriving as a `pageerror`. Nothing a Reader sees changes today, which is why it went unnoticed — the viewer's own `pageerror` assertion is what surfaced it.

   Ticket 22 excepted **that one message in that one test**, with the measurement written beside it; any other page error from the same path still turns the test red. That is a deliberate narrow exception, not a silenced assertion.

   **What to do about it is a render-seam question, not a Base Map one**: what should happen when a Historical Map's tiles stop being fetchable mid-session? ADR-0023 has an opinion about the Workspace's shared material; nothing yet says what the render layer owes a Reader whose connection goes while a map is drawn.

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

**07 — the align route is where ADR-0023's concurrent-edit gap actually bites, and 14 deferred it to you.** Nothing detects a concurrent edit: `alignment-file.ts`'s `update` writes over whatever is there, so a colleague's change arriving through a synced Workspace between read and write is lost. ADR-0023 accepts this — **the mitigation is visibility, not prevention**. Ticket 14 restated the gap rather than closing it, and gave its reason: ADR-0024's design is that two people's Alignments never meet, so nothing a Project bundle does can reach it. **The align route is the path that does.** `alignment-file.ts` now carries what the mitigation would be — hold the read bytes, re-read before `commit`, compare *bytes* not model, tell the user — written down for whoever gets here.

**07 — every Alignment write goes through one writer, and the fence has two layers.** `alignment/alignment-file.ts` names create / update / replace. `alignmentPath` returns a branded `AlignmentPath` that `ProjectStore.write`, `Autosave.commit` and `Autosave.queue` refuse, and `scripts/check-alignment-writers.mjs` catches the spellings a type cannot see. **Copy the honesty as well as the layers**: the brand's real limit is that `WritablePath` brands with an *optional* property, so a path the compiler sees as a plain `string` is accepted — write the escape out, watch it pass, then close it. Tickets 13, 18, 20 and 14 all found paths computed at runtime the fence cannot see, and every one of them said so rather than relying on the gap. That fence's honesty statement was corrected in 14 and now names both surviving runtime-computed paths.

**07 — a referenced map's bytes are not yours.** Ticket 06 built the third source (`addWorkspaceMap`) and proved it copies nothing, with an exact before/after file list rather than a count. 07 aligns a map whose tiles stay on a Library's server; the same rule holds, and the reclaim list, the offline copy and `workspaceBytes()` all read the same records.

**15 — read the viewer lead below before deleting anything.** 15 removes the editor's unwarped view, and open lead 2 lives on exactly the unwarped→map navigation. Deleting the view may remove the *editor's* exposure to that defect without fixing it, and the published viewer keeps it. Do not let a green suite after the deletion be read as the bug being gone.

**Autosave has a Write-Ahead Journal** (ticket 20, ADR-0017 rule 3 as amended, ADR-0001's exception). Recording happens **at the edit, not at `pagehide`**, because `localStorage` quota can only be reported while there is still a screen to report it on. Its first cut opened two fresh data-loss paths — a refusal that deleted the identical rescue copy, and an empty listing read as proof a file was gone — so if you touch replay, the rule that survived is **"unreadable is not absent"**. **Open lead 1 is in this code and now has a 20% reproduction rate.**

**`apps/editor` now has a unit test seam** (ticket 06). `annotation-editing.svelte.ts` is a real unit — its whole dependency on the app is four methods — and `apps/editor/vitest.config.ts` compiles it for the **client**. Read that file's ⚠ block before touching it: `environments.ssr.consumer: 'client'` and the *scoped* `resolve.conditions` are what make a reactivity assertion mean anything, a top-level `resolve.conditions` reaches only an environment nothing runs in, and a server-compiled `derived` is an uncached thunk that makes every such assertion pass. It was wrong in exactly that way for one round.

**The tar is measured and the measurements re-run themselves.** `packages/core/src/transfer/tar-format.test.ts` pins `modern-tar` 0.8.2: PAX carries the real 121-character annotation paths and Devanagari, CJK, Arabic and astral emoji; 70,000 entries round-trip, the count at which `fflate` produced an index claiming 4,464 and read it back with no error; the decoder stalls its producer 9 MiB into a 64 MiB entry held unread; and **a truncated tar throws**, cut mid-header or mid-body. `fflate` and the Project zip are gone (ticket 14).

**Anyone measuring memory: read the comment at `tar-format.test.ts:254` first.** Three instruments were tried and rejected with their numbers. `heapUsed` does not count a `Uint8Array`'s payload at all, so a consumer retaining 512 MiB moved it +5.24 MiB against a streaming consumer's +3.17 MiB — the bound could not fail. What is asserted instead is streamed consumption, in bytes moved rather than bytes collected.

## Ledger

`Fulfills` lists the [SPEC.md](./SPEC.md) user stories a ticket delivers.

| Number | Filename | Status | Depends On | Fulfills |
| --- | --- | --- | --- | --- |
| 01 | [01-historical-maps-move-to-the-workspace.md](./tickets/01-historical-maps-move-to-the-workspace.md) | Completed | — | 61, 62, 66, 67 |
| 02 | [02-a-layer-is-created-when-a-map-is-added.md](./tickets/02-a-layer-is-created-when-a-map-is-added.md) | Completed | 01 | 18, 34, 35, 68 |
| 03 | [03-aligning-becomes-its-own-route.md](./tickets/03-aligning-becomes-its-own-route.md) | Completed | 01 | 37, 38, 41–55, 57–60 |
| 04 | [04-the-project-screen-replaces-the-project-page.md](./tickets/04-the-project-screen-replaces-the-project-page.md) | Completed | 03 | 1, 2, 3, 10–13, 109, 110 |
| 05 | [05-the-layer-sidebar-opens-one-layer-at-a-time.md](./tickets/05-the-layer-sidebar-opens-one-layer-at-a-time.md) | Completed | 02, 04 | 14–17, 20 |
| 06 | [06-add-a-historical-map-from-three-sources.md](./tickets/06-add-a-historical-map-from-three-sources.md) | Completed | 02, 05 | 21–30, 33, 36, 106 |
| 07 | [07-align-a-referenced-historical-map-in-place.md](./tickets/07-align-a-referenced-historical-map-in-place.md) | In Progress | 06 | 31, 32, 39, 40, 56, 80, 81 |
| 08 | [08-the-workspaces-historical-maps-on-the-hub.md](./tickets/08-the-workspaces-historical-maps-on-the-hub.md) | Completed | 01 | 23, 63, 64, 65, 98 |
| 09 | [09-the-project-opens-on-its-own-content.md](./tickets/09-the-project-opens-on-its-own-content.md) | Completed | 01 | 4, 5, 7, 8, 9, 100 |
| 10 | [10-no-base-map-ships.md](./tickets/10-no-base-map-ships.md) | Completed | 09 | 74, 102, 103 |
| 11 | [11-make-a-project-available-offline.md](./tickets/11-make-a-project-available-offline.md) | Completed | 08, 10 | 6, 69–73, 75–79, 97, 99 |
| 12 | [12-the-opfs-root-holds-several-named-workspaces.md](./tickets/12-the-opfs-root-holds-several-named-workspaces.md) | Completed | 04 | 88, 105, 107, 108 |
| 13 | [13-back-up-and-restore-a-workspace-as-a-tar.md](./tickets/13-back-up-and-restore-a-workspace-as-a-tar.md) | Completed | 01, 12 | 82–87 |
| 14 | [14-hand-off-a-project-and-review-one.md](./tickets/14-hand-off-a-project-and-review-one.md) | Completed | 13 | 89–95 |
| 15 | [15-remove-the-editors-unwarped-view.md](./tickets/15-remove-the-editors-unwarped-view.md) | Not Started | 07 | 101 |
| 16 | [16-the-offline-copy-has-one-name.md](./tickets/16-the-offline-copy-has-one-name.md) | Completed | 02, 03, 09 | — |
| 17 | [17-the-e2e-suite-tells-the-truth.md](./tickets/17-the-e2e-suite-tells-the-truth.md) | Completed | 02, 03, 09 | — |
| 18 | [18-a-shared-alignment-is-not-overwritten-by-accident.md](./tickets/18-a-shared-alignment-is-not-overwritten-by-accident.md) | Completed | 02, 03 | 60 |
| 19 | [19-drop-libvips-for-v1.md](./tickets/19-drop-libvips-for-v1.md) | Completed | 11 | — |
| 20 | [20-a-real-navigation-does-not-lose-an-edit.md](./tickets/20-a-real-navigation-does-not-lose-an-edit.md) | Completed | 12 | — |
| 21 | [21-a-deleted-project-stays-deleted.md](./tickets/21-a-deleted-project-stays-deleted.md) | In Progress | — | — |
| 22 | [22-a-reader-is-told-when-the-base-map-is-missing.md](./tickets/22-a-reader-is-told-when-the-base-map-is-missing.md) | In Progress | — | 111, 112 |

**22 was added after planning** — it promotes the first half of open lead 3. The Base Map archive every catalog entry reads has refused since 2026-08-07, so a blank map with no explanation is the *current* behaviour of every published site, not a hypothetical. The notice is a defect fix; **what the catalog should point at instead is a product decision and is deliberately not in it** (human decision, 2026-08-08).

**21 was added after planning too** — it promotes open lead 1 from a recorded flake to a ticket, because it is a measured ~20% data-loss race and the epic should not close carrying it.

**16, 17, 19 and 20 were added after planning** — debt and defects the epic's own work surfaced rather than slices of the plan. Each carries its reasoning and measurements in its own ticket.

## Critical path

**07 → 15**, with **21** alongside, independent of both.

**07 is the last ticket that can hurt.** It aligns a map whose bytes stay on a Library's server, and it inherits ADR-0023's concurrent-edit gap that 14 deliberately deferred to it with the mitigation written out. **15 is small but not safe**: deleting the editor's unwarped view removes the editor's exposure to open lead 2 without fixing it, and the published viewer keeps the defect — a green suite after that deletion must not be read as the bug being gone.

## What 06 and 14 cost, for estimating 07

Both arrived with confident green reports and **both needed three rounds**. The first review of each found user-facing defects; the second review found that the *fixes* over-claimed — a unit test seam compiling for the server and so proving nothing, and a discard race reported closed that was only narrowed. Neither would have been caught by running the tests, because both were green throughout.

Two lessons worth carrying into 07:

- **A fix deserves the same review as the code it fixes.** The highest-value findings of the session were against fix commits, not original ones.
- **Reviews that measure beat reviews that read.** The two sharpest findings came from instrumenting the real toolchain — a probe of the Vite transform proving which Svelte runtime was emitted, and a `--repeat-each` run at two worker counts separating "load causes it" from "load widens the window".

# A real navigation does not lose an edit

## The defect

ADR-0017 rule 3 said a pending write is flushed on `visibilitychange` → hidden and on `pagehide`. Measured in a real browser on 2026-08-07, during ticket 17's follow-up work, that rule was **false for the case it was written for**.

| | result |
| --- | --- |
| a debounced Project rename, then a real `page.reload()` inside the 400 ms debounce window | **the edit was LOST, 8 times out of 8** |
| the same edit, with `pagehide` **dispatched** and no navigation | written in 32 ms |
| a synchronous `localStorage.setItem` inside a `pagehide` listener, with a real reload | **survived, 5 times out of 5** |

`pagehide` **does** fire on a real navigation and `Autosave.flush` **is** fast. The edit was lost anyway, because `ProjectStore.write` is asynchronous and **a document being unloaded does not run the continuation**. Rule 3 was not a race that was usually lost; for a real navigation it was never won.

Affected at the time of measurement: renaming a Layer or a Project, and Annotation text and style edits — every path through `Autosave.queue`.

The test that vouched for rule 3 dispatched `PageTransitionEvent('pagehide')` instead of navigating, which is the strongest claim that seam can make on its own and is not the user's case. That is the sharpest example this repository has of a test that could not see the bug it was named after.

> The measurement's one home is ADR-0017, "Rule 3, amended". The table above is reproduced here because this file *is* the ticket record; code points at the ADR rather than transcribing it.

## What was built

A synchronous **write-ahead journal** in `localStorage`, replayed into the ProjectStore at startup.

- `packages/core/src/autosave/journal.ts` — `WriteAheadJournal`, keyed by Workspace **and** path.
- `packages/core/src/autosave/replay.ts` — `replayJournal`, returning a four-list report.
- `Autosave` records on every `queue`/`commit` and forgets on every successful store write; `installFlushOnHide` calls `Autosave.capture()` **before** `flush()`.

Design decisions and the reasoning behind them are in ADR-0017 ("Rule 3, amended") and ADR-0001 ("The one exception, and its exact size"). This file records the *evidence*.

## The mutation check

CONTRIBUTING is explicit that the record is the only evidence anyone has. Every mutation below was actually applied and run. **Two came back green, and they are recorded rather than tidied away** — a mutation that does not go red is a finding about the tests, not a thing to hide.

| mutation | result | what it showed |
| --- | --- | --- |
| remove the replay from `WorkspaceStorage.start` | **RED** | 2 e2e tests |
| remove the `recovered` gate on the `?p=` open effect | **RED** | and it found a real defect on its first run — see below |
| remove `journal.forgetUnder` from `deleteProject` | **RED**, but only against the *fifth* e2e test | against the fourth it was **green**, because replay's own precondition already covers a Project that is simply gone. The fifth test exists because of that green. |
| remove the Alignment routing branch in `replay.ts` | **RED** | 2 core tests, via the executable refusal in `writePlain` |
| remove stale-entry removal on quota failure | **RED** (before the policy changed; see "what review found") | |
| drop the Workspace from the journal key | **RED** | 24 core tests |
| remove the newer-`formatVersion` refusal | **RED** | story 114 |
| never `forget` after a successful write | **RED** | |
| remove `record` on quota failure keeping the stored entry | **RED** | 3 core tests (added after review) |
| remove the `size`-based evidence in `hasMapImage` | **RED** | 3 core tests (added after review) |
| remove the `recovered` gate from `/align` | see note | no test reaches that route with a pending edit; the gate is argued from the hub's measured failure |
| remove the journal write from `Autosave.queue` | **GREEN** | `capture()` on `pagehide` picks the same bytes up |
| remove `autosave.capture()` from the `pagehide` listener | **GREEN** | `queue` had already journalled them |
| remove `leaving.capture()` from `WorkspaceStorage.#adopt` | **GREEN** | same redundancy again — `queue` had journalled the bytes before the switch |

**The three greens are one genuine redundancy, not three gaps.** `queue` and `capture` each carry the end-to-end case alone, so no e2e mutation of either can be red — and `#adopt`'s capture inherits that. Each is pinned where it is *not* redundant, in `journal.test.ts`: `queue` by "has the bytes on disk before the debounce has run at all", and `capture` by the one case only it can serve — a quota that was full at the edit and has room by the time the page goes away or the Workspace is switched.

The e2e comment block in `editor-workspace.e2e.ts` carries this table too, beside the tests it is about, and each affected test says in its own words what it does and does not pin.

## Defects the work found in itself

1. **The `recovered` gate.** The first run of the regression test showed the reload restoring the file on disk while the Project screen still displayed the *old* name — one keystroke from overwriting the rescue. Routes now await the replay before reading a Project.
2. **The capability probe was a write.** `browserJournalStorage()` originally did a scratch `setItem`/`removeItem`, breaking `editor-opening-view.e2e.ts`'s ADR-0010 "opening a Project writes nothing at all". It is now a read of `localStorage.length`.

## What review found, and what changed

Recorded because each is a case where the reasoning in the code was wrong rather than merely thin.

1. **`capture()` could destroy the entry it exists to protect.** The over-quota policy removed the previous entry, on the argument that an older entry is worse than none. False in two cases: `capture()` re-records *identical* bytes on `pagehide`, so a quota that filled in between would delete a complete valid rescue; and the argument assumed the store write would still happen, which is false precisely when an entry is still journalled. The policy is now **never remove**, plus "do not report a refusal when what is stored is already these exact bytes". Pinned by three tests.
2. **An empty listing was read as "gone".** The Project branch of `missingOwner` said "unreadable is not absent"; the Map-Image branches read any empty `store.list()` as a deletion and then discarded the bytes permanently. Both branches now demand the same evidence — `PathNotFoundError` from two named files — and the precondition runs inside the loop, so one unanswerable entry no longer abandons the rest. A map's own record is exempt for the same reason `project.json` is.
3. **The `recovered` gate was on one of two routes.** `/align?p=…&layer=…` is bookmarkable and is where Alignments are written; it was ungated, which is the defect the gate exists for on the route where it costs most. ADR-0017 had already claimed *every* route waited, so the claim is now enumerated rather than sweeping.
4. **The internal Workspace key reached the screen** — "finished saving in `opfs:Marking 2026`". `workspaceKeyLabel` now renders it as the user's own Workspace name.
5. **ADR-0001's "not a store" bullet was inaccurate** in the direction that hides unbounded growth: failed writes are kept on purpose and an unopened Workspace's entries persist. Corrected there and in CONTEXT.md.
6. **Two notices used `role="alert"` for steady-state facts.** CONTRIBUTING's mandated-method table puts Status in an `aria-live="polite"` region.
7. **The undo test was not an undo test.** Two `field.fill()`s are a re-edit; `UndoSlot` was never exercised. ADR-0014's claim is now pinned in `journal.test.ts` against a real `UndoSlot` and a store whose writes never settle. `WorkspaceStorage.#adopt`'s `capture()` call had no test at all and now has one.
8. **A browser that accepts the probe and rejects every write** (Safari with site data blocked) was told it was out of room. `JournalUnavailableError` is now distinct from `JournalFullError`.
9. **The quota message was five sentences of browser mechanics** printing a raw store path and a raw byte count. Rewritten to name the file and Project as the application names them, with a size in readable units.

## What was deliberately not done

- **No conflict resolution.** A replayed Alignment uses `intent: 'update'`, which is what the interrupted write was. `update`'s documented gap comes with it unchanged: a colleague's edit arriving through a synced Workspace between the interrupted write and the replay is overwritten, exactly as it would have been had the write completed. ADR-0023 accepts that gap in the same words.
- **No cross-tab coordination.** Two tabs in one Workspace share the journal; there is no lock and no channel in this application, and inventing one here would be a coordination protocol with a single caller.
- **Orphans are reported, never swept.** "Not in `listOpfsWorkspaces`" is not "gone" — a folder Workspace is never in that list. The discard is the user's gesture. This is more surface than "handled observably" strictly required, and it is recorded as a decision in ADR-0001.
- **A folder Workspace is keyed by its folder's name**, which is not unique, because a browser gives a picked directory no stable identifier a page may keep. Replay's preconditions bound the damage, and it is strictly better than the present behaviour, which is that the edit is lost outright.
- **`localStorage` and not IndexedDB.** IndexedDB is asynchronous, which is the entire property that failed.

## Gate

`pnpm -r build && pnpm -r test && pnpm lint && pnpm check && pnpm test` and a full `pnpm exec playwright test`, read as exit codes. Final run: **exit 0, 451 passed, 1 skipped, 1 flaky**, retry budget 1 of 453 (0.22%, budget 0.50%).

### The one flaky test, classified rather than waved through

`viewer-reader.e2e.ts › a Map Image read unwarped › opens over HTTP by link, and the navigation throws nothing` failed once in the full suite and passed on retry.

`pnpm flake:check --against main e2e/viewer-reader.e2e.ts` returned **SUSPECT**, not "consistent with flake" — green in isolation on both sides, so the full-suite red was unexplained and the tool says in as many words not to report it as a known flake without looking. So it was looked at.

**What failed.** The last assertion in the test, on the navigation *back* from the unwarped view to the map: `pageerror: Cannot set properties of undefined (setting 'forceRedraw')`. `forceRedraw` belongs to **OpenSeadragon**, reached through triiiceratops (ADR-0018) — it is the unwarped pane being torn down while a redraw is still scheduled. The test's own comment records that this direction "once produced a page containing no map at all with nothing logged beyond a `TypeError` from a page already left", so the hazard is known and this assertion is what guards it.

**Why it is not this ticket's.** Not an inference — checked:

- `git diff main -- apps/viewer` is **empty**; the viewer's source is untouched.
- The built viewer bundle contains **no** journal code (`WriteAheadJournal`, `ballastella.journal`) and none of the changed `Autosave` internals — it is all tree-shaken. Same for the viewer bundle staged into published sites, which is what this spec actually serves.
- So the viewer this spec exercises is functionally identical to `main`'s, and there is no mechanism by which this work could reach it.
- It passed in 2 of 3 full-suite runs on this branch, and 2 of 2 isolation runs, and 1 of 1 at `main`.

**What it leaves.** A nondeterministic teardown race inside a third-party viewer, surfaced under full-suite contention. It is recorded here rather than closed, because "SUSPECT, and then nothing" is how a real defect gets absorbed into the flake budget — which is the failure `flake-check` was written to stop. It wants a ticket of its own against the unwarped pane's unmount path; it is not one this ticket may quietly adopt.

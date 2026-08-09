# A deleted Project stays deleted

> **This file did not exist when the work started.** The task described it as "newly written at
> `.tracker/workspace-and-layers/tickets/21-a-deleted-project-stays-deleted.md`"; it was in no commit
> reachable from any branch, and the tracker's ledger stops at 20. The work was done from **open lead
> 1** in `TRACKER.md`, which carries the captured failure text, the pinned sequencing and the measured
> rate, and this file is the record it asks for. `TRACKER.md` itself was left untouched, as instructed
> (ticket 07 is in flight in another worktree).

## The defect

Open lead 1: `editor-workspace.e2e.ts:1006`, "does not put an edit back into a Project the user
deleted". A deleted Project's `project.json` was back on disk after a reload, at a measured ~20%.

**Reproduced on this branch before any change: `--repeat-each=20` gave 4 flaky / 16 passed —
20.00%, exactly the rate the lead recorded.**

### The lead's hypothesis was wrong, and the instrumentation is what said so

The lead reads the failure as "the Write-Ahead Journal replay wins the race and puts the edit back
into a Project the user deleted". It does not. The journal was **empty** at the moment of the
deletion, and empty again at the reload.

Measured in the browser with durable `localStorage` markers rather than `console.log` — console
messages emitted in the last ~80 ms before a navigation are dropped, which cost one wrong reading
before the markers were used. Timestamps in ms, one failing run:

| t | marker | |
| --- | --- | --- |
| 139050 | `replay-start ["amsterdam-1625/project.json"]` | the hub's startup replay |
| 139054 | `replay-wrote amsterdam-1625/project.json` | the rename put back — **correct**, ticket 20 working |
| 139504 | `deleteProject-swept amsterdam-1625 0` | `forgetUnder` finds **nothing**: the journal is already empty |
| — | `wsdelete-listed` | **never recorded** |
| 139619 | `replay-start []` | the reloaded document; nothing to replay |

Against a passing run, identical except that `wsdelete-listed` lands 14 ms after the sweep.

So: **`Workspace.deleteProject` had not got past its first `await` — the `store.list` — before the
next navigation tore the document down.** Nothing had been removed. The file that is "back" is the
file the deletion never took, and it comes back at the reload because it never went.

This is ticket 20's own measurement, in a mirror. ADR-0017's "Rule 3, amended" says a document being
unloaded does not run the continuation of an asynchronous store operation. Ticket 20 read that as a
statement about **edits** and built the write-ahead journal for them. A deletion is the same shape —
list, delete each file, reclaim, several awaits deep against OPFS — and had none of the protection.

**Nothing about the journal was weakened.** The replay is doing its job here, and an edit to a
Project that still exists still survives a real navigation; ticket 20's whole subject is untouched.
Had the journal been "fixed", this defect would have remained at 20% and ticket 20's would have come
back.

The test's own two `toHaveCount(0)` assertions were near-vacuous — they pass against a page that has
not rendered its list yet, which is exactly the state a fresh reload is in — which is why the run
that found this failed on the *file list* and not on them.

## What was built

The gesture is recorded synchronously, and the next startup carries it out.

- `packages/core/src/autosave/deleted-projects.ts` — `DeletedProjects`, keyed by Workspace **and**
  directory. One synchronous `localStorage` write per deletion, dropped the moment the removal has
  actually happened. It holds no bytes: it is not a trash can and deleting a Project is still not
  undoable.
- `packages/core/src/project/workspace.ts` — `deleteProject` records **before its first `await`**;
  `finishInterruptedDeletions()` carries out what a lost page could not; `#claim` drops the record
  when a new Project takes the folder name.
- `packages/core/src/autosave/replay.ts` — a second layer: `ReplaySkipReason: 'project-deleted'`.
- `apps/editor/src/lib/workspace-storage.svelte.ts` — `finishInterruptedDeletions()` runs inside the
  recovery chain, before the replay and before the `recovered` promise every route waits on.
- `packages/core/src/autosave/workspace-scoped-key.ts` — the two-axis key encoding, extracted from
  `journal.ts` rather than copied.

### The discrimination is the gesture, not the files

Ticket 20's surviving rule — *unreadable is not absent* — is intact and unmodified. The new check
does not weaken it; it supplies the one fact it could never derive.

`<project>/project.json` is exempt from every existing precondition in `missingOwner`, and it has to
be: writing that file is what *makes* the Project exist, so an interrupted `createProject` has no
directory to point at. No question asked **of the store** can tell that apart from an edit to a
Project the user just deleted — the directory is absent in both. The question asked instead is "did
the user delete this Project", which the application knows for certain because it is the thing the
user did.

### The fresh data-loss path this could have opened, and how it is closed

A record naming a folder name outlives nothing but the deletion — and folder names are reusable. A
record left behind after "Amsterdam 1625" is made again would let the next startup delete the *new*
Project. `Workspace.#claim` drops it **synchronously, with no `await` between there and the write
that creates the Project**. An await in between would be the same window in miniature, which is the
shape of the two fresh paths ticket 20's first cut opened. It is pinned by its own test, and by a
mutation.

## The mutation check

Every mutation below was applied, run, and restored.

| # | mutation | result | what went red |
| --- | --- | --- | --- |
| M1 | remove `#deleted.record` from `Workspace.deleteProject` | **RED** | e2e `--repeat-each=20`: 2 flaky / 18, retry budget 10.00%; and `writes the gesture down before its first await` |
| M2 | remove `finishInterruptedDeletions()` from `WorkspaceStorage.#replayAndReport` | **RED** | e2e `--repeat-each=20`: 2 flaky / 18, retry budget 10.00% |
| M3 | disable the `project-deleted` branch in `missingOwner` | **RED** | 2 core tests in `replay.test.ts` |
| M4 | remove `#claim` from `createProject` | **RED** | `drops the record when a new Project claims the deleted one's folder name` |
| M5 | never `forget` after a successful removal | **RED** | `forgets the record once the removal has actually happened` |

M1 and M2 reproduce at ~10% rather than the original 20% because each removes one of the two halves
that now have to fail together; either alone still leaves a narrower window. Both are far above the
0.5% budget and both fail the run.

## The numbers

`e2e/editor-workspace.e2e.ts -g "does not put an edit back into a Project the user deleted"`,
`--repeat-each=20`, on a quiet machine, no `--reporter=` on the command line:

| | flaky | passed | retry budget |
| --- | --- | --- | --- |
| before | **4** | 16 | **20.00%** — run failed |
| after | 0 | 20 | **0.00%** — run passed |

## What the second round found, and what it changed

Two independent reviews confirmed the diagnosis — the record really is written before the first
`await`, ticket 20 is untouched, "unreadable is not absent" is intact — and then found nine things.
All nine are addressed below.

### 1. The fix had opened a worse path than the one it closed

`finishInterruptedDeletions` had **no precondition at all**: it took each name out of `pending()` and
removed every file under it. A folder Workspace's key is `folder:<folder name>`, because the browser
offers a page no stable identifier for a picked directory; ADR-0017 records that collision and
*bounds* it — a wrong-Workspace **replay** can only write into a Project whose `project.json` is
already there, so its worst case is one overwritten file the user is told about. A wrong-Workspace
**deletion** had no bound at all, and the route is entirely inside documented behaviour (ADR-0023
invites synced folders, second checkouts and colleagues' copies):

> delete `amsterdam-1625` in folder Workspace `maps` on a laptop → torn down in the 20% window this
> ticket exists for → record left → open a *different* folder also called `maps` → that folder's
> `amsterdam-1625` and everything in it is removed before the listing renders.

The destructive step now has a precondition of its own, and it is the same evidence the deletion had:

- `DeletedProjects.record(directory, was)` also writes **what the Project was** — the display name and
  `updatedAt` out of the summary the hub was rendering.
- `#removeEverythingIn` removes `project.json` **last**, so an interrupted deletion always still has
  its evidence. Ordered for the interruption rather than for the success, exactly as
  `deleteHistoricalMap` documents for its own order.
- `finishInterruptedDeletions` reads the manifest and removes nothing unless it still says what the
  record says. A reserved name is refused; a record with no `was` is refused; a manifest that will
  not read is refused; anything that does not match is refused and **named**. The record is kept, not
  swallowed, because the Workspace it belongs to may still turn up.

What is left is a bound of replay's shape and no larger: an unfinished deletion can only be finished
against a Project whose manifest is still the one the user deleted. It also closes the second half of
the same hazard the review named — `#claim` fires from `createProject` and `duplicateProject` and
never from *opening* an existing Project, so a Project reopened and edited after a failed deletion
could be removed under the user at a later startup. Its `updatedAt` has moved, so it is refused.

### 2. `deleteHistoricalMap` had the same inversion, and worse

Its first `await` is `historicalMapUsage` — a walk of every Project in the Workspace, a far wider
window than the single `store.list` that lost 4 runs in 20 — and it destroyed the journal
*synchronously* and did the deletion *asynchronously*. A reload in between lost the user's unsaved
Alignment edit **and** left the map in place: data loss with no deletion to justify it. The sweep is
now after the `await`, and **conditional**: `HistoricalMapPartlyDeletedError` is the only failure that
means bytes are gone, and `HistoricalMapInUseError` is a refusal taken before anything is deleted, so
sweeping on it would be the same loss by the opposite mistake. Three unit-seam tests.

The *ordering* of the deletion itself is unchanged and not claimed fixed: it is deliberately arranged
so a half-deleted map stays listed and can be finished, which is a design decision core states in
words.

### 3. A startup deletion is no longer silent

`EditorSession.deletionReport` carries all three lists, and `RecoveredEdits` renders them in the same
panel as the replay — carried out, refused with the reason, and could-not-be-done-yet.
`finished` names only directories where something was actually removed, so the ordinary case (the
removal *had* finished and only the note was lost) reports nothing: the destructive side of
`replayJournal`'s "nothing is reported as restored that was not written".

### 4. A failed `record()` is answered

The boolean was being dropped. `WorkspaceOptions.onDeletionNotRecorded` carries it to
`EditorSession.deletionWarning`, rendered beside `protectionWarning` — **two refusals, not one**. The
comment claiming `protectionWarning`'s sibling "already says so in words" was wrong and has been
replaced with why.

### 5, 6, 7. The sweeps and the two test defects

- `#removeWorkspace` now discards the Workspace's deletion records as well as its journal, and
  `refreshOrphanedJournals` sees both prefixes, so an orphaned record can be seen and thrown away
  from Workspace settings like the journal keys beside it in the same 5 MB.
- The e2e's `emptyWorkspace` now clears `ballastella.deleted.` as well as `ballastella.journal.`,
  because `seedProject` writes straight into OPFS and bypasses `#claim`.
- `editor-folder-workspace.e2e.ts`'s second `toHaveCount(0)` after the reload is gated on
  `inBrowserStorage(page)`. Verified vacuous: with the named deletion applied *and* the gate removed
  the test passes; with the gate it fails.

### 8, 10. The two missing criteria, and the minor list

Unit seams for the journal sweep on `deleteProject` and for a genuinely half-removed directory; the
dead `DeletedProjects.workspace` getter is gone; `has`'s and `pending()`'s error paths are tested;
`finishInterruptedDeletions` refuses a reserved name; and `#claim`'s comment no longer rests on an
ordering nothing pins — the safety is re-derived and tested with the order inverted.

### 9. The `project-deleted` layer, adjudicated

**The reviewer was right that it could be disarmed, and the mechanism is worse than they described.**
`EditorSession.deleteProject` emptied the *journal* and left `Autosave`'s own pending bytes in place —
and the journal is written *from* those bytes. So rule 3 undid the sweep by two routes, not one:
`capture()` re-journals `<project>/project.json` at `pagehide` after the sweep, and `flush()` writes it
into the store outright. Neither is caught by the `project-deleted` branch, because by the next
startup the deletion has finished and its record has been dropped.

No ordering fixes this — `pagehide` can fire at any point after the click — so the source is swept
instead: `Autosave.abandon(prefix)` drops the pending bytes, the timers and the journal entries
together, and `deleteProject` and `deleteHistoricalMap` both go through it. Pinned at both seams.

With that closed, the honest description of the layer stands and the ticket's original wording was
overstated: `finishInterruptedDeletions` runs before the replay and forgets each directory it
removes, so `deleted.has(owner)` is normally `false` by the time `replayJournal` reads it. **The
branch fires only when the deletion could not finish** — an unreachable store, a refused record. It is
a unit-tested fallback for that case, not a second layer carrying ordinary traffic.

## The second round's mutation check

Every mutation below was applied, run, and restored.

| # | mutation | result | what went red |
| --- | --- | --- | --- |
| M6 | `finishInterruptedDeletions` ignores the recorded identity | **RED** | 2 in `workspace.test.ts`: the same-named folder, and the Project since edited |
| M7 | `#removeEverythingIn` removes `project.json` first again | **RED** | `removes the manifest last, so an interrupted deletion keeps its evidence` |
| M8 | a record with no `was` is carried out | **RED** | `refuses to finish a deletion whose record does not say what it was aimed at` |
| M9 | drop the reserved-name guard | **RED** | `refuses to finish a deletion naming one of the Workspace's own directories` |
| M10 | drop the answer `record()` gives | **RED** | `says so when the browser will not write the deletion down` |
| M11 | `abandon` forgets the journal only, as before | **RED** | 3 in `autosave.test.ts`, and `gives up the pending bytes too` at the editor seam |
| M12 | sweep the Historical Map's journal before the `await` again | **RED** | 2 in `editor-session.test.ts` |
| M13 | sweep it unconditionally in the `catch` | **RED** | `keeps the unsaved Alignment when the deletion is refused` |
| M14 | never set `deletionReport` | **RED** | e2e `says at startup which Project it finished deleting` |
| M15 | `#removeWorkspace` discards the journal only | **RED** | e2e `takes the Workspace's unfinished deletions with it` |
| M16 | `refreshOrphanedJournals` walks the journal prefix only | **RED** | e2e `reports and discards an unfinished deletion left by a Workspace that is gone` |
| M17 | "forget the folder" clears memory and skips the store | **RED** | e2e `forgets the folder when browser storage is chosen deliberately` — and **GREEN** with the new gate removed, which is the point |

M11's first spelling *survived*, and so did the first spelling of its editor-seam test: both were
written against an edit that had already drained. Rewritten against a write that has started and not
landed — the state `Autosave` actually holds bytes in — both go red.

## The second round's gate

On the final tree, in this order, no `--reporter=` anywhere and nothing piped through `grep`:

| command | exit |
| --- | --- |
| `pnpm run check` | **0** |
| `pnpm run lint` | **0** |
| `pnpm run test` | **0** |
| `pnpm run test:e2e` (whole suite) | **0** — 490 passed, 1 skipped, 23.3m, retry budget 0.00% of 491 |
| `playwright test e2e/editor-workspace.e2e.ts --repeat-each=20` | **0** — 740 passed, 11.2m, retry budget 0.00% of 740 |

The two `✘` lines in `editor-network-fence.e2e.ts` are its `test.fail()` controls, which are expected
failures and are what the run passing means.

**Contention was heavy and is worth recording**: tickets 07 and 22 were running in other worktrees
throughout. One-minute load average on the 20-core machine ranged from **38 to 87** during these
runs, which is why the full suite took 23 minutes. Nothing went flaky under it; the retry budget was
0.00% on both runs.

## Deliberately not done

- **`TRACKER.md` was not edited**, as instructed. Open lead 1 is closed by this work but the tracker
  still describes it, including its wrong hypothesis about the replay. Whoever merges this should
  correct it.
- **The retry budget was not raised**, and no assertion was made to wait, retry, or observe later.
  The one assertion added to the e2e waits for the hub's *empty state* before two `toHaveCount(0)`
  checks that were passing vacuously — that strengthens them and cannot mask the defect, which is
  asserted against the file list.
- ~~**`FinishedDeletions.unfinished` is returned but not rendered.**~~ Done in round 2: all three
  lists are rendered in `RecoveredEdits` (SPEC stories 111, 112).
- **`deleteHistoricalMap` was given the inversion fix and not the write-ahead record.** The
  "destroy synchronously, justify asynchronously" pair is closed and pinned. What it still does not
  have is `DeletedProjects`' own protection — a gesture written down so a torn-down page's deletion
  is finished at the next startup. Its partial-failure design already leaves a half-deleted map
  *listed* and finishable by hand, which is a real answer and not the same hole; giving it the full
  treatment means recording a map identity and a second recovery step, and is its own ticket.
- **A refused record is reported at every startup, with no per-record way to be rid of it.** It is
  kept deliberately — the Workspace it belongs to may still turn up, and dropping it would lose a
  real deletion — and the panel is dismissible, so the cost is one sentence per startup for as long
  as two folders of the same name are both in play. Workspace settings can discard records for a
  Workspace it is *not* in; a "forget this deletion" beside the refusal is the natural next piece of
  UI and was not built.
- **Nothing re-`claim`s a Project on `open`.** With the manifest precondition in place a reopened and
  edited Project is refused rather than deleted, and the refusal is now named to the user with a
  discard offered in Workspace settings — so the hole is closed without a `localStorage` write on a
  path ADR-0010 and `editor-opening-view.e2e.ts` hold to "opening writes nothing at all".
- **Open lead 2 (the OpenSeadragon `forceRedraw` throw) was not touched.**

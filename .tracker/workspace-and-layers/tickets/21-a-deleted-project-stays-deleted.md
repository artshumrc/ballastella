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

## Deliberately not done

- **`TRACKER.md` was not edited**, as instructed. Open lead 1 is closed by this work but the tracker
  still describes it, including its wrong hypothesis about the replay. Whoever merges this should
  correct it.
- **The retry budget was not raised**, and no assertion was made to wait, retry, or observe later.
  The one assertion added to the e2e waits for the hub's *empty state* before two `toHaveCount(0)`
  checks that were passing vacuously — that strengthens them and cannot mask the defect, which is
  asserted against the file list.
- **`FinishedDeletions.unfinished` is returned but not rendered.** A deletion that could not be
  finished — an unplugged drive — is kept, retried at every startup, and the Workspace's existing
  "not reachable" state is what the user sees. A dedicated notice beside `RecoveredEdits` would be
  the honest end state (SPEC stories 111, 112) and is a small piece of UI work this ticket did not
  take on.
- **Historical Map deletion was not given the same protection.** `EditorSession.deleteHistoricalMap`
  has the identical shape and is presumably identically exposed. It was not measured and is not
  claimed fixed.
- **Open lead 2 (the OpenSeadragon `forceRedraw` throw) was not touched.**

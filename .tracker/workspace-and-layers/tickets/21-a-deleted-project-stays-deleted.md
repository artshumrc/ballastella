# A deleted Project stays deleted

> **This file was not in git when the work started** — an orchestration error: it was written and
> then dispatched before being committed, so it was in no commit reachable from any branch and the
> ledger still stopped at 20. The work was done instead from **open lead 1** in `TRACKER.md`, which
> carried the captured failure text, the pinned sequencing and the measured rate. That turned out
> not to matter, because the lead's own diagnosis was wrong and this ticket's premise inherited it —
> see below. What follows is the record of what was actually found, and it supersedes the brief.

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
  `deleteMapImage` documents for its own order.
- `finishInterruptedDeletions` reads the manifest and removes nothing unless it still says what the
  record says. A reserved name is refused; a record with no `was` is refused; a manifest that will
  not read is refused; anything that does not match is refused and **named**. The record is kept, not
  swallowed, because the Workspace it belongs to may still turn up.

What is left is a bound of replay's shape and no larger: an unfinished deletion can only be finished
against a Project whose manifest is still the one the user deleted. It also closes the second half of
the same hazard the review named — `#claim` fires from `createProject` and `duplicateProject` and
never from *opening* an existing Project, so a Project reopened and edited after a failed deletion
could be removed under the user at a later startup. Its `updatedAt` has moved, so it is refused.

### 2. `deleteMapImage` had the same inversion, and worse

Its first `await` is `mapImageUsage` — a walk of every Project in the Workspace, a far wider
window than the single `store.list` that lost 4 runs in 20 — and it destroyed the journal
*synchronously* and did the deletion *asynchronously*. A reload in between lost the user's unsaved
Alignment edit **and** left the map in place: data loss with no deletion to justify it. The sweep is
now after the `await`, and **conditional**: `MapImagePartlyDeletedError` is the only failure that
means bytes are gone, and `MapImageInUseError` is a refusal taken before anything is deleted, so
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
together, and `deleteProject` and `deleteMapImage` both go through it. Pinned at both seams.

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
| M12 | sweep the Map Image's journal before the `await` again | **RED** | 2 in `editor-session.test.ts` |
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
- **`deleteMapImage` was given the inversion fix and not the write-ahead record.** The
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

## What the third round found, and the design it changed

A focused re-review found the wrong-folder recursive delete **still reachable by three doors**, and
all three were the same door.

### The root cause: identity was being established from content, and content is copyable

- **(a)** `PathNotFoundError` from `readProject` was read as "the directory is empty". It means the
  *manifest* is missing. `#removeEverythingIn` then listed the directory and deleted **everything it
  found**, reporting it as a deletion carried out because `removed > 0`. Reachable with a Drive or
  Dropbox folder mid-sync where `annotations/*.geojson` have landed and `project.json` has not, a
  partial checkout, or any directory of that name that was never a Project. No test covered it: the
  one that looked like it seeded an **empty** store, so the branch only ever ran against nothing.
- **(b)** The unreadable-manifest hatch degenerated to the name-only check round 1 had. `#summarise`
  renders both `ProjectFormatTooNewError` and `ProjectFileUnreadableError` as `{name: directory,
  updatedAt: ''}`, so the comparison was of the directory name and nothing else — the part the
  module header itself calls "exactly the part that is *not* unique". Two folders called `maps`,
  both holding a Project too new for this build, is the likely case rather than the unlikely one: it
  takes one newer build to write both.
- **(c)** **A copy is byte-for-byte the Project the user deleted, because it *is* that Project.**
  Round 2's stated bound — "a Project whose manifest is still byte-for-byte the one the user
  deleted" — is literally true and is the defect. Dropbox, Drive, rsync, `cp -a` and a zip reproduce
  `project.json` exactly, and ADR-0010 guarantees opening writes nothing, so it stays identical.
  Delete on the laptop, get interrupted, open the **backup**: every field matches and the backup is
  destroyed.

A fourth comparison fails the same way, so the design changed instead.

### The decision: identity is a property of the key, and only one key has it

`WorkspaceIdentity` in `project/workspace.ts`, asked for once and derived from the Workspace key in
one function (`workspaceIdentityOf`) beside the two constructors that make keys:

- `'this-browser'` — `opfs:<name>` names exactly one directory this origin owns and no other page
  can produce. A deletion recorded against it can only ever be finished in the directory it was made
  in, so unattended completion stays, and the original defect stays fixed there.
- `'a-name-anywhere'` — `folder:<folder name>`, a name a user can put on any folder on any drive.
  **Nothing is finished unattended.** The Project is listed, the user is told plainly that its
  deletion did not finish and why Ballastella will not finish it, and deleting it again is one
  gesture. Visible and non-destructive, which is what ADR-0017 asks of the rest of the chain.

The default is `'a-name-anywhere'`: a caller that has not said which it is has not established
identity.

`was` keeps a smaller and truthful job — **has this Project changed since the gesture** — which is
the case `#claim` cannot see, because it fires from `createProject` and `duplicateProject` and never
from opening a Project. It is no longer described as an identity check anywhere.

### What else the third round changed

- **(a) has a third verdict.** `#verdictOn` answers `'remove' | 'forget' | 'refuse'`. With only two,
  "there is no manifest here" had to be spelled `'remove'`. `'forget'` drops the record, sweeps this
  application's own abandoned temporary files, and takes nothing.
- **(d)** `#forgetJournalled` abandoned `images/<id>/` only, and `alignmentPath(id)` is
  `alignments/<id>.json` — a *sibling*. So on the one path where the unsaved specimen **is** the
  Alignment, its journal entry was forgotten and the pending bytes it is written from were not:
  `capture()` re-journalled it at `pagehide` and `flush()` wrote it, recreating an Alignment for a
  map that is gone. The test that missed it asserted only that the journal was empty.
- **(e)** A Project whose manifest carries no name could never have its deletion finished, and
  leaked a record for ever: `#summarise` published `file.name || directory` and the check compared
  the raw `file.name`. There is now one spelling, `identityOf`, used by both.
- **(f)** Refusals no longer leak without a remedy. A reserved-name record is said **once** and then
  dropped — it can never license anything at any startup. A record whose Project is genuinely gone
  is dropped silently, which is the `was === null` case the round-2 text admitted had no remedy
  ("delete it again if it is still here" — there was nothing to delete). Every refusal that survives
  now names a Project that is present in the list, and the gesture that ends it is one click.
- **(g)** `deleteMapImage` swept its abandoned writes **after** every file was deleted, so a
  rejection there left the map entirely gone and threw something that is neither `InUse` nor
  `PartlyDeleted` — falsifying the rule the caller sweeps its journal by. Wrapping it in a
  `PartlyDeleted` would have been the opposite lie ("it is still listed, and deleting it again will
  finish the job"). It sweeps **first** now: nothing has been removed when it runs, and no `delete`
  below it can make a temporary file for it to have missed.
- **(h) is real, and is fixed.** See the adjudication below.
- **Dead / over-claimed.** `DeletionRecord.at` is gone from the decoded record (the stored `at`
  stays, for whoever is reading `localStorage`). `StoredRecord.formatVersion` was written and
  ignored; it is now **validated**, so a record from a build that spells `was` differently reads as
  no evidence rather than being read with this build's rules — `readJournal` already did this, and
  this is the destructive half of the same chain.

### (h), adjudicated: CONFIRMED, and fixed

`Autosave.abandon` cannot call back a write the store already has. `#drainLoop` captures its `bytes`
and then awaits `store.write`; clearing `pending` does not reach into that await. So a
`<project>/project.json` write in flight when Delete is pressed — a rename whose debounce timer has
just fired — resolves **after** `#removeEverythingIn` has listed the directory, writes the manifest
back behind the deletion, and `deleteProject` then drops its own record on the next line. The
Project is back at the next startup with nothing left to catch it: the ticket's own defect, by a
route the sweep could not see. `editor-session.test.ts` already constructed this state and asserted
only that the journal was empty.

`abandon` now answers with a promise: everything it *can* stop is stopped before it returns, and the
promise is for the writes it could not. The `abandon` call itself moved into
`Workspace.deleteProject` — beside the record it has to be ordered against, and for the reason
`record` is in there: no second route to deleting a Project can opt out. It is waited on **after**
the synchronous record and **before** the removal, so the guarantee this whole ticket rests on is
untouched: if the page dies during that await, the record is written and the next startup finishes
the job.

The same window is **not** closed for `deleteMapImage`, deliberately: its sweep runs after the
deletion, so waiting there buys nothing, and closing it properly means abandoning *before* the
deletion — which is the "destroy synchronously, justify asynchronously" inversion round 2 removed
from that exact method. It is named in the code and left open rather than traded for the larger
hazard.

### The vacuous list

Six of them were user-facing behaviour that ADR-0017 and SPEC stories 111/112 require, so they were
**covered rather than deleted**: `deletionsAreNoteworthy`'s `refused` and `unfinished` terms (four
core tests), the `deletion-refused` arm and the "A deletion was not finished" heading (an e2e), the
`deletion-warning` render and its `onDeletionNotRecorded` wiring (an e2e that makes every
`ballastella.deleted.` write throw, which is Safari with cookies blocked), and the `PartlyDeleted`
sweep at the editor seam (a unit test that half-deletes a map). `autosave.ts`'s `if (!file.draining)`
is load-bearing now — it is what makes the returned promise mean anything — and is pinned by M24.

`workspace-storage.svelte.ts`'s dedupe, sort, and `discardDeletions` count are **not** covered and
were not deleted: they are one expression each behind a real button, and the arithmetic is asserted
nowhere. Named here rather than left to be found again.

## The third round's mutation check

Every mutation below was applied, run, and restored.

| # | mutation | result | what went red |
| --- | --- | --- | --- |
| M18 | `finishInterruptedDeletions` ignores `WorkspaceIdentity` | **RED** | 2 in `workspace.test.ts`: the same-named folder, and the byte-identical copy |
| M19 | `PathNotFoundError` reads as “remove everything here” again | **RED** | `removes nothing from a directory that has files and no manifest` |
| M20 | the summary's identity compares the raw `file.name` again | **RED** | `finishes the deletion of a Project whose manifest carries no name` |
| M21 | a reserved-name refusal keeps its record | **RED** | `refuses a deletion naming one of the Workspace's own directories, and drops the note` |
| M22 | `deleteProject` does not wait out the writes `abandon` could not stop | **RED** at the editor seam | `waits out a write it could not call back…`. **GREEN** in `workspace.test.ts`, which constructs no autosave — recorded because it says which seam holds this |
| M23 | `deleteProject` does not abandon at all | **RED** at the editor seam | `gives up the pending bytes too…` and `waits out a write it could not call back…` |
| M24 | `abandon` answers nothing about the write it could not stop | **RED** | `answers with a promise for the write it could not stop` |
| M24b | `abandon` drops the entry of a path being written to | **RED** | `leaves a path being written to one writer, even after abandoning it` |
| M25 | `#forgetJournalled` abandons `images/<id>/` only, as before | **RED** | `gives up the Alignment's pending bytes, not only its journal entry` |
| M26 | `deleteMapImage` sweeps its abandoned writes last again | **RED** | 2 in `map-images.test.ts` |
| M27 | `decode` ignores `formatVersion` again | **RED** | `reads a record written to another format as no evidence` |
| M28 | `deletionsAreNoteworthy` reads `finished` only | **RED** | 2: the refused arm and the unfinished arm |
| M29 | `EditorSession` claims `'this-browser'` for every Workspace | **RED** | e2e `will not finish a deletion on its own in a folder, and says so` |
| M30 | `NavigationBar` drops the `deletion-warning` render | **RED** | e2e `says when the browser will not write a deletion down` |
| M31 | `RecoveredEdits` drops the `deletion-refused` arm | **RED** | e2e `says at startup which deletion it would not carry out, and leaves the Project alone` |

M22's split is the honest reading and not a gap: the wait exists for bytes `Autosave` is holding, and
`workspace.test.ts` builds a `Workspace` with no autosave at all. The seam that can hold that state
is the editor's, and that is where it is pinned.

## The third round's gate

On the final tree, no `--reporter=` anywhere and nothing piped through `grep` — exit codes read
directly:

| command | exit |
| --- | --- |
| `pnpm run check` | **0** |
| `pnpm run lint` | **0** |
| `pnpm run test` | **0** — core 1676 passed / 15 skipped, editor 28 passed |
| `pnpm run test:e2e` (whole suite) | **0** — 493 passed, 1 skipped, 11.6m, retry budget 0.00% of 494 |
| `playwright test e2e/editor-workspace.e2e.ts --repeat-each=20` | **0** — 780 passed, 6.5m, retry budget 0.00% of 780 |

**Contention, as a number**: seven `playwright test` processes were running across five worktrees
throughout, and the one-minute load average on the 20-core machine ranged from **9 to 26** during
these runs. Nothing went flaky under it; the retry budget was 0.00% on both runs.

## Deliberately not done in round 3

- **A folder Workspace no longer finishes a deletion unattended, and that is a real reduction in
  what the app does for the user.** It is the point: the alternative is a recursive delete in a
  directory nothing can identify. The Project is listed and one click removes it.
- **No per-folder nonce.** It would give a folder Workspace a real identity, and it is a **write on
  a path** — into the user's own folder, at pick time. ADR-0010 and `editor-opening-view.e2e.ts`
  hold "opening writes nothing at all", ADR-0008 makes the folder the product (zipped, cloned,
  committed), and a sync client copies the nonce with everything else, so two copies of a folder
  would share it anyway and the identity would be false. Rejected on both counts.
- **`deleteMapImage`'s in-flight write window** — see the adjudication above.
- **A "forget this deletion" control beside a refusal** was still not built. With (f) closed, every
  surviving refusal names a Project that is in the list, so the control already exists: it is Delete.
- **`TRACKER.md` was not edited**, as instructed.

## What the fourth round found

A focused re-review traced every construction path and confirmed the design: no reachable
wrong-folder recursive delete remains, all three of round 2's doors are shut, and the `abandon`
plumbing, the synchronous guarantee, `formatVersion` validation and the `map-images` reordering
all hold. Five things were left.

### 1. The round's headline claim was a sentence in a comment

`this.#identity = options.identity ?? 'a-name-anywhere'` — **flip that default to `'this-browser'`
and the whole suite stayed green.** Round 3 gave every test with a reachable store an explicit
`identity`, and production always passes one, so the default's only consumer is a future caller and
nothing told that caller they had got it wrong. That is the same shape as the two things the previous
rounds were about: a bound asserted in prose. It is now pinned by a test that builds a `Workspace`
with a matching record, a reachable store, and **no** `identity`.

### 2. A folder Workspace's refusal was permanent, and its only exit destroyed somebody else's work

The case the refusal exists for: the user opens a colleague's `maps`, which holds its own
`amsterdam-1625` with a readable manifest. Step 2 does not clear the record, step 3 refuses, the note
is kept — and **nothing ends it**. No record expires; `#claim` fires only on create and duplicate;
`discardOrphanedJournal` is by construction unable to reach the Workspace that is *open*, which is
always the one showing the refusal; and the panel's "Got it" is keyed on the report's contents, so
the next startup builds a byte-identical report and shows it again. Since round 3 made a refusal the
**only** thing a folder Workspace ever reports, that is a warning at every visit for ever — whose one
offered remedy, *"delete it again from the list"*, destroys the colleague's Project.

This is the argument the reserved-name branch already uses to justify dropping its record, applied to
a case round 3 made common. `EditorSession.forgetDeletion` and a **"Forget this note"** control
beside each refusal are the exit that costs nobody a file: it removes a note about a deletion, never
a byte. The sentence now offers both, and names the non-destructive one for the case it is written
for. Pinned across a reload, because "it stops" is a claim about the *next* startup and a
content-keyed dismissal is exactly what could not deliver it.

Same finding by a second route: an unknown `formatVersion` refuses safely but was described as *"this
browser did not keep a note of which Project it named"*, which is plainly false of a newer build that
kept a perfectly good one. The two causes have the same remedy, so they get one sentence that is true
of both rather than a field to tell them apart.

### 3. `workspaceIdentityOf` was reachable only through the browser suite

The function the design turns on — two lines of prefix matching, and exactly the kind of thing that
gets "simplified" by somebody who has not read the two hundred lines of comment behind it — now has
its own unit tests, including that `opfs:` must be where the key *starts*. The unreachable ternary
beside its production call is gone: `workspaceIdentityOf(options.workspaceKey ?? '')` answers
`'a-name-anywhere'` for the empty key, so the safe direction is the function's and not a branch a
reader has to check.

### 4. The `'forget'` branch's sweep was unasserted

Deleting `reclaimAbandonedWrites` from it left the suite green. It is **kept and asserted** with a
planted temporary file rather than dropped: `#adopt` sweeping the whole Workspace immediately before
`finishInterruptedDeletions` is an ordering in the app that no test and no type pins, and "it is safe
because of the order somebody happens to call it in" is the argument `#claim`'s comment had to stop
making.

### 5. The reason for leaving `deleteMapImage`'s window open was not sound

The round-3 comment said closing it meant reintroducing the inversion review 2 removed. **That is
wrong, and it proved too much** — `Workspace.deleteProject` does abandon-before-removal two files
away. What made the old ordering an inversion was not `abandon`'s position but that it *destroyed the
user's only copy* — the journal entry holding an unsaved Alignment — before anything justified
destroying it.

And there was a third option. `Autosave.settled(prefix)` is `abandon`'s half that destroys nothing:
it waits for the store to be quiet under a prefix, drops no pending bytes, clears no timers and
touches no journal entry. It is awaited before `deleteMapImage`, so an Alignment write in flight
cannot land after the deletion removed `alignments/<id>.json` — the orphaned placement that function
exists to prevent. `#forgetJournalled` runs unchanged, after.

### The two PLAUSIBLE items, adjudicated

- **`await abandon()` could block a deletion indefinitely — CONFIRMED, and fixed.** A folder whose
  grant was revoked mid-write, or an OPFS handle a second tab tore down, leaves `store.write` pending
  with nothing to reject it; before round 3 `abandon` was synchronous and the removal ran regardless.
  Unbounded, that is a Delete button that does nothing for ever with the Project still on screen —
  and in a folder Workspace it compounds into finding 2. The wait is bounded now and **answers
  whether it gave up**: `deleteProject` removes the files either way, and **keeps its record** when
  the answer is `false`, because the write still out there may land after the listing. A silent
  timeout would have reintroduced round 3's own defect.
- **Focus lost when the panel dismisses itself — CONFIRMED, and fixed.** "Got it" removes the
  `<section>` containing it, dropping focus to `<body>`. Pre-existing from ticket 20; round 3 made it
  load-bearing, because this panel is now the only surface a folder Workspace's deletions are
  reported on. Focus goes to `<main>`, and the "Forget this note" control does the same.

### Adjacent, fixed

`WorkspaceSettings` rendered `discardOrphanedJournal`'s return as *"Threw away N unsaved changes"*,
and since round 2 that number was `discardJournal(...) + discardDeletions(...)` — so a Workspace
holding only a deletion note reported "1 unsaved change", false in both nouns and silent about the
one of the two that carries a standing instruction to delete a Project. Two counts now, named
separately, and the existing e2e that discards exactly that Workspace asserts the sentence.

## The fourth round's mutation check

Every mutation below was applied, run, and restored.

| # | mutation | result | what went red |
| --- | --- | --- | --- |
| M32 | the identity default becomes `'this-browser'` | **RED** | `finishes nothing unattended for a caller that did not say what the Workspace is` |
| M33 | `deleteProject` forgets the record even when the wait gave up | **RED** | `deletes anyway when a write will not settle, and keeps the record because it might land` |
| M34 | the in-flight wait has no bound | **RED** | `gives up on a write that is never going to settle, and says it gave up` |
| M35 | `settled` answers `true` without looking | **RED** | `waits for a path without giving anything up` |
| M36 | the `'forget'` branch drops its abandoned-write sweep | **RED** | `removes nothing from a directory that has files and no manifest` |
| M37 | `forgetDeletion` updates the panel and not the record | **RED** | `forgets the note behind a refusal, and takes the panel with the last one` |
| M38 | `workspaceIdentityOf` matches `opfs:` anywhere in the key | **RED** | `calls anything it does not recognise a name anywhere` |
| M39 | `RecoveredEdits` drops the "Forget this note" control | **RED** | e2e `forgets a refused deletion's note, and it stays forgotten across a reload` |
| M40 | dismissing the panel does not move focus | **RED** | e2e `says that it put the change back, in text a screen reader is given` |
| M41 | the discard sentence sums the two counts again | **RED** | e2e `reports and discards an unfinished deletion left by a Workspace that is gone` |

## The fourth round's gate

On the final tree, no `--reporter=` anywhere and nothing piped through `grep` — exit codes read
directly:

| command | exit |
| --- | --- |
| `pnpm run check` | **0** |
| `pnpm run lint` | **0** |
| `pnpm run test` | **0** — core 1681 passed / 15 skipped, editor 31 passed |
| `pnpm run test:e2e` (whole suite) | **0** — 494 passed, 1 skipped, 16.7m, retry budget 0.00% of 495 |
| `playwright test e2e/editor-workspace.e2e.ts --repeat-each=20` | **0** — 780 passed, 8.8m, retry budget 0.00% of 780 |

**Contention, as a number**: tickets 07 and 22 were running their own suites throughout. The
one-minute load average on the 20-core machine ranged from **22 to 47** during these runs, which is
why the full suite took 16.7 minutes against round 3's 11.6. Nothing went flaky under it; the retry
budget was 0.00% on both runs.

## Deliberately not done in round 4

- **The in-flight wait is 2 seconds and the number is a judgement**, not a measurement: long enough
  that a merely slow OPFS write is waited for, short enough that a write which is never going to
  settle costs a pause rather than the gesture. It is injectable, so the bound itself is tested
  rather than only its happy path.
- **`deleteMapImage` still has no write-ahead record of its own**, unchanged from round 2's
  note: its partial-failure design leaves a half-deleted map listed and finishable, and giving it the
  full `DeletedProjects` treatment is its own ticket.
- **`TRACKER.md` was not edited**, as instructed.

## What the fifth round found

Round 4's `Autosave.settled` did not close the window round 4 said it closed, and round 3 had been
more honest about the same ground. That is the finding; the rest are its neighbours.

### 1. `settled` waited for the wrong half, and the sentence claiming closure had to go either way

It collected only `file.draining` — a write the store already had — and ignored `file.pending` and
`file.timer`. A file inside its debounce has bytes that have not left `Autosave` at all, so `settled`
answered `true` for it on the spot.

`settled` now brings a pending file **to rest** rather than calling it quiet: the timer is cleared
and the write started now instead of in a few hundred milliseconds. Nothing is discarded — that is
the whole difference from `abandon` — and it is a write the store was about to be given anyway, so
an edit that survives it is on disk and the refusal downstream can still refuse.

⚠ **What that is worth, stated exactly, because overstating it is the mistake being corrected.** The
only caller today sees `commit`, which drains at once, so its *reachable* hazard is the in-flight
case — and the first cut did cover that. On these two prefixes a merely-pending file is also swept by
`#forgetJournalled`'s `abandon` before anything restarts it. So the widening fixes **no currently
reachable orphan**: it makes the method's name true and removes the landmine waiting for the first
caller who queues a debounced write under a prefix they then delete. That is written into the code at
both seams, and **M45 is recorded below as GREEN** rather than dressed up — the editor seam can only
build the in-flight state, and saying otherwise would be round 4's error repeated.

### 2. The same window was wide open for `images/<id>/`, with no sentence at all

`deleteMapImage` removes the pyramid, `image-info.json` and `remote.json` as well as the
Alignment, and `#forgetJournalled` sweeps both prefixes for exactly the reason the Alignment needs
it. The wait covered one of them. It covers both now, through `#quietBeforeDeleting`, which mirrors
`#forgetJournalled` line for line.

⚠ **One prefix per test, and that is not tidiness.** Written as one test holding both writes open,
the two waits sit in the same `Promise.all` and either one alone parks the deletion until both are
released — so removing either call left the suite green and the pair asserted nothing about either.
Found by running the mutation, not by reading.

### 3, 4. Two more bounds that were prose

- **`settled`'s prefix filter was asserted by nothing.** Deleting `path.startsWith(prefix) &&` left
  both tests green — one had a single matching file and the other had none. Unfiltered, one stuck
  write in a Project nobody is looking at would put the whole two-second bound on every Map
  Image deletion, with nothing to say why.
- **The shipped `?? 2000` was asserted by nothing.** Every assertion injected its own bound, so a
  default of zero passed — and zero is not cosmetic: every `deleteProject` with any write in flight
  would answer `false`, keep its record, and produce a startup refusal for a deletion that had in
  fact finished.

### 5. The forget control's focus management was pinned only in prose

M40 asserted focus for **dismiss**; the forget e2e never read `document.activeElement`, so deleting
the whole focus block left everything green. The e2e now constructs **two** refusals, which is what
makes three things falsifiable at once: the "panel is still showing" arm of the focus move,
`bind:this={dismissButton}`, and the accessible names.

### 6. Minor, and one that was not

- `abandon` carried two contradictory `@returns`, the stale one first, so tooling took it. Gone.
- **a11y:** two refusals rendered two buttons both reading "Forget this note", told apart only by
  prose in a `<p>` associated with neither — two indistinguishable controls for the one gesture here
  that is meant to be the safe one, and a strict-mode violation for `getByTestId` the moment a test
  constructs two. Each button's accessible name now carries its folder.
- The `'nothing'` arm of the discard sentence is **reachable**, not dead: a second tab clearing the
  records between the list being built and the click. Its wording no longer reads as a failure of the
  button. The plural arms and the `' and '` join, which nothing exercised, now have their own e2e.

## The fifth round's mutation check

Every mutation below was applied, run, and restored.

| # | mutation | result | what went red |
| --- | --- | --- | --- |
| M42 | `settled` waits only for `file.draining` again | **RED** | `drains a file still inside its debounce, rather than calling it quiet` |
| M43 | `settled` drops its prefix filter | **RED** | `ignores a write in flight somewhere else in the Workspace` |
| M44 | the shipped in-flight bound becomes zero | **RED** | 4 in `autosave.test.ts`, including `waits two seconds by default` |
| M45 | M42, judged at the editor seam | **GREEN** | *Nothing, and it is recorded rather than hidden.* Both editor tests build an **in-flight** write, which the old `settled` did cover; the pending half is reachable only through this class directly, and is pinned there by M42. See §1. |
| M46 | `#quietBeforeDeleting` drops the `images/<id>/` wait | **RED** | `lets an in-flight write under images/<id>/ land before deleting the map` |
| M47 | `#quietBeforeDeleting` drops the Alignment wait | **RED** | `lets an in-flight Alignment write land before deleting the map` |
| M48 | forgetting a note no longer moves focus | **RED** | e2e `forgets a refused deletion's note, and it stays forgotten across a reload` |
| M49 | the forget buttons share one accessible name | **RED** | e2e, same test — the two controls become indistinguishable |

## The fifth round's gate

On the final tree, no `--reporter=` anywhere and nothing piped through `grep` — exit codes read
directly:

| command | exit |
| --- | --- |
| `pnpm run check` | **0** |
| `pnpm run lint` | **0** |
| `pnpm run test` | **0** — core 1684 passed / 15 skipped, editor 33 passed |
| `pnpm run test:e2e` (whole suite) | **0** — 495 passed, 1 skipped, 10.9m, retry budget 0.00% of 496 |
| `playwright test e2e/editor-workspace.e2e.ts --repeat-each=20` | **0** — 780 passed, 8.6m, retry budget 0.00% of 780 |

**Contention, as a number**: tickets 07 and 22 were running their own suites throughout. The
one-minute load average on the 20-core machine ranged from **2 to 52** across these runs. Nothing
went flaky under it; the retry budget was 0.00% on both.

## Deliberately not done in round 5

- **`settled`'s widening is not claimed to fix a reachable orphan**, and M45 is recorded GREEN. See
  §1: today's only caller sees `commit`, and the pending half is pinned against this class directly
  rather than at the editor seam, because the editor seam cannot build it.
- **`deleteMapImage` still has no write-ahead record of its own**, unchanged from rounds 2 and
  4: its partial-failure design leaves a half-deleted map listed and finishable, and giving it the
  full `DeletedProjects` treatment is its own ticket.
- **`TRACKER.md` was not edited**, as instructed.

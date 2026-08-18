# Autosave: debounced write-through with a visible save state

> **Amended by ticket 20: rule 3 as written below was false for the case it was written for, and is now two halves.** "Flush on `visibilitychange` → hidden and on `pagehide`" named the right events and asked them to do something they cannot do. `ProjectStore.write` is asynchronous and a document being unloaded does not run the continuation, so a debounced edit did not survive a real navigation — **measured in a real browser on 2026-08-07, lost 8 times out of 8**. Rule 3 is now *capture synchronously, then flush*: the pending bytes go to a **write-ahead journal** in `localStorage` at the moment the edit is made and again in the listener, and are replayed into the store at the next startup. See "Rule 3, amended" below for the measurement, the reasoning, and what the journal deliberately is not. Rules 1, 2, 4 and 5 are unchanged, and the five-rule list below is otherwise as it was recorded.
>
> **This also amends [ADR-0001](./0001-opfs-first-project-store.md)**, which makes the ProjectStore the one home for user bytes. The journal puts user bytes briefly somewhere else. That is recorded there, in its own section, rather than only here.

There is no Save button. Changes are written through to the ProjectStore automatically, under five specific rules — because "debounced autosave," left under-specified, is how data-loss bugs ship.

1. **Continuous gestures commit on gesture *end*, not on a timer.** Dragging a control point or a shape vertex writes once, on pointer-up. Cleaner than debouncing alone, and a dropped frame never costs a write. Without this rule, a drag is a write storm against the storage layer — worst in OPFS, which is the constrained backend.
2. **Debounce per file, not globally.** Otherwise editing annotations delays the alignment write, and one busy file starves the others.
3. ~~**Flush on `visibilitychange` → hidden and on `pagehide`.**~~ — **amended by ticket 20: capture synchronously to a write-ahead journal, *then* flush.** The events were right and `beforeunload` is still ruled out; the flush alone was never enough. See "Rule 3, amended" below.
4. **Write atomically: temp file, then rename.** Non-negotiable for `project.json`, which holds the layer list — a torn write there loses not one annotation but the map of everything. It is also the most frequently written file, since every visibility toggle and reorder touches it.
5. **Show a save state: saved / saving / unsaved.** With no Save button the user has no other signal, and scholars working on material they care about will not trust a tool that offers none. The user-facing promise should be an indicator that *shows* state rather than copy claiming everything is saved instantly.

## Rule 3, amended — 2026-08-07, ticket 20

### What was measured

**This table is the one home for these numbers.** The code that depends on them points here rather than transcribing them, because four copies of a measurement are four things that can drift from the run that produced them.

Three conditions, in a real browser, against the running application — the first repeated 8 times, the second once, the third 5 times:

| | result |
| --- | --- |
| a debounced Project rename, then a real `page.reload()` inside the 400 ms debounce window | **the edit was LOST, 8 times out of 8** |
| the same edit, with `pagehide` **dispatched** and no navigation | written in 32 ms |
| a synchronous `localStorage.setItem` inside a `pagehide` listener, with a real reload | **survived, 5 times out of 5** |

### Why the original rule could not work

`pagehide` **does** fire on a real navigation, and `Autosave.flush` **is** fast. Neither of those was the problem. The problem is that `ProjectStore.write` is asynchronous in both backends — OPFS's page-context path and File System Access's `createWritable()` are both promises — so `flush` schedules a continuation, and **a document that is being unloaded does not run continuations**. The bytes were still in memory when the page stopped existing.

So rule 3 was not a race that was usually lost. For a real navigation it was never won. It is worth being precise about the shape of that mistake, because it is a shape that recurs: the rule named the correct events and the correct moment, and then asked for work that cannot be performed at that moment. The test that vouched for it dispatched the event instead of navigating, which is the strongest claim that seam can make on its own and is not the user's case.

What was affected, in this build, at the moment the measurement was taken: renaming a Layer or a Project, and Annotation text and style edits — every path that goes through `Autosave.queue`.

### What replaces it

**A synchronous write-ahead journal in `localStorage`**, because the third measurement says something synchronous inside the same handler does survive, and in a browser `localStorage` is the only synchronous durable write a page has.

- **Written at the edit, not only at `pagehide`.** Every `queue` and every `commit` records the pending bytes synchronously; every successful store write forgets them. `pagehide` and `visibilitychange` → hidden then call `Autosave.capture` before `flush`, which re-records anything still pending. That ordering matters — `capture` after `flush` would itself be a continuation.
- **Replayed at startup**, per Workspace, as the Workspace is adopted. **Both routes that read a Project — the hub/Project screen and `/align` — wait on the replay first**, and that gate is a correctness requirement rather than politeness: the first run of the new regression test found a reload that restored the file on disk and left the *old* name on screen, one keystroke away from overwriting the rescue. `/align` is the sharper of the two, because it is bookmarkable and it is where Alignments are written; review found the gate missing there after this section had already claimed it was universal, which is why the claim is now enumerated rather than sweeping.
- **And it reads rather than writes to find out whether it can run at all.** ADR-0010 is that merely opening a Project modifies nothing, and the obvious capability probe — a scratch `setItem` and `removeItem` — is a write at startup, on every load, before anything has been edited. `editor-opening-view.e2e.ts` counts web-storage writes and caught it.
- **Keyed by Workspace as well as by path**, since ticket 12 put several named Workspaces in the OPFS root. The key carries the backing too. A folder Workspace is keyed by its folder's name, which is not unique — a browser gives a picked directory no stable identifier a page may keep — so two folders called `maps` on two drives would share a key. The replay's preconditions bound that, and it is strictly better than the present behaviour, which is that the edit is lost outright.

### Why it is written at the edit rather than at `pagehide`, which is the whole quota argument

`localStorage` is a string-only store of roughly 5 MB per origin, and an Annotation collection can exceed that on its own. A journal write that will not fit **must fail loudly and visibly**, and must never truncate and never silently drop.

At `pagehide` there is no screen left to put a message on and nobody left to read it. That is the argument for recording at the edit instead: a `QuotaExceededError` then happens while the user is still looking at the application, and the app says so — in visible text beside the save indicator, in a `role="alert"` region (SPEC stories 111 and 112), naming the file and its size **the way the application names them** rather than as a store path and a byte count, and distinguishing itself from a failed save, which is a different sentence with a different remedy. `role="alert"` is right here and only here: the refusal is inserted at the moment its text first exists. The two steady-state notices this work also added — a browser with no journal at all, and orphaned entries in Workspace settings — are `aria-live="polite"`, per CONTRIBUTING's mandated-method table, because they are facts that are already true when the page opens rather than events. **A journal refusal is not a failed edit**: the bytes are in memory and the store write still happens. What is lost is the protection, and that is what is said.

A refusal **never removes what is already stored**, and nothing is ever truncated to make room.

⚠ An earlier draft of this decision did remove it, on the argument that an older entry is a state the user passed through and did not stop at, so replaying it would present stale bytes as a rescue. Review found the argument false in the two cases that matter most, and both are moments the journal exists for:

- **The bytes are frequently identical.** `Autosave.capture` re-records every pending file on `pagehide`. If the quota filled in between — another tab, another origin — the write throws on bytes that are *already stored*, and removing then destroys a complete rescue copy at the instant it is needed.
- **It assumed the store write would still happen.** It will not, precisely when it matters: an entry is only still present because the store has *not* taken those bytes, and the commonest reason is a write that failed. Removing then leaves nothing anywhere.

So the policy is: keep what is there, and report the refusal — except when what is there is byte-for-byte the bytes being offered, in which case the file *is* protected and there is nothing to report. Because `forget` runs the moment a write lands, anything still stored is by construction bytes the store has not taken, so replaying it can only move a file toward a state the user reached; and every replay is named to the user, so an older state coming back is visible rather than silent.

**Two refusals, not one.** A full quota and a browser that will not store anything at all get different messages, because they have different remedies and one of them has none. Safari with cookies blocked hands the page a `localStorage` that answers a read and rejects every write, which the read-only capability probe accepts; reported as "no room" it would send a scholar to clear other sites' data for ever.

The cost of recording at the edit is one synchronous `setItem` per keystroke on a debounced field. That is the same order as the `JSON.stringify` of the whole collection which that keystroke already performs before reaching `Autosave` at all.

### What the journal refuses to replay, and says so

Nothing is reported as restored that was not written — the mistake ticket 13 shipped and review caught. The report has four lists, and the user sees all four:

- An entry that **does not parse** is discarded and named. There is nothing recoverable in it, and keeping it would make the notice permanent.
- An entry from a **newer `formatVersion`** is refused and **left exactly where it is** (SPEC story 114), with a message naming where to get that version. Discarding it would turn "refused" into "silently damaged". The version lives in the value rather than in the key precisely so this build can see such an entry at all.
- An entry naming a **Project or Map Image that is no longer in the Workspace** is not written, and is named. Deleting a Project also empties the journal of it at the time, which is the only thing that can tell a re-created directory of the same name from the original.
- A write that **fails** is named and its entry is **kept**, so an unplugged drive costs a delay rather than the edit.

### What it does not change

- **Rule 4 still governs the replay.** A replayed entry goes back through `ProjectStore.write`: atomic, temp file then rename.
- **An Alignment still has one writer.** A replayed Alignment goes through `alignment/alignment-file.ts` with the `update` intent, which is what the interrupted write was. ⚠ **Neither the `WritablePath` brand nor `scripts/check-alignment-writers.mjs` can see this**, because the path is decoded from storage at runtime — the same position ADR-0023's Project-zip importer is in, with the same remedy: routed through the owning module rather than fenced, plus an executable refusal in the replay's plain-write path so that removing the routing fails a test instead of compiling. `update`'s documented gap comes with it unchanged.
- **Single-level undo (ADR-0014) still works across a save, and a replay cannot resurrect an undone edit.** Undo is an ordinary mutation through the same `Autosave`, so its bytes replace the destructive edit's in the journal exactly as they replace them in the store — the journal holds one entry per path, and the last write wins in both places.

## The two backends want different write architectures

OPFS's reliable fast write path, `FileSystemSyncAccessHandle`, exists **only inside a Worker**. File System Access's `createWritable()` is async and page-context. So the two ProjectStore backends from ADR-0001 have genuinely different preferred write architectures, and the abstraction has to absorb that difference rather than pretend it away.

## Consequences

- **Single-level undo (ADR-0014) must work across a save.** If undo is implemented as "revert to the last saved state" it is useless the moment autosave fires — which, with a sub-second debounce, is essentially always. Undo holds the prior value in memory, independent of write state.
- Losing power mid-drag costs at most the current gesture.
- **Leaving the page costs nothing at all, on a browser that gives the application `localStorage`.** On one that does not — a private window with site data blocked — the original behaviour stands, and the application says so on every screen rather than implying a guarantee it does not have.

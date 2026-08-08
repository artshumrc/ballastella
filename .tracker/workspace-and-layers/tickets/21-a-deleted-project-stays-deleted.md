# A deleted Project stays deleted

## What to build

Deleting a Project must be final. Today a Write-Ahead Journal replay can recreate a deleted Project's `project.json` after the deletion, at a **measured ~20% reproduction rate**. This ticket closes that race in the app.

Demonstrable end to end: `e2e/editor-workspace.e2e.ts:1006` — "does not put an edit back into a Project the user deleted" — passes at a retry rate indistinguishable from zero across repeated runs, **because the app no longer loses the race**, not because the test waits longer.

## What is already known — do not re-derive it

This was open lead 1 on the tracker for the whole epic. It is now fully characterised; start from these facts.

**The failure text**, captured 2026-08-08 across three separate runs:

```
Error: expect(received).toEqual(expected)
- Array []
+ Array [ "amsterdam-1625/project.json" ]
  at e2e/editor-workspace.e2e.ts:1020  →  expect(await everyPath(page)).toEqual([])
```

**The sequencing is pinned, and it is the important part.** The two `toHaveCount(0)` assertions on lines 1018–1019 pass *before* the failing one. So at the moment of failure the hub has already reloaded and rendered the Project gone — and the file is then back on disk. The replay writes **after** the deletion and **after** the listing. The page snapshot at failure shows the Project restored to the hub list: `link "Gone before it was saved"` → `/?p=amsterdam-1625`, "Last saved Aug 8, 2026, 6:09 PM".

**The rate.** `--repeat-each=5` gave 1 flaky / 4 passed (~20%). An earlier measurement gave 2 retries in 10 runs in isolation on a quiet machine. This does not need a hunt to reproduce.

**It is not load.** Reproduced on a quiet machine and under contention alike, and the shape is a write that happens rather than work that is slow.

## Where to start

- The Write-Ahead Journal added by **ticket 20** (ADR-0017 rule 3 as amended, ADR-0001's exception). Recording happens **at the edit, not at `pagehide`**, because `localStorage` quota can only be reported while there is still a screen to report it on. That design is correct and is not what is being changed here.
- The **replay path** on startup, and whatever it consults to decide a journalled edit is still wanted.
- Project deletion, and whether it retires the journal entries belonging to the Project it deletes — deletion and replay are the two ends of this race.
- `e2e/editor-workspace.e2e.ts:1006` and `everyPath`.

## The rule that survived ticket 20, which still holds

**"Unreadable is not absent."** Ticket 20's first cut opened two fresh data-loss paths — a refusal that deleted the identical rescue copy, and an empty listing read as proof a file was gone. Whatever you change here must not reintroduce either. In particular: **do not make replay discard entries it merely failed to read**, and do not treat an absent Project directory as proof the user deleted it — a Workspace that has not finished opening looks the same.

The correct discrimination is *"the user deleted this Project"*, which is a fact the app knows, not *"this Project's files are not there right now"*, which is a guess.

## Contract

**Fix the app, not the test.** A change that only makes the assertion wait longer, retry, or observe later is a refusal to do this ticket. If the test needs to change at all, say why in the commit message and keep it asserting the same fact.

**Deleting a Project retires its journal.** After a delete, no replay may recreate any part of that Project, at any later time, including after a reload and including for edits journalled before the deletion.

**An interrupted delete must not resurrect.** A deletion that is cut off partway — tab closed, crash — must leave the Project deleted or leave it whole, never leave a journal able to rebuild a Project whose files are gone.

**Unrelated journalled edits still replay.** This must not be fixed by weakening the Write-Ahead Journal. An edit to a Project that still exists must still survive a real navigation — that is ticket 20's whole subject and it stays true.

## Out of scope

- **Do not redesign the journal.** Ticket 20 chose recording-at-the-edit for a stated reason; keep it.
- **Do not touch open lead 2** (the viewer's `forceRedraw` error). Different defect, different app.
- **Do not raise the retry budget.** The budget is how this was found.

## Acceptance criteria

- [ ] `e2e/editor-workspace.e2e.ts:1006` passes across **at least 20 consecutive runs** with no retry — `--repeat-each=20` on that spec, and the number recorded in the commit message. The pre-fix rate was ~20%, so 20 clean runs is a real signal rather than luck.
- [ ] The fix is in the app. The assertion still asserts that nothing belonging to the deleted Project is on disk.
- [ ] Deleting a Project retires its journal entries, asserted directly at the unit seam rather than only through the browser.
- [ ] An edit journalled to a Project that still exists is still replayed after a real navigation — ticket 20's behaviour, re-asserted so this fix cannot have silently disabled replay.
- [ ] A journal entry that cannot be *read* is not treated as absent (ticket 20's surviving rule), asserted.
- [ ] The mutation check is recorded per criterion: break the behaviour, watch the test go red, restore, and say what you broke.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm exec playwright test e2e/editor-workspace.e2e.ts --repeat-each=20
pnpm test:e2e
```

Never pass `--reporter=` on the command line: it replaces Playwright's reporter list and silently disables the retry budget, which is the instrument this ticket is judged by. Do not pipe gate output through `grep`; read exit codes.

## Blocked by

Nothing. This is independent of ticket 07 — it lives in autosave and Project deletion, not the align route.

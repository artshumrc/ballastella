# Nothing fails silently

## Problem Statement

A scholar's confidence in Ballastella rests on one thing: that work they can see on the screen is work that is on disk. Three findings from the `workspace-and-layers` epic say that is not always true, and that when it is not true, nothing says so.

**An edit can be reported as saved and never written.** A `commit` can resolve successfully while its bytes stay in memory and reach the store never. The save indicator does read "Unsaved" — so the scholar is not actively lied to — but it reads Unsaved *forever, for no reason*, with no error, no retry, and no explanation. The next edit to the same file destroys the stranded bytes. If it was the last edit of a burst, it is gone permanently. There is nothing the scholar can do, because there is nothing they can see to act on.

**A Map Image's tiles can stop being fetchable mid-session, and the app answers with an uncaught error.** A Reader whose connection goes while a map is drawn, or an author whose Library stops answering, gets an exception thrown into the void from inside the render layer. The screen does not change. Nothing is said. Whether the map they are looking at is complete, stale, or half-drawn is not knowable from the interface.

**And one failure of exactly this shape is unexplained.** A test observed three Control Points on screen and two on disk, once, and it has never reproduced. The screen was ahead of the disk. That is the same symptom as the first problem, and the first problem is *not* the cause — it was ruled out by timeline. So there is a second route to "the screen and the disk disagree" that nobody has found.

The common thread is not that these are rare. It is that **each one is invisible by construction**: a resolved promise, an uncaught rejection, an indicator stuck on a state with no accompanying sentence. A scholar cannot report a bug they cannot perceive, and a test suite that only asserts what the interface shows cannot see them either.

## Change of direction, 2026-08-09

**The durability half of this spec is being rebuilt around a cheaper guarantee.** Tickets 01 and 04 are delivered and merged. Ticket 02 is superseded by this change; ticket 03 shrinks to almost nothing.

The original design answered "a write failed" with *retry it, then hold it in a named stranded state, then say a sentence about it*. Building that produced a bounded retry, a `strandedWrites` accessor, a `quiescing` flag, a `resume(prefix)` call that callers must pair in a `finally`, and a widened `#publish` — and every review round found a new defect in the machinery rather than in the thing it protects. Two of those defects were introduced *by* fixes for earlier ones.

The cheaper guarantee is already most of the way built:

1. every edit is written to the Write-Ahead Journal as it is made — **this already happens**;
2. closing the tab with anything unwritten raises the browser's own warning — **new, small**;
3. anything unwritten comes back on restart — **exists, and is wrong in a way we have measured**.

Under that promise a stranded write costs nothing, because the bytes are in the journal and replay returns them. Retrying becomes a convenience rather than the thing that makes "Saved" true, and the apparatus built to name and narrate the stranded state can be deleted.

**The prerequisite is real and is not optional.** `replayJournal` writes unconditionally and checks only that the owner still exists, so a stale entry can revert newer bytes — measured during ticket 01, currently latent because `Autosave` re-records on every edit. Under the new design it stops being latent. **Fixing replay is the load-bearing work; deleting the retry machinery is the payoff.**

What does not change: the fetch half (ticket 04, delivered), and the rule that no state other than `saved`/`saving` may be shown without an accompanying sentence.

## Solution

Every failure to write, and every failure to fetch, either succeeds, is recoverable without the scholar knowing to act, or is **said** — in words, on the screen, to the person who can act on it.

Concretely, from the scholar's and the Reader's side:

- An edit that cannot be written is held in the journal and comes back on restart, so no failure to write costs the scholar work. If they try to leave with something unwritten, the browser's own warning stops them. "Unsaved" stops being a state the app can sit in silently — but the answer is *durability*, not narration.
- A save indicator that reads anything other than "Saved" is always accompanied by a reason. There is no state in which the app knows something is wrong and shows only a word.
- A Map Image whose tiles stop arriving is reported to the person looking at it — in both the editor and the published viewer, in the same words — rather than being left to the console. A Reader is told it is not their work that failed and that their Annotations are unaffected.
- The one unexplained disagreement between screen and disk is either explained with evidence or recorded as still open with the search narrowed. It is not closed by attaching it to the nearest plausible cause.

## User Stories

1. As a scholar, I want an edit that failed to write to be retried automatically, so that a transient storage hiccup does not cost me work I have already done.
2. As a scholar, I want to be told when an edit could not be saved after retrying, so that I can decide whether to keep working or to stop and rescue what I have.
3. As a scholar, I want the sentence that tells me a save failed to name what is affected, so that I know whether it is my Annotations, an Alignment, or the Project itself.
4. As a scholar, I want to be told what is still safe when a save fails, so that I do not assume the whole Workspace is lost.
5. As a scholar, I never want the save indicator to sit on "Unsaved" with nothing else on the screen, so that I am never left inferring a problem from a single word.
6. As a scholar, I want a stranded edit to survive until it is either written or explained, so that my next keystroke does not silently destroy it.
7. As a scholar, I want the last edit of a burst to be written like every other edit, so that the end of a drag is not the one change that disappears.
8. As a scholar, I want a save that reports success to mean the bytes reached storage, so that "Saved" is a fact rather than a hope.
9. As a scholar, I want the app to recover on its own when a write becomes possible again, so that I do not have to know to make another edit to un-stick it.
10. As a scholar working offline, I want a failed write to be distinguished from a refused one, so that I am not told my connection is at fault when it is my storage, or the reverse.
11. As a scholar, I want a Map Image whose tiles stop arriving to say so on the screen, so that I do not mistake a half-drawn map for the real alignment.
12. As a scholar aligning a referenced map, I want to be told when the Library stops answering, so that I do not place Control Points against a stale or partial image.
13. As a scholar, I want the tiles that already arrived to keep being drawn when later ones fail, so that I lose the newest detail rather than the whole map.
14. As a Reader, I want a published site to tell me when a Map Image's tiles cannot be fetched, so that I know the gap is the site's and not my understanding.
15. As a Reader, I want that message to say my Annotations and the author's work are unaffected, so that I do not think the whole page is broken.
16. As a Reader, I want that message to say whether it is my connection or the site's server, so that I know whether reconnecting will help.
17. As a Reader, I want the message to go away by itself when the tiles start arriving again, so that I am not left with a warning over a working map.
18. As a Reader on a published site with no console, I want every failure that matters to reach the page, so that "nothing visible happened" is never the app's whole answer.
19. As a scholar and as a Reader, I want the editor and the published viewer to say the same thing about the same failure, so that the two halves of the product do not contradict each other.
20. As a scholar, I want an error that escapes the render layer to be caught and turned into a sentence, so that it is not merely logged where nobody is watching.
21. As a scholar, I want the app to keep working after a tile fetch fails, so that one unreachable image does not take down the Project screen.
22. As a scholar, I want a failure while a Layer is hidden to be reported when I show it, so that a message I could not have seen is not the only warning I get.
23. As a maintainer, I want a write that reports success and did not happen to be impossible rather than rare, so that the guarantee does not depend on timing.
24. As a maintainer, I want the write path to have a test that fails when a write is stranded, so that this class cannot return unnoticed.
25. As a maintainer, I want the unexplained screen-ahead-of-disk failure investigated with instrumentation rather than argument, so that we do not close it with a story that fits.
26. As a maintainer, I want that investigation to end in either a named cause or an honestly-narrowed open question, so that the next person does not start from a confident guess.
27. As a maintainer, I want every failure sentence to live in one place, so that the editor and the viewer cannot drift into saying different things.
28. As a maintainer, I want each new sentence to be exercised in every state it can appear in, so that one is not true in the common case and false in a rarer one.
29. As a maintainer, I want the retry policy to be bounded and stated, so that "it retries" does not become "it hangs".
30. As a maintainer, I want a stranded write to be visible in the save state, so that the indicator and the truth cannot disagree.
31. As a scholar using a screen reader, I want a save failure announced, so that I learn about it without watching an indicator.
32. As a scholar using a screen reader, I want a tile failure announced when it appears, so that a visual-only warning is not the only signal.
33. As a scholar, I want failure messages as visible text rather than tooltips, so that they are readable however I use the interface.
34. As a scholar, I want a failure message not to steal focus from what I am doing, so that a warning does not interrupt a Control Point I am placing.
35. As a scholar, I want to be able to dismiss a failure message once I have read it, so that a resolved problem does not follow me for the rest of the session.
36. As a scholar, I want a dismissed message to come back if the failure happens again, so that dismissing does not silence a recurring problem.
37. As a scholar with several Projects, I want a save failure to name the Project it belongs to, so that I do not go looking in the wrong one.
38. As a scholar, I want a Workspace-wide storage failure told apart from one file failing, so that I understand the scale of what has gone wrong.
39. As a maintainer, I want the uncaught-error assertions in the end-to-end suites kept and extended, so that the mechanism that found these keeps finding them.
40. As a maintainer, I want any deliberate exception to those assertions to be narrow, measured, and stated, so that an exception never becomes a blanket silence.

## Implementation Decisions

### The write path

**The one-writer-per-path invariant is kept; the gap in it is closed.** The current design serialises writes per path by memoising the in-flight drain promise. The defect is a window between the drain loop finishing its work and the memo being cleared: a write arriving there is handed the settling promise, its bytes are recorded as pending, and no loop restarts. The fix belongs at that seam — either the memo is cleared before the loop can observe itself finished, or the loop re-checks for work after clearing. **A write must never be able to leave bytes pending with nothing scheduled to drain them.**

That invariant is the thing to state and test, not the mechanism: *if `pending` is set, a drain is scheduled or running.*

**A stranded write is held, and the journal is what makes that safe.** ~~Add a bounded retry~~ — *superseded 2026-08-09.* Failed bytes stay pending and the journal holds a copy; recovery is by replay at startup, not by the scholar making another edit. A bounded retry may still be wanted as a convenience, but it is no longer what makes the guarantee true, and it must not be the thing the guarantee rests on.

**The save state gains a reason, not just a value.** `SaveState` today is `'saved' | 'saving' | 'unsaved'`. `'unsaved'` currently covers both "a debounce is pending, all is well" and "a write failed and nothing is coming" — two states a scholar must be able to tell apart. The interface contract stands: **no state other than `saved`/`saving` may be shown without an accompanying sentence.** What shrinks is how much machinery stands behind it — with durability handled by the journal, the sentence has one job (tell the scholar their work is safe but not yet on disk) rather than narrating a retry policy.

The existing `lastError` and `onJournalRefused` surfaces are the precedent for how a failure reaches the app; extend rather than duplicate them.

**The Write-Ahead Journal is now load-bearing, and replay is where the work is.** Recording happens at the edit rather than at `pagehide`, for reasons already settled; that stays. Two things measured during ticket 01 become critical rather than latent under this design:

1. **`replayJournal` can revert newer bytes.** It writes unconditionally and `missingOwner` checks only that the owner still exists — it never compares what the store holds to what the entry carries. Measured: store `v1` → something outside `Autosave` writes `v2` → replay puts `v1` back, and reports it as `restored`, which reads as good news. `Autosave` re-records on every edit so it cannot cause this itself, but `transfer/open-project-bundle.ts`, `transfer/restore-workspace-tar.ts`, `tiler/ingest.ts`, `base-map/offline-cache.ts` and `replay.ts` all write the store directly.
2. **A stranded write keeps both a live journal entry and stale pending bytes**, because the entry is forgotten only when the store took the bytes. Under the old design that was a curiosity; under this one it is the normal case and must be correct.

**The journal is on a different backend from the store**, which is why this works at all: an OPFS failure with a healthy journal is exactly the case being covered. Where both fail, the unload warning is the last line, and that is the honest limit of the guarantee.

### The render seam

**The failure sentence lives in the domain layer, not in either app's markup.** This mirrors the resolution already reached for the Base Map's unreachable-archive notice: one function, taking the facts that decide the wording, unit-tested across every row it can be in, rendered by both the editor and the published viewer. The two deployments must be incapable of drifting into different words for the same failure.

The sentence carries the same three things in the same order that the existing Base Map notice does, and for the same reason — they are the order the questions arrive in:

1. it is not you;
2. your work is safe;
3. here is what would fix it.

**The error is caught at the injection boundary, not left to escape.** The render layer is handed a fetch function by the app; when the store refuses, that rejection currently escapes into a third-party loader that does not catch it, and arrives as an uncaught page error. The boundary that owns the fetch function is the boundary that owns the failure: it turns a refusal into something the app can render, and the app decides what to say.

**Distinguish what the Reader can act on.** A refusal because the connection is gone, a refusal because the site is missing a file, and a refusal because a Library's server is failing are three different remedies. The existing store error already carries the host and the status; the sentence branches on those rather than on which app is asking.

**Partial success keeps what arrived.** A tile that fails does not discard tiles already drawn. The failure is additive information, not a reset.

### The unexplained disagreement

**This is an investigation with no promised outcome, and the spec says so.** One observation, never reproduced: the screen showed three Control Points and the store held two. The already-confirmed write gap is ruled out by timeline — the observation postdates the change that closes that gap on the affected path.

The work is to instrument rather than to argue. Two candidate mechanisms are already named and should be checked first: the journal-entry-plus-stale-pending interaction described above, and any path where a write's success is reported from a different place than the store's acknowledgement. **An outcome of "still open, and here is what it is not" is acceptable and is to be recorded as such.** Attaching it to a plausible cause without evidence is the failure this epic exists to prevent — a lead in this repository was mis-diagnosed for months in exactly that way, with captured evidence that fit two very different stories.

## Testing Decisions

**A good test here asserts what a scholar or a Reader could observe** — bytes in the store, a sentence on the screen, an announcement to a screen reader — and never an internal call sequence or a private field. A test that asserts "the retry method was called" is not evidence that anything was retried.

**Every assertion must have a named deletion that turns it red.** This epic's own history is the argument: a test seam that compiled for the wrong runtime so every assertion passed regardless, a bundle assertion that could not fail on two of three routes, an assertion whose subject was already true before the gesture under test. The mutation check is how each of those was found, and reading the code found none of them.

Three existing seams, no new ones.

**The domain package's node project** carries the write-path work and the failure sentences. This is the highest seam for both: the write gap was originally reproduced there deterministically, using an in-memory store whose writes resolve on command, and the sentence functions are pure. Prior art: the existing autosave tests, and the Base Map notice tests, which drive every row of a message and additionally assert that *no* row makes a claim the code cannot support.

**The Playwright viewer project** carries the Reader-facing half. It already asserts that no uncaught page error occurs on any navigation — that assertion is what surfaced both render-seam findings, and it stays. Prior art: the published-site tests that route an archive to a committed fixture and then refuse it, including the fixture that answers a header and then stops, which is how a mid-session failure is driven without a network.

**The Playwright editor project** carries the author-facing half — the save-failure sentence, its announcement, its dismissal, and the tile-failure message on the alignment screen. Prior art: the existing tests that assert a save failure is announced in a region a screen reader is given, and the ones that walk every file in the Workspace to prove an exact file list rather than a count.

**No test may reach the network.** This is enforced rather than followed, by a composed root fixture and a check that fails any spec importing the raw test function, plus setup fences on the unit projects. Failures are produced by routing to committed fixtures, never by relying on something being down.

**Never pass a reporter override on the command line.** It silently replaces the reporter list and disables the retry budget, which is the instrument that surfaced two of the three problems in this spec. Read exit codes; do not filter gate output through a pattern.

**A retry is a finding, not noise.** The budget is deliberately near zero. Before attributing any failure to machine load, produce the number that rules it out — this repository has been wrong about that repeatedly, and each time the real cause was a defect.

## Out of Scope

- **The `forceRedraw` teardown defect in the viewer's IIIF component.** Root-caused, and recorded as a note in that package's own repository. It is a first-party upstream fix plus a version bump here, not work for this epic.
- **Changing what the Base Map catalog points at.** Settled: the demo tiles stay, and this is not to be re-raised.
- **The Base Map's own unreachable-archive notice.** Already delivered, in both deployments. This epic covers Map Image tiles, which is a different failure with a different remedy.
- **Redesigning the Write-Ahead Journal**, the debounce policy, or the one-writer-per-path rule. The gap inside that rule is in scope; the rule is not.
- **Assertions that cannot fail, elsewhere in the suite.** Two are recorded — a deep-zoom check whose subject is already true before the gesture, and a decision left unguarded by a removal. Both are real and neither is a silent failure; they belong to a test-integrity effort, not this one.
- **Offline-first behaviour for Map Image tiles.** Telling a Reader that tiles stopped arriving is in scope; making them available offline is a separate, larger question.
- **Reporting on failures across tabs.** A second tab's stranded write is not this epic's problem.

## Further Notes

**On the shape of the work.** Two of the three problems here were found by a test asserting the *absence* of something — no uncaught page error, no retry — rather than the presence of a feature. That is worth preserving as a habit: the failures that hurt most in this codebase have consistently been the ones with no positive symptom to assert on.

**On the third problem.** It may not be solvable in this epic, and the spec is deliberately written so that "still open, and here is what it is not" counts as delivery. The alternative — closing it against the nearest plausible cause — is precisely how a data-loss defect in this repository stayed mis-diagnosed for months while its evidence sat captured and unread.

**On sentences.** The recurring failure mode across the previous epic was not bad code; it was a comment or a message claiming more than the code delivered, with a suite that passed either way. Every claim this epic adds — that a write is retried, that a window is closed, that a message is true in every state — should be checked by breaking it and watching something go red, and any residual should be written down as a residual rather than described as closed.

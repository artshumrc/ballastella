# An Edit History per screen holds file images, not commands

Undo covers about a dozen editing actions rather than four, five deep and reversible in both
directions, and it is split into one **Edit History** per screen: the Project's, keyed by its
directory, and the Alignment's, keyed by its Map Image id. Each is linear, holds at most five
**Steps**, lives in memory for the session, and is shown only on the screen it belongs to.

## The screen is the unit, because a shared one lies about where you are

There was one slot on the session and one affordance on the navigation bar, and the bar is on every
route. An edit made while aligning a Map Image was therefore still offered for undoing on the Project
screen, which describes an edit that is not on screen and cannot be watched happen.

The two histories are **file-disjoint by construction**, and that is what makes them independent
rather than merely separate. A Project Step never holds an Alignment's bytes and an Alignment Step
never holds `project.json`'s — including the one gesture that writes both, adding a Map Image to a
Project, whose Step holds `project.json` alone and leaves the starter Alignment where it is. That
mirrors deletion, which leaves a Map Image and its Alignment untouched (ADR-0023).

Workspace Home has no Edit History. Its only reversible action is the Front Page toggle, which is
undone by pressing it again; the rest are physical erasures that no in-memory record can put back.

## A Step is the bytes of the files it wrote

Every covered action ends in a write, so a Step holds the affected files as they were and as they
became. Undo writes the former, redo the latter, and the cursor moves only when the write succeeds.

The alternative was a command object with a hand-written inverse per action. That is the shape
ADR-0014 declined to adopt for four actions, and at a dozen it is worse: an inverse is a second
description of an edit, and it can disagree with the first. This project has already paid for that
class of defect — a restore closure that captured the Control Point pairing it was recorded on wrote
into a pairing that was no longer on screen, and `restoreControlPoint` had to match by an id minted
per session and absent from the file. Bytes cannot drift from what was written, because they are what
was written.

Two costs are accepted for it. Control Point ids are re-minted when an Alignment is read back, so
undoing an Alignment Step rebuilds the pairing on screen and drops any selection. And a Step must be
opened explicitly around a user's gesture, because the store also carries writes that are nobody's
edit: generated site output, an inbound Sync, and journal replay.

## Typed text is invisible to a Step in both directions

Typing is the browser's to undo, so no typed edit is a Step: not a Layer's name, a Project's name, an
Annotation's title, or its description.

Not recording them would not make them safe, because they share files with edits that are recorded.
Delete a Layer, rename another, undo: a whole-file image of `project.json` from before the deletion
would put the Layer back and take the name away with it. So undo writes the image with the **current**
typed values carried across into it — the Project name and Layer names in `project.json`, Annotation
titles and descriptions in a `.geojson`. Typed text neither creates a Step nor is reverted by one.

The **chosen Base Map** is carried by the same rule although nobody types it, and it is the only such
value: no Step records it either — that choice is out of the history now and later — so an image
written verbatim would swap the backdrop back along with the edit, and no redo would return it
because the `after` image predates the choice too.

Where a Step legitimately removes the thing carrying the text — undoing the creation of an Annotation
— there is nothing to carry it across to, and it goes with the Annotation.

## A disturbed history is discarded whole

Anything that writes a history's files other than its own Steps invalidates it: an inbound Sync,
putting back an Alignment a colleague changed, a concurrent write from another tab, or the deletion of
the subject. The history is dropped entirely and the affordance goes absent.

Trimming to the Steps that still apply means deciding which those are, and being wrong means writing
stale bytes over somebody else's work — the harm `alignmentChangedElsewhere` exists to make visible.
An absent undo costs a scholar one convenience. A wrong one costs a colleague an afternoon.

## Nothing survives a reload

An Edit History is memory only. Putting a change back at startup is the Write-Ahead Journal's job
(ADR-0017), and the on-disk before-images an inbound Sync writes are a crash-recovery protocol for
that transaction, not a history — the words are close and the lifetimes are opposite.

# 11 — Single-level undo

## What to build

A user who mis-aims a drag or deletes the wrong thing can get it back. One step, covering the four destructive actions: a Control Point moved, a Control Point deleted, an Annotation deleted, a Layer deleted.

**Fulfills** — [SPEC.md](../SPEC.md) user story 38, and only that one. The four covered actions are exactly its scope; the not-covered list in the Contract is what keeps this from growing into the history stack ADR-0014 fences out.

## Where to start

[ADR-0014](../../../docs/adr/0014-v1-scope-fences.md) (the scope of undo and why it is deliberately not a history stack) and [ADR-0017](../../../docs/adr/0017-autosave-semantics.md) (the interaction with autosave, which is the crux).

Control Points from ticket 07, Annotations from ticket 10, Layers from ticket 09.

## Contract

**Single-level undo of the last destructive action.** Not a history stack.

`terra-draw` provides no undo, so this is ours. A scoped undo is not optional: dragging a Control Point is a destructive, easy-to-mis-aim gesture, and a scholar who nudges the wrong point and cannot get back will not trust the tool. But full multi-step session history is a different order of work — every mutation becomes a command object, which shapes the entire state layer — and ADR-0014 fences it out of v1.

**The crux, and the thing that will otherwise be got wrong: undo must work across a save.**

If undo is implemented as "revert to the last saved state," it is useless the moment autosave fires — which, with a sub-second per-file debounce, is essentially always. **Undo holds the prior value in memory, independent of write state.** Reverting is itself a mutation that goes through the normal autosave path.

Covered actions, exactly four:

| Action | Restores |
|---|---|
| Control Point moved | its previous `resource` and `geo` |
| Control Point deleted | the pair, with its `ordinal` |
| Annotation deleted | the feature with all its `properties` |
| Layer deleted | the Layer entry **and** its referenced file |

Deleting a Layer deletes a file (`alignments/*.json` or `annotations/*.geojson`), so undoing it must restore that file's contents — meaning the undo record holds the bytes, not just the `project.json` entry. This is the case most likely to be missed, and it is the one where the loss is largest.

Undo is **not** available for: creating things, editing a title or description, style changes, visibility toggles, reordering, renaming, or transformation-type changes. Those are either non-destructive or trivially reversible by repeating the action. Restraint here is the point — a broader net turns this into the history stack ADR-0014 excludes.

Standard keyboard shortcut, and a visible affordance naming what will be undone ("Undo delete of point 7"), because a bare Undo button after an accidental delete is not reassuring.

The undo record is cleared when the Project is closed. It does not persist.

## Out of scope

- **Redo.** Not in v1.
- **Multi-step history.** One level. Do not build a command-object architecture "so history is easy later" — that is precisely the work ADR-0014 defers.
- **Undo for non-destructive actions.** See the list above.
- **Persisting undo across reload.**
- **Undo across Projects.**

## Acceptance criteria

- [x] Moving a Control Point, then undoing, restores its previous position exactly
- [x] Deleting a Control Point, then undoing, restores the pair with its original ordinal
- [x] Deleting an Annotation, then undoing, restores the feature with all `properties` intact, including `stroke-dasharray`
- [x] Deleting a Layer, then undoing, restores both the `project.json` entry **and** the referenced file's contents byte-for-byte
- [x] Undo works **after autosave has already written the destructive change to disk** — asserted by waiting for the saved indicator before undoing
- [x] A second undo does nothing and is not offered
- [x] The undo affordance names the action it will reverse
- [x] Undo is reachable by keyboard shortcut and by a visible control
- [x] Non-destructive actions do not consume the undo slot: toggling visibility after a delete leaves the delete still undoable
- [x] The undo record is cleared on closing the Project

```bash
pnpm --filter @ballastella/core test    # undo records hold prior values incl. file bytes; slot semantics
pnpm test:e2e                    # each of the four actions, undone AFTER the saved indicator settles
pnpm -r build && pnpm lint && pnpm check
```

Success: all exit 0. The e2e tests must **wait for the save indicator to read "saved" before invoking undo** — an implementation that reverts to last-saved-state passes a naive test and fails this one, which is the whole point of the ticket.

## A trap waiting for you: deleting a map Layer resurrects it

Recorded here by ticket 09's code review rather than left to be discovered, because it only bites once
you add the delete affordance — which is this ticket.

Ticket 09 deliberately shipped `removeLayer` **tested but with no button**, on the reasoning that
"layer deleted" is one of the four actions ADR-0014 requires undo to cover, so the affordance belongs
with the undo that makes it safe. That was right. But `EditorSession.#ensureMapLayer`
(`apps/editor/src/lib/editor-session.svelte.ts`) recreates a map Layer on **every** Alignment write.

So the moment a delete button exists: delete a map Layer, then touch a single Control Point in the
alignment workspace, and the Layer comes back — with a **fresh `id`**, a fresh name read from the
image's `manifest.json`, and at the **top of the stack**, discarding the user's ordering. Undo will not
help, because from the app's point of view nothing was undone: a new Layer was legitimately created.

You need a tombstone, or an idempotence key that is not "does a Layer for this image exist" — and it
must survive a reload, since the Alignment write that resurrects the Layer can happen in a later
session. Decide which before writing the button, and record the choice.

Two smaller things from the same review, for the same reason:

- **`#ensureMapLayer` is a check-then-act across two awaits** (a `layers.some(...)` test, then an
  `await this.#imageLabel(...)` store read, then the assignment), so two Alignment writes in flight can
  each see no Layer and each add one — two rows, two `WarpedMapLayer`s fetching the same pyramid, and
  as of ticket 09 no affordance to remove either. Worth fixing as part of the same work.
- **`parseLayers` does not deduplicate ids.** Two Layers sharing an id reach a keyed `{#each}`, which is
  a hard error in dev and list corruption in a production build. Relevant here because an undo that
  restores a Layer is a second writer of an id that may already be back.

## Blocked by

- Ticket 08
- Ticket 10

---

## Decisions taken while building this

### The resurrection trap: a tombstone in `project.json`, not an implicit key

`ProjectFile.removedMapLayers` — a list of the `alignmentRef`s whose map Layer the user deleted.
`EditorSession.#ensureMapLayer` now returns early when a Layer draws the Alignment **or** the
Alignment is tombstoned, so an Alignment write can no longer recreate a deleted Layer.

Why in `project.json` rather than anywhere else: `EditorSession` is the app's only writer of that
document, it is written atomically (ADR-0017 rule 4), and the record has to survive a reload because
the resurrecting write happens in a later session. A file of its own would be a second writer of one
fact. It is **omitted from the serialised document when empty**, so an untouched Project's
`project.json` is byte-for-byte what it was before this field existed (ADR-0010).

Deliberately **not** chosen, and why:

- *"The Alignment file did not exist before this write."* Deleting the Layer deletes the Alignment, so
  every later write of that image looks like a new Alignment and the guard never holds.
- *"This write carries exactly one Control Point, so it is a fresh Alignment."* Same defect, plus it
  makes the guard conditional on the deletion having removed the file — a coupling a later change
  could break silently, and a trap test written with three pairs would not notice.
- *A deterministic Layer id derived from the image id.* Stops the id churning but not the
  resurrection: the Layer still returns, renamed, at the top of the stack.

Undo lifts the tombstone along with restoring the Layer, and `addReferencedMap` lifts it too — adding
the same remote map again is the user asking for the Layer, not an Alignment write recreating one.

**The consequence, which is real and is recorded as a finding below**: for a *locally ingested*
Historical Map there is no affordance in v1 that lifts a tombstone except undo. A user who deletes a
map Layer, does not undo, and reloads has no way back into the stack for that image.

### The undo record holds bytes, and the slot lives in core

`packages/core/src/undo/undo.ts` holds the four record shapes, `describeUndo` (the affordance's
wording, so it is one fact with unit tests), the three restore functions, and `UndoSlot` — a plain
class with a listener, exactly as `Autosave` is, which `EditorSession` projects into `$state`.
`LayerDeletedUndo.bytes` is the referenced file's contents, read before the deletion, which is what
makes byte-for-byte restoration possible at all; a parsed model would re-serialise to something merely
equivalent, and a foreign Alignment field would be lost.

`deleteLayer` flushes first (so the recorded bytes are the ones the user can see), then writes
`project.json`, then deletes the file — the creation order in reverse, so the worst intermediate state
is a file nothing references rather than a Layer referencing nothing. `#restoreLayer` reverses that.

### The two smaller items from ticket 09's review

- `#ensureMapLayer` now claims the Alignment in a `Set` **synchronously** before its `manifest.json`
  read and releases it in a `finally`, so two Alignment writes in flight produce one Layer. Covered by
  `two Alignment writes in flight produce one Layer, not two`, driven with a delayed `manifest.json`
  read rather than by luck.
- `parseLayers` already deduplicates ids (ticket 09's remediation). The interaction with undo is
  handled in `insertLayerAt`, which **refuses** an id already in the stack and returns the array it was
  given, so `#restoreLayer` writes nothing rather than a document whose next read loses a Layer.

## Findings

1. **A deleted map Layer cannot be put back except by undo, and that is a dead end after a reload.**
   The tombstone is total, as the trap requires. For a referenced image, adding it again lifts it; for
   a locally ingested one, nothing does — re-aligning the image produces Control Points and no Layer,
   silently. Needs human judgement: either an affordance ("this Historical Map is not in the stack —
   put it back", which would lift the tombstone) or an accepted limitation stated in the docs.
2. **Leaving the Layers pane while a map Layer is drawn throws out of the stack's teardown.**
   `Cannot read properties of undefined (reading 'getLayer')`, which kills the *next* page's effects —
   the alignment workspace then sits at "Opening the Historical Map…" for ever. Reproduces with no undo
   involved: open `/layers` on an aligned Project, uncheck the Layer's visibility, check it again, then
   follow "Back to this Project". Not this ticket's code; it is in the Layers-pane drawing/lifecycle
   path another agent is working in. `editor-undo.e2e.ts` navigates by URL to stay clear of it, with a
   comment saying so.
3. **`stack-status`'s `data-drawn` counts Layers that have left the stack.** `outcomes` merges
   `rendered`, which is never pruned of ids the map no longer has, so after deleting a drawn Layer the
   region still reported it as drawn. Same pane, same owner as finding 2. This ticket's tests read
   MapLibre's own `getLayersOrder()` instead, which is the mechanism rather than the app's account of it.
4. **Two test reads raced an atomic replace, one of them in a way that could hide a defect.**
   `storedAlignment` and `storedProjectFile` (support/alignment-workspace.ts) swallowed the transient
   failure as `null`, and `readProjectFile` (support/annotations.ts) let it propagate out of
   `expect.poll`. The first shape failed `expect(written).not.toContain(…)` with a matcher error in a
   full run — and would have made `expect.poll(read).not.toBe(before)` **pass** on a file that could not
   be read, which is a byte-identity assertion satisfied by nothing. All three reads are now retried for
   500 ms; no assertion changed. Same defect ticket 15 fixed once in `editor-workspace.ts`.
5. **The `Ctrl+Z` shortcut deliberately yields to text fields.** Editing a title, a Layer name, or a
   Project name is not one of the four covered actions, so the field's own undo has to keep working;
   asserted directly.
6. **Undo is not offered across a change of Historical Map.** A Control Point record names its image,
   and `AlignmentWorkspace` clears one belonging to another image when the selected map changes — an
   affordance offering to move a point that is not on screen describes an edit the user cannot watch
   happen. Records about the Project (a Layer, an Annotation) survive that.

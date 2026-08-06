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

- [ ] Moving a Control Point, then undoing, restores its previous position exactly
- [ ] Deleting a Control Point, then undoing, restores the pair with its original ordinal
- [ ] Deleting an Annotation, then undoing, restores the feature with all `properties` intact, including `stroke-dasharray`
- [ ] Deleting a Layer, then undoing, restores both the `project.json` entry **and** the referenced file's contents byte-for-byte
- [ ] Undo works **after autosave has already written the destructive change to disk** — asserted by waiting for the saved indicator before undoing
- [ ] A second undo does nothing and is not offered
- [ ] The undo affordance names the action it will reverse
- [ ] Undo is reachable by keyboard shortcut and by a visible control
- [ ] Non-destructive actions do not consume the undo slot: toggling visibility after a delete leaves the delete still undoable
- [ ] The undo record is cleared on closing the Project

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

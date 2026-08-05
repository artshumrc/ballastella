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

## Blocked by

- Ticket 08
- Ticket 10

# A Layer is created when a map is added, not when it is aligned

## What to build

Adding a Historical Map to a Project puts a Layer in the stack immediately, marked as not yet aligned. Today a local map produces no Layer until the first Control Point is placed, while a remote map gets one at add time — two behaviours for one act, and neither is what the interface needs.

Demonstrable end to end: add a Historical Map from a file, and a Layer appears in the stack straight away, saying it has not been aligned yet. Place two Control Points and the warning clears. Remove the Layer, add the same map again, and it comes back — which today it silently does not.

Read [ADR-0023](../../../docs/adr/0023-historical-maps-and-alignments-live-in-the-workspace.md)'s consequences on Layer creation and the starter Alignment before starting.

## Where to start

- `apps/editor/src/lib/editor-session.svelte.ts` — `#ensureMapLayer`, `#placingMapLayers`, `writeAlignment`, `ingestImage`, `addReferencedMap`. `#ensureMapLayer`'s doc comment explains at length why the tombstone exists; read it, because you are deleting the reason.
- `packages/core/src/project/project-file.ts` — `ProjectFile.removedMapLayers`, its parse and serialise.
- `packages/core/src/alignment/alignment.ts` — `newAlignment(imageId, image)`, which already yields zero Control Points and a full-image Resource Mask, and `MINIMUM_CONTROL_POINTS` / `canSolve` in the same area.
- `apps/editor/src/lib/layers/LayerList.svelte` and `apps/editor/src/routes/layers/+page.svelte` — the latter already computes a `'Not aligned yet, so there is nothing to draw.'` outcome for a map Layer with no Alignment; that logic changes shape because an Alignment now always exists.
- `apps/editor/src/lib/undo/UndoControl.svelte` and ticket 11's undo records in v1 — the Layer-deleted undo record still applies and must keep working.

## Contract

**A map Layer is created by exactly one thing: the user adding a Historical Map to a Project.** An Alignment write must never create a Layer. Delete `#ensureMapLayer` and `#placingMapLayers` (its in-flight race guard) entirely.

**Delete `ProjectFile.removedMapLayers`.** It existed only to stop an Alignment write resurrecting a deleted Layer. With Layers created by explicit gesture alone, nothing can resurrect one. The parser must not carry the field forward and must not choke on a `project.json` that happens to contain it.

> **From the review of ticket 01:** this is already broken on the *referenced* path, not only the local one — `addReferencedMap` writes `alignments/<image-id>.json` only when a community Alignment was chosen, while `layerReferences` in `import-project-zip.ts` requires it for every map Layer, so such a Project exports a zip this build then refuses to import. Fixing it here covers both paths; a test that only adds a map from a file will not see it.

**A starter Alignment is written when a Historical Map is added.** `newAlignment(imageId, image)` — zero Control Points, Resource Mask covering the whole sheet. Without it, an unaligned Layer references a file that does not exist and `assertReferencesPresent` makes the Project un-exportable and un-publishable, which is the trap this contract exists to close. This does not offend ADR-0010: that rule forbids writing when *merely opening* a Project, and adding a map is an explicit act.

**"Not aligned" is derived, never stored.** The test is `controlPoints.length < MINIMUM_CONTROL_POINTS`, which `canSolve` already computes. Do not add a boolean field. A partially aligned map — one or two points, below the solvable minimum — must warn, which a boolean set at creation would get wrong.

**The sidebar reads the Alignment of every map Layer, not only the visible ones.** Today `documents` in the layers route holds only the Layers handed to the map, so a hidden Layer's Alignment is never read. The not-aligned state must be correct for hidden Layers too. Keep the existing `documentKey` discipline: a rename or a dragged opacity slider must still not cause a store read.

**Adding a map already in this Project is not an error and does not duplicate.** It is a no-op on the stack; the existing Layer stays where it is in the order, with its name.

## Out of scope

- **Do not build the three-source add flow or the sidebar disclosure.** Tickets 05 and 06. Here, the existing add affordances on `ProjectView` and `AddRemoteMap` simply also create a Layer.
- **Do not move alignment to its own route.** Ticket 03.
- **Do not change the warning's visual design** beyond making the state available and legible. The Layer-card treatment lands with the sidebar in ticket 05.
- **Do not touch annotation Layer creation.** `addAnnotationLayer` is already eager and correct.
- **Do not reintroduce a tombstone under another name** — no `deletedImageIds`, no `hiddenMaps`. If you find yourself wanting one, an Alignment write is creating a Layer somewhere and that is the bug.

## Acceptance criteria

- [ ] Adding a Historical Map from a file produces a map Layer in `project.json` before any Control Point exists.
- [ ] Adding a Historical Map writes `alignments/<image-id>.json` with zero Control Points and a full-sheet Resource Mask.
- [ ] Placing one Control Point does not create, rename, or reorder any Layer.
- [ ] Deleting a map Layer and then placing or moving a Control Point on that map does not recreate the Layer.
- [ ] Deleting a map Layer, reloading, and adding the same Historical Map to the Project again produces a Layer.
- [ ] Adding a Historical Map already in the Project leaves the stack unchanged — same Layer id, same order, same name.
- [ ] A Layer with fewer than `MINIMUM_CONTROL_POINTS` reports itself as not aligned, including when hidden.
- [ ] A Project holding an unaligned map Layer exports to a zip and imports back without a missing-reference refusal.
- [ ] `removedMapLayers`, `#ensureMapLayer`, and `#placingMapLayers` appear nowhere in `packages/` or `apps/`.
- [ ] Renaming a Layer and dragging its opacity slider cause no store reads.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check && pnpm test:e2e
```

All green. Then:

```sh
grep -rn "removedMapLayers\|ensureMapLayer\|placingMapLayers" packages/*/src apps/*/src
```

Expect no matches.

The read-count criterion has prior art: the layers route's `documentKey` derived value exists precisely so a rename does not re-read every Alignment, and its doc comment describes the bug it fixed. Assert with a counting spy on `ProjectStore#read`, the same way the existing suite counts writes.

For each criterion above, break the behaviour and confirm the test goes red before restoring it. The Layer-resurrection criteria in particular passed vacuously in an earlier version of this codebase.

## Blocked by

- Ticket 01

## Implementation notes

Eight things worth knowing. One is a deviation from an acceptance criterion as literally written —
the `removedMapLayers` grep, second from last.

**The list of the Workspace's Historical Maps is now refreshed *after* the Layer is written, not
before.** `ingestImage` used to set `images` the moment the pyramid was complete; the add now has a
second half — the starter Alignment and the Layer — and listing the map before that half finished made
it look added while the file input beside it was still disabled. Picking a second file inside that
window did nothing at all, silently, which is what `editor-stored-image-pane.e2e.ts`'s two-image test
caught.

**`#writeInitialAlignment` is the only thing that writes `alignments/<image-id>.json` on the add
path**, and it never writes over an Alignment somebody has worked on. A remote resource's image id is
`generateId(uri)`, so the same map re-added — or added by a *second Project* — lands on the same id,
and ADR-0023 made that file the Workspace's rather than the Project's; an unconditional write is
therefore not "overwrite the file I just made" but "silently delete a Project I am not looking at".
`#existingAlignment` answers `'worked on'` for any read failure that is not `PathNotFoundError`,
which is the safe direction of that trade.

**The offer wins only when there is nothing to lose.** A community Alignment the user chose is
written when there is no file at all, or when the file is still byte-identical to the starter this
build writes — nothing has happened to it, so replacing it discards nothing. Otherwise the existing
Alignment is kept and `AddRemoteMap` says so, in terms that name the reason: the Layer was added, the
import did not happen, and a Historical Map has one Alignment shared by every Project that draws it.
Byte-identity rather than `controlPoints.length === 0`, because the Resource Mask is editable without
placing a Control Point and a count would read a cropped sheet as untouched.

**Pre-existing broken Projects are repaired by re-adding the map, and deliberately not on open.** A
Project written before the starter Alignment existed can hold a map Layer with no
`alignments/<id>.json`, which `assertReferencesPresent` refuses by name — un-exportable and
un-publishable. Repairing it when the Project is *opened* was considered and rejected: ADR-0010
forbids writing when merely opening a Project, and ADR-0023 says the same thing again about
migrations, so a repair-on-open would be this epic breaking one of its own ADRs to fix a state that
exists only in development checkouts (nothing is deployed and no Workspace exists outside them).
Instead the Alignment is settled **before** `#addMapLayer` returns early on "this Project already
draws that map", so the obvious gesture — add the map again — writes the missing file. Covered by
`re-adding a map repairs a Project whose Alignment went missing`, which goes red on its own when that
early return is moved back above the Alignment write.

**"Not aligned" overrides what the warped renderer reports, rather than being merged with it.** A map
Layer with one Control Point of three now *has* an Alignment, so it is a Layer the renderer could be
handed, and it would refuse it with a count of its own — "2 more Control Points and this Layer will be
drawn". Taking that answer would mean a hidden Layer and a visible one saying different things about
the same unplaced map, so the Layers route computes one sentence from `canSolve` for every map Layer
and does not hand an unaligned one to the map at all. The renderer's shortfall message is still what
the *alignment workspace* shows, where it is about the map in front of you.

**The Layers route reads every map Layer's Alignment, including hidden ones — but still not on a
rename or an opacity drag.** `documentKey` is computed from a new `withDocuments` list (every map Layer,
plus the visible Annotation Layers) instead of from `shown`. A map Layer's visibility is deliberately
*not* in the key: its Alignment is read either way, so ticking one costs no read. A hidden Annotation
Layer is still not read, because nothing asks a question of its file that the stack does not.

**`removedMapLayers` is dropped on parse, not merely absent from the model, and that costs the
acceptance grep its literal reading.** Removing the field from `ProjectFile` leaves the key in
`unknownFields`, which `serialiseProjectFile` spreads — so every existing `project.json` would carry
the dead tombstone for the life of the Workspace and gain a spurious diff, moving it after
`canonicalUrl`, on the first edit. `parseProjectFile` therefore deletes it by name, the way it already
deletes the Base Map key, and the name survives in exactly two places: the
`REMOVED_MAP_LAYERS_KEY` constant that does the deleting, and the tests that prove both halves (a file
containing it opens; a file containing it does not re-serialise it). The criterion's grep over
`packages/*/src` and `apps/*/src` therefore reports those two matches rather than none. Read as
written it is unsatisfiable together with "the parser must not carry the field forward"; read as
intended — no `removedMapLayers` **field**, no `#ensureMapLayer`, no `#placingMapLayers` — it holds,
and `ensureMapLayer` and `placingMapLayers` have no matches at all.

**Ports are no longer a hazard.** `playwright.config.ts` now derives its pair from the checkout path,
so each worktree gets its own and a run cannot drive a sibling branch's build. The full suite below
was run with it unmodified.

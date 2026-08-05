# Control point pairs are made click-then-click

A user clicks a spot on the historical map, a pending marker appears, and they click the corresponding spot on the base map. That completes one pair.

This matches how the act is actually reasoned about: "*this* church tower is *there*" is a single thought with two halves, not two independent acts joined afterwards. Placing points independently and linking them later was rejected because it admits a state with eleven points on the image and eight on the map and no way to see which are orphaned — hard to visualise, harder to explain to a student. Auto-pairing by placement order was rejected as worst: it makes ordering load-bearing and invisible, so one misordered placement silently shifts every later pairing and the only symptom is a warp that is inexplicably wrong.

## A half-pair is not representable

From `@allmaps/transform`, a GCP is `{ resource, geo }` and **both halves are required**. An unpaired point cannot exist in a Georeference Annotation.

## Contracts

1. **The pending half is visible, labelled, and cancellable with Escape.** Without a clear pending state the user does not know the app is waiting, and the second click lands somewhere arbitrary.
2. **A pending half never reaches the alignment file.** It lives in UI state only. This bears directly on ADR-0017: naive autosave serialisation of a half-pair either throws or writes an invalid GCP. Autosave must *skip* incomplete pairs, not error on them.
3. **Both halves are draggable, and dragging either edits the pair** — committing on pointer-up, per ADR-0017.
4. **Selecting either half highlights its partner in the opposite pane.** This is what makes a set of twenty points comprehensible, and it is the piece no library provides: pairing is ours, since neither `terra-draw` nor any drawing library has a concept of linked markers across two maps.
5. **Deletion removes the pair, never a half.** A half cannot exist in the file, so deleting one has no valid meaning.

## Consequence

**Pairs are visibly numbered.** "Look at point 7" is how an instructor talks to a student over their shoulder or in a written comment. It costs nothing and it is the difference between a usable teaching tool and one where problems can only be pointed at with a cursor.

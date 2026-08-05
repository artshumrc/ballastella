# 07 — Alignment: Control Point pairing and persistence

## What to build

The core act of the application. A user sees their Historical Map beside the Base Map, clicks a feature on the map, then clicks the same place on the earth, and a numbered Control Point pair appears. With enough pairs, the Historical Map appears warped onto the Base Map. The Alignment is written to the Project as a IIIF Georeference Annotation.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 30, 32, 33, 34, 35, 36, 37, and 91. With tickets 10 and 13: 94 (standard formats, no proprietary index).

## Where to start

[ADR-0022](../../../docs/adr/0022-control-point-pairing-is-click-then-click.md) (the interaction), [ADR-0013](../../../docs/adr/0013-transformation-types-and-distortion.md) (default type only — refinement is ticket 08), [ADR-0017](../../../docs/adr/0017-autosave-semantics.md) (gesture-end commits and half-pair skipping), [ADR-0010](../../../docs/adr/0010-integer-format-version-with-forward-only-migrations.md) (fixture round-trips).

Image pane from ticket 03, Base Map pane from ticket 04, store-backed tiles from ticket 06.

```
terra-draw + terra-draw-maplibre-gl-adapter   drawing on both panes
@allmaps/annotation                           Alignment ⇄ Georeference Annotation
@allmaps/maplibre                             WarpedMapLayer (fetchFn already wired in 06)
@allmaps/transform                            the solver
```

## Contract

```ts
type ControlPoint = {
  id: string
  ordinal: number                    // 1-based, visible to the user
  resource: { x: number, y: number } // image pixels
  geo: { lng: number, lat: number }
}
```

**A half-pair is not representable.** A GCP is `{ resource, geo }` with both halves required, so an unpaired point cannot exist in a Georeference Annotation (ADR-0022). The pending half lives in UI state only.

This bears directly on autosave: **autosave must *skip* incomplete pairs, not throw on them.** Naive serialisation of a half-pair either crashes or writes an invalid GCP — and because autosave fires constantly, this would fail on the very first click of every pair.

Six behaviours, all required (ADR-0022):

1. Click on the Historical Map, then on the Base Map, creates one pair. **Click-then-click**, not place-then-link, and never auto-pair-by-order.
2. The pending half is **visible, labelled, and cancellable with Escape**.
3. Pairs are **visibly numbered**, so an instructor can say "look at point 7."
4. **Both halves are draggable**, and dragging either edits the pair. Per ADR-0017, a drag commits **once, on pointer-up** — not per pointer-move.
5. **Selecting either half highlights its partner** in the opposite pane. Pairing is ours; no drawing library has linked markers across two maps.
6. **Deletion removes the pair, never a half.**

Persistence: `alignments/<image-id>.json`, a IIIF Georeference Annotation produced by `@allmaps/annotation`. The transformation type is the canonical Allmaps string — `polynomial1` for the default (ADR-0013). Never write `straight`; never write the alias `polynomial`.

**Commit round-trip fixtures.** Saved Alignments must survive serialise → deserialise unchanged. Every `@allmaps/*` package is pre-1.0, so this test is what stands between a beta bump and every Alignment in the field being subtly misplaced (ADR-0010).

Once the minimum point count for `polynomial1` (3) is met, the warped Historical Map renders on the Base Map via `WarpedMapLayer`.

## Out of scope

- **Choosing a transformation type, distortion visualisation, the fold warning, and the Resource Mask** — ticket 08. Here: `polynomial1` always, and the Resource Mask defaults to the full image rectangle without being editable.
- **Undo** — ticket 11.
- **The Layer list** — ticket 09. One Historical Map, one Alignment, no layer UI.
- **Annotations** — ticket 10. `terra-draw` arrives here for Control Points only.
- **Importing an existing Alignment from Allmaps** — ticket 14.
- **A general command/history architecture.** ADR-0014 fences this; do not build one to make future undo easier.

## Acceptance criteria

- [ ] Clicking the Historical Map then the Base Map creates one numbered pair
- [ ] The pending half is visible and labelled, and Escape cancels it leaving no trace in UI state or on disk
- [ ] Dragging either half moves the pair, and produces **exactly one** store write, on pointer-up
- [ ] Selecting either half visibly highlights its partner in the other pane
- [ ] Deleting removes both halves
- [ ] Ordinals are visible and remain stable across reload
- [ ] With a pending half present, autosave writes a valid Georeference Annotation **excluding** the incomplete pair, and does not throw
- [ ] With 3 or more pairs, the Historical Map renders warped on the Base Map
- [ ] `alignments/<image-id>.json` is a valid Georeference Annotation, parseable by `@allmaps/annotation`
- [ ] Committed fixture Alignments round-trip through serialise → deserialise with identical Control Points and Resource Mask
- [ ] The written transformation type is `polynomial1` — never `straight`, never `polynomial`
- [ ] Reloading restores all pairs, their ordinals, and the warped render
- [ ] Every pairing action is achievable by keyboard, and the pending state is announced to assistive technology

```bash
pnpm --filter @ballastella/core test    # serialisation, fixture round-trips, half-pair skipping
pnpm test:e2e                    # pairing, Escape, drag-commit-count, cross-pane highlight, reload
pnpm -r build && pnpm lint && pnpm check
```

Success: all exit 0. The drag test must assert the **number** of store writes, not merely that a write happened — a per-pointer-move implementation passes a "did it save" test and fails this one.

## Blocked by

- Ticket 04
- Ticket 06

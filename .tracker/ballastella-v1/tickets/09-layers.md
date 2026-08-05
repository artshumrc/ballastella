# 09 — Layers: mixed list, visibility, opacity, ordering, keyboard reorder

## What to build

An ordered list of Layers in the editor. A user can show and hide any Layer, set the opacity of an aligned Historical Map, reorder Layers so labels sit above the map they describe, and rename a Layer so the list describes their argument rather than their filenames.

Reordering works by dragging **and** by keyboard.

## Where to start

[ADR-0002](../../../docs/adr/0002-display-state-separate-from-portable-documents.md) (the whole slice), [ADR-0016](../../../docs/adr/0016-daisyui-only-with-mandated-component-methods.md) (the reorderable list is custom and needs a keyboard path), [ADR-0014](../../../docs/adr/0014-v1-scope-fences.md) (why the union must tolerate a third kind).

`project.json` and autosave come from ticket 02; the aligned Historical Map from ticket 07.

## Contract

**A discriminated union narrowed on `kind` — explicitly not one type with a bag of optional fields:**

```ts
type Layer = { id: string, name: string, visible: boolean, order: number } & (
  | { kind: 'map',        opacity: number, alignmentRef: string,
                          imageMode: 'referenced' | 'mirrored' }
  | { kind: 'annotation', geojsonRef: string, defaultStyle: SimpleStyle }
)
```

ADR-0002 names the predictable failure of the alternative: a single fat `Layer` with everything optional, after which someone sets `opacity` on an annotation Layer, observes nothing, and "fixes" it by threading opacity through label rendering that nobody asked for. **The union must make that a type error.**

**The union must tolerate a third `kind` later.** Image-space annotation is the expected next feature (ADR-0014), so nothing may assume every annotation Layer is geographic, and no exhaustive switch may be written in a way that makes adding a kind a wide refactor.

**A Layer references its content; it never contains it.** `alignmentRef` and `geojsonRef` point at files. Display state — `visible`, `order`, `opacity`, `name` — lives **only** here, never in the Georeference Annotation or the GeoJSON, both of which are portability documents (ADR-0002).

Reordering, renaming, and toggling must **not** touch the `.json` files holding Alignments or Annotations. Only `project.json` changes.

Stacking order between kinds must be expressible and honoured: an annotation Layer above a map Layer draws above it. This is needed immediately, since labels must sit over the map they describe.

**Keyboard reorder is required, not a nice-to-have.** No library provides drag-to-reorder, so this list is custom either way — and layer order is load-bearing in this app, so a drag-only implementation makes core functionality keyboard-inaccessible (ADR-0016). Ship move-up/move-down controls.

Creating an Alignment (ticket 07) now produces a `kind: 'map'` Layer. `kind: 'annotation'` Layers are created in ticket 10; the union and the rendering order must already accommodate them.

## Out of scope

- **Drawing annotations** — ticket 10. This slice can create an empty annotation Layer to prove ordering across kinds, but no drawing tools.
- **A third `kind`.** Make it *possible*, do not add it.
- **Layer groups, nesting, or folders.** Flat ordered list.
- **Per-Layer base maps.** One Base Map per Project (ADR-0020).
- **Opacity on annotation Layers.** Explicitly excluded by the union; do not add it "for symmetry."
- **Reader-side layer controls in the Published Site** — ticket 17.

## Acceptance criteria

- [ ] Aligning a Historical Map produces a `kind: 'map'` Layer in `project.json`
- [ ] Show/hide works for both kinds and survives reload
- [ ] Opacity works on a map Layer and is absent from the annotation Layer type — assigning it is a **type error**, verified by a type-level test
- [ ] Reordering by drag changes render order, including across kinds: an annotation Layer above a map Layer draws above it
- [ ] Reordering by keyboard via move-up/move-down achieves the same result with no pointer involved
- [ ] Renaming a Layer changes only `project.json`
- [ ] Reorder, rename, and toggle leave `alignments/*.json` and `annotations/*.geojson` byte-identical
- [ ] Adding a hypothetical third `kind` to the union does not require changes outside the modules that render or edit Layers — demonstrated by a test fixture carrying an unknown kind, which is ignored gracefully rather than throwing
- [ ] Every Layer control is reachable and operable by keyboard, and the list's structure and order are announced to assistive technology

```bash
pnpm --filter @ballastella/core test    # union narrowing, project.json-only mutation, unknown-kind tolerance
pnpm --filter @ballastella/core exec tsc --noEmit    # opacity-on-annotation must fail to typecheck
pnpm test:e2e                    # drag reorder, keyboard reorder, cross-kind stacking, reload
pnpm -r build && pnpm lint && pnpm check

# display-state isolation: hashes must be unchanged after reorder/rename/toggle
sha256sum <project>/alignments/*.json <project>/annotations/*.geojson
```

Success: all exit 0; the type-level test confirms `opacity` is rejected on an annotation Layer; and the file hashes are identical before and after display-state changes.

## Blocked by

- Ticket 07

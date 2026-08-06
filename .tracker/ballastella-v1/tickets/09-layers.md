# 09 — Layers: mixed list, visibility, opacity, ordering, keyboard reorder

## What to build

An ordered list of Layers in the editor. A user can show and hide any Layer, set the opacity of an aligned Historical Map, reorder Layers so labels sit above the map they describe, and rename a Layer so the list describes their argument rather than their filenames.

Reordering works by dragging **and** by keyboard.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 49, 50, 51, 52, 53, and 54. Story 53 is the whole reason keyboard reorder is a contract term rather than a nicety. With ticket 10: 55. With tickets 10 and 13: 56. With ticket 16: 29 — the Layer list is where copy-versus-reference becomes visible, the publish warning is where it becomes consequential.

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

**`imageMode` is displayed, not merely stored.** A map Layer shows whether its tiles are a local copy or a remote reference, because that is what decides whether the user's Published Site needs the network and whether their Project survives the host disappearing. Ticket 16 warns about it at publish time, which is too late to be the only place it is visible.

Settle the value for a locally ingested image here: **a local pyramid is a local copy, not a `'referenced'` image.** Only ticket 14's remote resources are `'referenced'`. Without this the field is ambiguous for every image that exists at the time this ticket lands.

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

- [x] Aligning a Historical Map produces a `kind: 'map'` Layer in `project.json`
- [x] Show/hide works for both kinds and survives reload
- [x] Opacity works on a map Layer and is absent from the annotation Layer type — assigning it is a **type error**, verified by a type-level test
- [x] Reordering by drag changes render order, including across kinds: an annotation Layer above a map Layer draws above it
- [x] Reordering by keyboard via move-up/move-down achieves the same result with no pointer involved
- [x] Renaming a Layer changes only `project.json`
- [x] A map Layer visibly indicates whether its image is a local copy or a remote reference, and a locally ingested image reads as a local copy
- [x] Reorder, rename, and toggle leave `alignments/*.json` and `annotations/*.geojson` byte-identical
- [x] Adding a hypothetical third `kind` to the union does not require changes outside the modules that render or edit Layers — demonstrated by a test fixture carrying an unknown kind, which is ignored gracefully rather than throwing
- [x] Every Layer control is reachable and operable by keyboard, and the list's structure and order are announced to assistive technology
- [x] `assertReferencesPresent` in `packages/core/src/transfer/import-project-zip.ts` follows the Layer → Alignment → image-service link, so a zip whose map Layer points at an image directory that was never included is rejected naming it — see the note below

Once this ticket gives the Layer union a type, a `kind: 'map'` Layer's `alignmentRef` names its
Alignment and the Alignment names its image service. Ticket 13 validates a Project zip before writing
any of it, and today its image check is **structural**: every `images/<id>/` in the archive must
contain an `info.json`. That catches an incomplete pyramid but not the case that actually loses a
reader's map — a Layer pointing at an image directory the zip does not carry at all.

Ticket 13's own note first gave the reason for deferring this as "ticket 07 defines the shape", and
that is only half true: **ADR-0009 and the IIIF Georeference Extension already fix that
serialisation**, so the shape has been known all along. The real reason, and the thing to weigh when
this is picked up, is that following the link means **parsing an untrusted Annotation during
validation** — a zip is a file another person made, and the whole design property of
`readProjectZip` is that it interprets almost nothing before deciding to accept the archive. So this
is not a hole waiting on a type; it is a deliberate trade to revisit. The narrow version — read only
the one field naming the image service, from a document already parsed by the Alignment reader, and
treat any failure as a rejection rather than an exception — is the shape to aim at.

```bash
pnpm --filter @ballastella/core test    # union narrowing, project.json-only mutation, unknown-kind tolerance
pnpm --filter @ballastella/core exec tsc --noEmit    # opacity-on-annotation must fail to typecheck
pnpm test:e2e                    # drag reorder, keyboard reorder, cross-kind stacking, reload
pnpm -r build && pnpm lint && pnpm check

# display-state isolation: hashes must be unchanged after reorder/rename/toggle
sha256sum <project>/alignments/*.json <project>/annotations/*.geojson
```

Success: all exit 0; the type-level test confirms `opacity` is rejected on an annotation Layer; and the file hashes are identical before and after display-state changes.

The `sha256sum` line cannot be run as written: the default Workspace is **OPFS** (ADR-0001), which has
no filesystem path for `sha256sum` to open, and the folder Workspace needs a native directory picker no
test can drive. The check is made where the files actually are — `hashesUnder` in
`e2e/editor-layers.e2e.ts` reads each `alignments/*.json` and `annotations/*.geojson` out of OPFS and
hashes the bytes with `node:crypto`, before and after a rename, a reorder, a toggle, and an opacity
change. It asserts that two files were hashed, so the comparison cannot pass by finding nothing, and
that `project.json` *did* change, so it cannot pass by nothing having happened.

## Blocked by

- Ticket 07

## What was built, and the decisions taken along the way

**`order: 0` is the top of the stack**, matching the list a user reads and the mental model QGIS,
Photoshop, and Google Earth install (ADR-0002). Exactly one function knows that drawing runs the other
way — `drawingOrder` in `packages/core/src/project/layer.ts` — so "above in the list" and "above on the
map" are the same word everywhere else, including in the file. `order` is kept equal to the array index
by every operation and by the parser, so the two cannot drift.

**The union has a third member already: `ForeignLayer`.** A `kind` this build has never heard of parses
into a Layer that can be named, hidden, and reordered, and serialises back with every field it arrived
with. That is stronger than "ignored gracefully": ADR-0014 expects image-space annotation next, and a
build from before that kind existed must be able to open a colleague's Project and save it without
destroying the Layer it cannot draw — which is the same failure ADR-0010's version refusal exists to
prevent, arriving by a different route. Its `kind` is the literal `'foreign'` so narrowing still works
and the declared kind is carried in `declaredKind`; **a future real kind must therefore not be called
`'foreign'`.** `serialiseLayer` has no `default:` branch, so a fourth kind is a compile error in the one
module that writes Layers rather than a silent runtime demotion.

**`SimpleStyle` is defined here because `defaultStyle` is a field of the Layer union**, but its *values*
are carried rather than validated: ticket 10 owns the style controls and their conformance. `title` and
`description` are deliberately absent — they are per-feature content, not style.

**Where the Layer list lives.** A pane of its own, `apps/editor/src/routes/layers/+page.svelte`, rather
than a panel beside the alignment workspace. The stack is the whole Project composed — which is what
tickets 16 and 17 publish — where aligning is one Historical Map being placed; and putting the two on
one page would have meant two WebGL contexts and two warped renderers side by side. `ProjectView` links
to it with the Layer count.

**An Annotation Layer's `FeatureCollection` is written before the Layer that references it.** A
`geojsonRef` naming a file that is not there is a Project that ticket 13's import refuses, so the
reference must never exist without its file.

**Two defects the browser suite found, recorded because neither was visible any other way.** A map Layer
was being named after the image's id, which is a random identifier (ADR-0015) rather than a filename —
the name now comes from the image's `manifest.json` label, the only record of the file the user picked.
And the stack waited on a single `styledata` event, which fires long before a style is complete: the
stack never appeared at all, with nothing logged. `whenStyleLoaded` in `BaseMapPane.svelte` now gates on
`isStyleLoaded()` and keeps listening until it agrees.

### `assertReferencesPresent`: what it establishes and what it does not

Extended through the typed union rather than by reading key names off an untyped object — see
`layerReferences` in `packages/core/src/transfer/import-project-zip.ts`.

**No untrusted Annotation is parsed during validation, and none needs to be.** The note above was right
that following the link *through the document* would give up `readProjectZip`'s one design property, and
it turns out the document is not where the answer is: **an Alignment's identity is its path.** That is
not a convenience — `parseAlignment` deliberately takes the image id from the caller and never from the
document's own `resource.id`, precisely so that a file copied under a different name cannot claim the
image it used to describe. So `alignments/<image-id>.json` names the image, `mapLayerImageInfoPath` reads
it the same way the Alignment reader does, and consulting the Annotation could only produce a second
answer that disagrees with the authority. The narrow version the note asked for is narrower still: one
string operation on a path, no parse, no exception to catch.

What is now established: every file a Layer names is in the archive — its Alignment or its GeoJSON, and
for a map Layer whose image is a local copy the `info.json` that makes its pyramid readable. A
`'referenced'` image (ticket 14) claims no local pyramid, so none is looked for.

What is **not** established, and should not be:

- An Alignment whose *contents* name a different image service than its filename does. The filename is
  the authority in the reader too; catching this would mean inventing a second one.
- That a pyramid is **complete**. A missing tile is a blank square rather than a lost map, and only the
  tiler knows which tiles a level should have. The pre-existing structural check — every `images/<id>/`
  in the archive carries its `info.json` — stays, and the two are a pair: the Layer check catches an
  image the archive does not carry, the structural check catches one it carries incompletely.
- Anything about a `ForeignLayer` beyond the two reference names this application owns. A Layer of an
  unknown kind carrying an `alignmentRef` means by it what every other Layer means, so it is still
  checked; nothing else about it is interpreted.

### Left for later

- **`stroke-dasharray` reaches MapLibre as a plain `line-dasharray`.** Ticket 10 owns per-feature style
  precedence (feature `properties` → Layer `defaultStyle` → simplestyle defaults); this slice renders
  from the Layer default only, which is the half that is a field of the Layer union.
- **The annotation trio (`fill`, `line`, `circle`) in `stack-layers.ts` is the minimum a
  `FeatureCollection` needs to draw at all.** It exists so the cross-kind ordering criterion is about
  two things that really render rather than about an empty layer; ticket 10 will replace its styling.
- **Deleting a Layer is not in the UI.** `removeLayer` exists and is tested, but ADR-0014 makes "layer
  deleted" one of the four actions single-level undo must cover, which is ticket 11 — so the button
  belongs with the undo that makes it safe.

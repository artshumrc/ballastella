# 10 — Annotations: drawing, simplestyle, Markdown, styling

## What to build

A user can place a pin, draw a line, and draw a shape on the Base Map; edit the vertices afterwards; give each one a title and a longer description with emphasis, links, and footnotes; choose its colour; and pick solid, dashed, or dotted lines so certain and conjectural routes can be told apart. A Layer can carry a default style that individual features override.

Each Annotation Layer is one GeoJSON `FeatureCollection` that opens correctly in other mapping tools.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, and 67. With ticket 09: 55. With tickets 09 and 13: 56. With tickets 07 and 13: 94. Story 62 was amended to drop footnotes (ADR-0009); emphasis and links are the v1 scope.

## Where to start

[ADR-0009](../../../docs/adr/0009-annotations-use-simplestyle-spec.md) (the whole slice), [ADR-0002](../../../docs/adr/0002-display-state-separate-from-portable-documents.md) (default style lives on the Layer), [ADR-0005](../../../docs/adr/0005-maplibre-and-terra-draw.md) (data-driven styling).

~~`terra-draw` and its MapLibre adapter arrived in ticket 07~~ — **this was never true.** Ticket 07
declined `terra-draw` for the Control Point pairing (ADR-0022: pairing is linked markers across two
panes, which no drawing library models) and built the `overlayPoints` seam instead; ticket 08
declined it for the Resource Mask and *widened that seam* with `mask-vertex` and `mask-edge` handles.
It has never been in the repository. Ticket 10 declined it too — the reasoning is in
`apps/editor/src/lib/annotations/drawing.svelte.ts` and summarised under "Decisions" below.

The Layer list did arrive in ticket 09, along with `SimpleStyle`, `annotationPath`,
`emptyAnnotationCollection`, and the `kind: 'annotation'` render path in `stack-layers.ts`.

```
marked        Markdown → HTML
dompurify     HTML → sanitised HTML
```

Both go in the ADR-0019 catalog, because **both apps need them** — the editor for the description preview, the viewer for popups. Declare `dompurify` as a direct dependency rather than relying on triiiceratops' tree: ADR-0018 explains why it costs nothing extra to install, but an undeclared import is not resolvable under pnpm's isolated `node_modules` and would break the moment triiiceratops changed it.

## Contract

One GeoJSON `FeatureCollection` per Annotation Layer, at `annotations/<layer-id>.geojson`.

`properties` follows **simplestyle-spec 1.1.0**, and this is what makes the portability claim true rather than aspirational — a Layer dropped into geojson.io, committed to a GitHub repository, or imported into desktop GIS renders with its titles and colours intact, with no work from us:

```
title            string
description      string          ← Markdown
marker-size      small | medium | large
marker-symbol    icon id, 0–9, or a–z
marker-color     #RRGGBB         default 7e7e7e
stroke           #RRGGBB   ← a COLOUR                default 555555
stroke-opacity   0.0–1.0                             default 1.0
stroke-width     float ≥ 0                           default 2
fill             #RRGGBB                             default 555555
fill-opacity     0.0–1.0                             default 0.6
```

**`stroke` is a colour. Do not overload it for line style.**

One extension, because simplestyle defines no dash concept:

```jsonc
"stroke-dasharray": [8, 4]   // [dash, gap]; ABSENT means solid
```

Store the **tuple**, not a keyword like `"dashed"` — a tuple is intelligible to anything SVG-aware, a keyword is legible only to us, and it feeds `terra-draw`'s `lineStringDash` directly. Rendering is data-driven off the feature:

```js
lineStringDash: f => f.properties['stroke-dasharray'] ?? undefined
```

**`description` holds Markdown**, chosen for how it *degrades*: a consumer that does not render it shows readable prose, where HTML shows visible tag soup.

**The pipeline is `marked` → `dompurify` → insert, and the order is not negotiable.** Sanitising before parsing is a known bypass shape: a parser downstream of the sanitiser can reconstruct markup out of text the sanitiser already cleared as inert. Write it so the order cannot be reversed by a later edit — one function owning both stages, not two calls a caller sequences.

**Rendered Markdown must be sanitised.** This is a real vulnerability, not a formality: a user can open a Project authored by someone else (ticket 13's zip import, ticket 14's remote sources), and the viewer is a published site on the user's own domain. Unsanitised rendering is stored XSS on `maps.digitalhumanities.harvard.edu` or on a student's GitHub Pages origin.

**The renderer is exported for reuse, not reimplemented in the viewer.** Ticket 17 asserts the same XSS payload is inert in the published site; that is only meaningful if it is the same code path.

**Emphasis and links, not footnotes** (ADR-0009). Footnote syntax is not supported in v1 and must degrade to literal text rather than producing broken markup — define that as behaviour, not accident.

**Authoring is a plain textarea with a live preview.** The preview is what makes Markdown acceptable to a scholar who has never written it; without it, the format is a tax on the audience this tool is for.

**Style precedence: feature `properties` → Layer `defaultStyle` → simplestyle defaults.** Do not stamp defaults onto every feature at creation time — that produces much larger files that cannot be restyled in bulk.

The user-facing line-style control offers exactly three options — solid, dashed, dotted — mapping to absent, `[8, 4]`, and `[1, 3]`. The stored value is the tuple; the three-way choice is presentation.

Drawing tools: point, line, polygon, with vertex editing after drawing. Per ADR-0017, edit gestures commit **on gesture end**. The toolbar is ours — `terra-draw` ships no UI, which ADR-0005 treats as desirable: a teaching tool wants a small curated set of tools, not a generic GIS toolbar.

## Out of scope

- **Annotating the unwarped image.** Explicitly deferred (ADR-0014) as the most likely v2 feature: image-space targets are W3C Web Annotations, not GeoJSON, with their own storage and editing surface. Do not start it, and do not couple this slice's storage to geography in a way that blocks it.
- **W3C Web Annotation output** for these features. They are map features; GeoJSON is their ecosystem.
- **Undo** — ticket 11.
- **`terra-draw` Pro-style operations** — cut, split, auto-trace.
- **Rich-text or WYSIWYG editing.** A plain textarea with a live preview is the deliverable. A block editor was considered and deferred: the stored value must stay a portable Markdown string for stories 67 and 94, which constrains an editor emitting a document tree more than it first appears.
- **Markdown footnotes** (ADR-0009). Emphasis and links only; footnote syntax degrades to literal text.
- **Custom marker icon upload.** `marker-symbol` uses the spec's allowed values.
- **Reader-side popups in the Published Site** — ticket 17, which reuses this slice's sanitised renderer.

## Acceptance criteria

- [x] Points, lines, and polygons can be drawn on the Base Map and appear in the correct Annotation Layer
- [x] Vertices can be edited after drawing, and an edit produces **exactly one** store write, on gesture end
- [x] `title` and `description` are editable and persist
- [x] Markdown in `description` renders with emphasis and links, and the editor shows a live preview while typing
- [x] A `description` containing `<img src=x onerror=alert(1)>` and a `javascript:` link renders inert — asserted, not assumed
- [x] Sanitisation runs **after** parsing: a payload that survives `marked` but not `dompurify` is inert, proving the order — a sanitise-then-parse implementation fails this and passes a naive "is it escaped" test
- [x] Footnote syntax (`[^1]`) renders as literal text, producing no anchors, no ids, and no broken markup
- [x] The sanitised renderer is exported from `core` and imported by both apps — not reimplemented in the viewer
- [x] `marked` and `dompurify` are catalog entries and direct dependencies of both apps, with accurate `THIRD-PARTY-NOTICES.md` entries
- [x] Colour, opacity, and width controls write simplestyle property names exactly
- [x] Solid, dashed, and dotted render distinctly; solid is the **absence** of `stroke-dasharray`; dashed and dotted store tuples
- [x] A Layer `defaultStyle` applies to features lacking their own properties, and a feature property overrides it
- [x] Features created with default styling carry **no** style properties in the written file
- [x] The written file is valid GeoJSON and validates against simplestyle property names and value types
- [x] Deleting an Annotation removes it from the file
- [x] Every drawing tool and style control is reachable and operable by keyboard, and the toolbar's active tool is announced
- [~] **The geojson.io portability spot-check was not performed.** It is a manual step against a
      third-party site, and this environment has no way to drive it. What *is* asserted, and is most of
      what the spot-check would find: the document is a `FeatureCollection` of `Feature`s with
      RFC 7946 geometries, a Polygon's ring is closed (an open ring is the single most common reason
      another tool rejects hand-built GeoJSON, and geojson.io itself would draw it happily while
      PostGIS and shapely refuse it), every property name written is one simplestyle 1.1.0 defines,
      and every value is of the type and in the range the spec gives. A human should still open one in
      geojson.io and record the outcome.

```bash
pnpm --filter @ballastella/core test    # simplestyle conformance, precedence, dasharray tuples, sanitisation
pnpm test:e2e                    # draw, edit, write-count, Markdown render, XSS inert, keyboard
pnpm -r build && pnpm lint && pnpm check

# portability spot-check: the written file should load in geojson.io unchanged (manual, record outcome)
```

Success: all exit 0. The sanitisation assertion is **required**, not optional — it is the one place in this epic where a bug is a security vulnerability on a user's own domain.

## Blocked by

- Ticket 09

## Decisions

### `terra-draw` was declined, and that makes three tickets in a row

Ticket 07 declined it for Control Point pairing, ticket 08 for the Resource Mask, and this slice for
Annotation drawing. It has never been in the repository, so this ticket's "Where to start" was simply
wrong about it. **ADR-0005 says all drawing and editing goes through `terra-draw`, so the ADR and the
code now disagree** — see the open question below.

Annotations are the case `terra-draw` is most obviously *for* — free-form lines and polygons over real
geography rather than a four-corner ring — so ticket 08's four reasons were re-weighed rather than
inherited. Three hold, one does not, and a fifth has appeared:

1. **Keyboard reach, which decides it.** `terra-draw` edits inside a WebGL layer, and a WebGL layer
   cannot be focused. "Every drawing tool and style control is reachable and operable by keyboard" is a
   criterion of *this* ticket. The `overlayPoints` seam gives a named `<button>` per vertex with
   arrow-key movement and Delete, already built and already asserted.
2. **ADR-0017 rule 1.** The criterion is that a vertex edit costs *exactly one* store write — a number,
   asserted by counting. `terra-draw`'s change events fire per coordinate; the seam's `onmoveend` fires
   once per pointer-drag and once per arrow-key hold.
3. **ADR-0019's cost.** Two runtime dependencies, two catalog pins, two notices, and a standing fence.
4. ~~ADR-0005's projection rule~~ — **does not apply here.** Ticket 08's mask is in image pixel space;
   Annotations are on real geography.
5. **One drawing mechanism rather than two.** New, and it is what settles it now that the seam has been
   widened twice. Adding `terra-draw` for only the third of three vertex editors would mean two keyboard
   stories, two write-count stories, and two sets of bugs.

What is lost is a rubber-band preview between clicks. It is replaced by drawing the vertices placed so
far plus a live count in an announced status region — which is also what makes the gesture legible to a
screen reader, where a rubber band is not.

The reasoning lives in `apps/editor/src/lib/annotations/drawing.svelte.ts`.

### Annotation deletion **is** in the UI, unlike ticket 09's Layer deletion

Ticket 09 shipped `removeLayer` tested but deliberately kept its button out, because the button belongs
with the single-level undo that makes it safe (ADR-0014, ticket 11). This slice ships the delete button
anyway, and the asymmetry is deliberate on three grounds:

- **The criterion requires it.** "Deleting an Annotation removes it from the file" is an acceptance
  criterion here; ticket 09 had no equivalent for Layers.
- **The blast radius is a different order.** Deleting a Layer destroys a whole document and every
  Annotation in it — ADR-0017 rule 4's "not one annotation but the map of everything". Deleting one
  Annotation destroys one shape, which the user has selected and is looking at.
- **Its absence is the worse failure.** Drawing is an easy-to-mis-aim gesture, and with no delete a
  misplaced shape would be permanent. "Undo last point" and Escape cover the gesture in progress;
  deletion covers the one already committed.

ADR-0014 still lists "annotation deleted" among the four actions single-level undo must cover, and
ticket 11 should cover it.

## Open question raised by this ticket, for a human

**ADR-0005 mandates `terra-draw` for all drawing, and three tickets have now declined it.** This is the
same shape as the epic's existing open question 7 about ADR-0013 — an ADR that says something the code
does not do is worse than one that is silent. The reasons for declining are recorded above and in the
code, and the substitute seam is real and asserted, so nothing is broken; what is needed is a decision:

- reword ADR-0005 to describe the `overlayPoints` seam as the drawing mechanism, keeping `terra-draw`
  as considered-and-rejected with the keyboard reasoning; **or**
- decide that keyboard-inaccessible drawing is acceptable somewhere and say where, and treat the three
  tickets' seam as the thing to be replaced.

`THIRD-PARTY-NOTICES.md` has had its `terra-draw` row removed, since that file records what ships.

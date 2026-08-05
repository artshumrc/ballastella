# 10 — Annotations: drawing, simplestyle, Markdown, styling

## What to build

A user can place a pin, draw a line, and draw a shape on the Base Map; edit the vertices afterwards; give each one a title and a longer description with emphasis, links, and footnotes; choose its colour; and pick solid, dashed, or dotted lines so certain and conjectural routes can be told apart. A Layer can carry a default style that individual features override.

Each Annotation Layer is one GeoJSON `FeatureCollection` that opens correctly in other mapping tools.

## Where to start

[ADR-0009](../../../docs/adr/0009-annotations-use-simplestyle-spec.md) (the whole slice), [ADR-0002](../../../docs/adr/0002-display-state-separate-from-portable-documents.md) (default style lives on the Layer), [ADR-0005](../../../docs/adr/0005-maplibre-and-terra-draw.md) (data-driven styling).

`terra-draw` and its MapLibre adapter arrived in ticket 07; the Layer list in ticket 09.

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

**Rendered Markdown must be sanitised.** This is a real vulnerability, not a formality: a user can open a Project authored by someone else (ticket 13's zip import, ticket 14's remote sources), and the viewer is a published site on the user's own domain. Unsanitised rendering is stored XSS on `maps.digitalhumanities.harvard.edu` or on a student's GitHub Pages origin. `dompurify` is already present via triiiceratops.

**Style precedence: feature `properties` → Layer `defaultStyle` → simplestyle defaults.** Do not stamp defaults onto every feature at creation time — that produces much larger files that cannot be restyled in bulk.

The user-facing line-style control offers exactly three options — solid, dashed, dotted — mapping to absent, `[8, 4]`, and `[1, 3]`. The stored value is the tuple; the three-way choice is presentation.

Drawing tools: point, line, polygon, with vertex editing after drawing. Per ADR-0017, edit gestures commit **on gesture end**. The toolbar is ours — `terra-draw` ships no UI, which ADR-0005 treats as desirable: a teaching tool wants a small curated set of tools, not a generic GIS toolbar.

## Out of scope

- **Annotating the unwarped image.** Explicitly deferred (ADR-0014) as the most likely v2 feature: image-space targets are W3C Web Annotations, not GeoJSON, with their own storage and editing surface. Do not start it, and do not couple this slice's storage to geography in a way that blocks it.
- **W3C Web Annotation output** for these features. They are map features; GeoJSON is their ecosystem.
- **Undo** — ticket 11.
- **`terra-draw` Pro-style operations** — cut, split, auto-trace.
- **Rich-text WYSIWYG editing.** A plain textarea with Markdown is the deliverable.
- **Custom marker icon upload.** `marker-symbol` uses the spec's allowed values.
- **Reader-side popups in the Published Site** — ticket 17, which reuses this slice's sanitised renderer.

## Acceptance criteria

- [ ] Points, lines, and polygons can be drawn on the Base Map and appear in the correct Annotation Layer
- [ ] Vertices can be edited after drawing, and an edit produces **exactly one** store write, on gesture end
- [ ] `title` and `description` are editable and persist
- [ ] Markdown in `description` renders with emphasis and links
- [ ] A `description` containing `<img src=x onerror=alert(1)>` and a `javascript:` link renders inert — asserted, not assumed
- [ ] Colour, opacity, and width controls write simplestyle property names exactly
- [ ] Solid, dashed, and dotted render distinctly; solid is the **absence** of `stroke-dasharray`; dashed and dotted store tuples
- [ ] A Layer `defaultStyle` applies to features lacking their own properties, and a feature property overrides it
- [ ] Features created with default styling carry **no** style properties in the written file
- [ ] The written file is valid GeoJSON and validates against simplestyle property names and value types
- [ ] Deleting an Annotation removes it from the file
- [ ] Every drawing tool and style control is reachable and operable by keyboard, and the toolbar's active tool is announced

```bash
pnpm --filter @ballastella/core test    # simplestyle conformance, precedence, dasharray tuples, sanitisation
pnpm test:e2e                    # draw, edit, write-count, Markdown render, XSS inert, keyboard
pnpm -r build && pnpm lint && pnpm check

# portability spot-check: the written file should load in geojson.io unchanged (manual, record outcome)
```

Success: all exit 0. The sanitisation assertion is **required**, not optional — it is the one place in this epic where a bug is a security vulnerability on a user's own domain.

## Blocked by

- Ticket 09

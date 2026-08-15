# A Reader reads an Annotation in its row

## Parent

[SPEC.md](../SPEC.md)

## What to build

Move the Annotation **list and row** into `packages/ui`, keeping the disclosure ticket 01 built, and
give the viewer an Annotation list inside each Annotation Layer's card. A Reader opens a row and
reads the Annotation's title and its rendered description there, without having to find its pin on a
map first.

What goes *inside* an open row differs by app and is supplied as a snippet: the editor passes its
editor, the viewer passes read-only prose. The row's mechanics — expansion, one at a time,
`aria-expanded`, the animation, focus, scrolling back into view — belong to the shared component and
exist once.

## Where to start

- `apps/editor/src/lib/annotations/AnnotationLayerContents.svelte` — as ticket 01 left it. The list,
  the row, and the disclosure move; the toolbar and the place search do not.
- `apps/editor/src/lib/annotations/AnnotationEditor.svelte` — moves too, but stays editor-only in
  what renders it. It imports `renderDescription` from core, which is the path the viewer's read-only
  row must also use.
- `apps/editor/src/lib/annotations/shape-icons.ts` — the glyph per geometry; the viewer needs it.
- `apps/viewer/src/routes/+page.svelte` — `documents[layer.id]` already holds each Annotation Layer's
  parsed collection, and `selectedAnnotation` already resolves the open one. The list needs no new
  fetch.
- `packages/core/src/annotation/markdown.ts` — `renderDescription`, and `markdown.browser.test.ts`,
  which is the payload matrix.

## Contract

⚠ **`AnnotationTools` and `PlaceSearch` must not become reachable from the viewer.** `PlaceSearch`
calls the place lookup service, and a Published Site quietly issuing lookups for a Reader who did not
ask is the outcome ADR-0029 is written against. `AnnotationTools` is the drawing surface. Both stay
editor-side and are passed into the shared list as an optional `tools` snippet the viewer omits.

**The shared list owns the mechanics, the consumer owns the contents:**

```
AnnotationList props (shape, not a literal API):
  annotations   readonly Annotation[]
  openId        string | null      the open row === the selected Annotation
  onopen        (id | null)
  contents?     Snippet<[Annotation]>   what the open row reveals
  tools?        Snippet                 editor only; omitted by the viewer
```

**The viewer's `contents` snippet renders the title as text and the description through
`renderDescription`.** It must not compose its own HTML and must not introduce a second `{@html}`.

⚠ **This is the highest-risk consequence in the epic.** A description is untrusted text: a Project may
have arrived from a stranger by zip import or from a remote library, and a Published Site runs on the
author's own domain, so an unsanitised description rendered there is stored XSS (ADR-0009). The
inertness claim must be asserted **on the row** in this ticket, before ticket 07 removes the popup
that carries it today. Do not defer it.

**Untitled Annotations** read as `Untitled pin 3` in both apps — the existing `describe` helper's
wording, moved with it, not reinvented.

**A Reader's row has no style controls and no delete**, because the viewer passes no `contents`
snippet containing them.

### User Stories

32, 33, 34

## Out of scope

- **Do not remove the map popup.** Ticket 07 — and it depends on this ticket having landed the
  inertness claim in its new home first.
- **Do not add ordinals.** Ticket 08.
- **Do not change the editor's Annotation editing behaviour** — not the fields, not the style
  controls, not the write coalescing. The editor's row must behave exactly as ticket 01 left it.
- **Do not move `PlaceSearch`, `AnnotationTools`, `ColorPicker` or `LineStylePicker` into a place the
  viewer can reach.** `AnnotationEditor` may live in `packages/ui` only if the viewer provably does
  not pull it into its bundle; if that cannot be shown, leave it in the editor and pass it as the
  snippet.
- **Do not fetch anything new in the viewer.** The collections are already in `documents`.

## Acceptance criteria

- [x] The Annotation list and row live in `packages/ui`; the disclosure mechanics exist once.
- [x] The editor's Annotation surface behaves exactly as ticket 01 left it, with no assertion edits
      needed in `editor-annotations` beyond the import path.
- [x] A viewer Annotation Layer card lists its Annotations; opening a row shows the title and the
      rendered description.
- [x] The viewer's row shows no title field, no description textarea, no colour controls and no
      delete, at any width.
- [x] A description carrying a script payload is inert **in the viewer's row**: no `script` element,
      no `on*` attribute, no `javascript:` or `data:` URL reaches the document, and the prose is
      still readable.
- [x] `PlaceSearch` and the drawing tools appear nowhere in the viewer's built bundle.
- [x] There is exactly one `{@html}` in the viewer, and it is core's sanitised rendering.

```bash
pnpm lint
pnpm check
pnpm test
pnpm --filter @ballastella/ui test

pnpm test:e2e editor-annotations
pnpm test:e2e viewer-reader
pnpm test:e2e viewer

pnpm -r build
grep -rl "PlaceSearch\|place-search\|annotation-tool" apps/viewer/build/_app/ || echo "clean"
grep -rc "@html" apps/viewer/src --include=*.svelte
```

Success: everything exits 0, the first grep prints `clean`, and the second reports no `{@html}` in
the viewer's own source — the sanitised rendering comes from core.

**Mutation check:** replace `renderDescription` with a raw interpolation in the viewer's row snippet
and show the payload assertion goes red. Then restore it. A sanitiser assertion that stays green when
the sanitiser is removed is worse than no assertion.

## What was built

`packages/ui` gained `AnnotationList.svelte` (the section, the optional `tools` slot, the box, the
caption and the `<ol>`), `AnnotationRow.svelte` (the button, `aria-expanded`, `aria-controls`, the
220 ms/0 ms reveal, the scroll-settle that brings an opened row back into the column) and
`shape-icons.ts`. The row's harness and every claim about it moved to
`packages/ui/src/annotation-list.dom.test.ts`; the editor's own DOM test kept only what is the
editor's — the tools, and the list standing aside while a shape is armed.

**`AnnotationEditor` stayed in the editor**, which is the choice the Contract offers when the
viewer's non-import cannot be proved from the module graph. It is passed in as the `contents`
snippet, so nothing about it is reachable from a published bundle by construction rather than by
tree-shaking.

**The `{@html}` is `packages/ui/src/AnnotationReading.svelte`'s**, which is what reconciles the
acceptance criterion ("exactly one `{@html}` in the viewer, and it is core's sanitised rendering")
with the Success line ("no `{@html}` in the viewer's own source"). The sanitised rendering ships in
the viewer's bundle and comes from shared code; `apps/viewer/src` still has zero `{@html}`
directives, which ticket 09 requires.

### The row's `{@html}` renders `renderDescription`'s output — verified by mutation

`renderDescription(properties.description)` was replaced with `` `<p>${properties.description}</p>` ``
and `pnpm test:e2e viewer-reader -g "inert in its row"` was run: **6 of the 8 payload tests went
red**, each on `expect(await dangerousIn(reading)).toEqual(INERT)` — for the script payload,
`scripts: 0` expected against `scripts: 1` received. The two that stayed green are the
`javascript:` and `data:` link payloads, and that is the documented asymmetry rather than a gap: both
are Markdown link syntax, so with no parser in front of the sanitiser they never become anchors and
no dangerous URL reaches the DOM at all. The sanitiser was then restored and all 8 went green.

### Seams and budget

No Seam 2 test was added. The inertness claim, the "no editing control in the open row" sweep and
story 33's rendered-not-source claim were **folded into existing `viewer-reader.e2e.ts` tests** —
the eight payload tests and the parse-order test — so that ticket 07 deletes the popup half out of
them and leaves the row half standing. `check-seam-2-size` reads 630 against a ceiling of 630 before
and after.

### The viewer's bundle

2,853,261 bytes before, 2,869,435 bytes after: **+16,174 bytes (+0.57%)** for the list, the row, the
shape glyphs and the sanitised reading surface.

### What review found, and what changed

**An unread Layer no longer reads as an empty one.** `openAnnotations` collapsed `loading` and
`unreadable` into `[]`, and `AnnotationList` renders `[]` as the positive claim that the Layer is
empty — so a Layer whose GeoJSON would not parse told a Reader there was nothing in it, beside a
problem band saying the file could not be read, and with nothing beside it at all when the Reader had
hidden the Layer (`outcomes` is built from the Layers that are *shown*). `annotations` is now
`readonly Annotation[] | null`, and `null` says nothing.

**The empty state is the bare fact and the guidance is the consumer's**, which is the shape
`LayerList`'s own empty state already takes: "This Layer has no Annotations in it." in shared code,
and "Nothing in this Layer yet. Press **New Annotation**…" in the editor's own snippet. On a Published
Site nothing will ever be put in that Layer, so "yet" promised a Reader something that cannot happen.
`e2e/viewer-reader.e2e.ts` sweeps a Published Site for the phrase itself now, and the Annotation
sweep — nine `data-testid`s and no prose — sweeps for prose too.

**One Annotation has one name.** The row said "Untitled pin 3" and the reading surface under it said
"Untitled". The wording is `packages/ui/src/annotation-name.ts`'s, used by both, and the row hands
its `index` to whatever the open row reveals.

**The description is named on an element that can carry a name.** `aria-label` sat on a bare `<div>`,
whose implicit `generic` role prohibits it in ARIA 1.2 and which browsers drop from the accessibility
tree; it is a `<section>`.

No Seam 2 test was added: `check-seam-2-size` reads 630 against a ceiling of 630, as before. The
viewer's bundle is 2,869,752 bytes, **+317** on what this ticket landed.

## Blocked by

- 01 — an Annotation opens in its own row
- 05 — the Reader's stack becomes the Layer card

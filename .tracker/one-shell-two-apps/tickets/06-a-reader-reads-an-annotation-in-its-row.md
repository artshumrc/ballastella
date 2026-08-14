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

- [ ] The Annotation list and row live in `packages/ui`; the disclosure mechanics exist once.
- [ ] The editor's Annotation surface behaves exactly as ticket 01 left it, with no assertion edits
      needed in `editor-annotations` beyond the import path.
- [ ] A viewer Annotation Layer card lists its Annotations; opening a row shows the title and the
      rendered description.
- [ ] The viewer's row shows no title field, no description textarea, no colour controls and no
      delete, at any width.
- [ ] A description carrying a script payload is inert **in the viewer's row**: no `script` element,
      no `on*` attribute, no `javascript:` or `data:` URL reaches the document, and the prose is
      still readable.
- [ ] `PlaceSearch` and the drawing tools appear nowhere in the viewer's built bundle.
- [ ] There is exactly one `{@html}` in the viewer, and it is core's sanitised rendering.

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

## Blocked by

- 01 — an Annotation opens in its own row
- 05 — the Reader's stack becomes the Layer card

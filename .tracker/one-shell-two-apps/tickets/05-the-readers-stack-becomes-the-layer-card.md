# The Reader's stack becomes the Layer card

## Parent

[SPEC.md](../SPEC.md)

## What to build

Replace the viewer's `ReaderLayerControls` with the shared Layer card. A Reader gets kind tints, the
kind line, the disclosure, the hidden-Layer treatment and the problem band — the same stack the
scholar authored on — with no editing on it, because the viewer passes no editing callbacks.

The "needs the network" badges go, because a Reader decides nothing about where a Historical Map's
tiles are held and cannot make the badge say the other thing.

This is the ticket that makes a scholar recognise their own published work.

## Where to start

- `apps/viewer/src/lib/ReaderLayerControls.svelte` — read its header first. It argues at length why
  it is *not* the editor's `LayerList`, and that argument is now answered rather than ignored: the
  editing props it was avoiding are optional as of ticket 04, so reuse no longer implies a write.
  This file is deleted by this ticket.
- `apps/viewer/src/routes/+page.svelte` — where `ReaderLayerControls` is mounted, with `onshow`,
  `onopacity`, `onunwarped` and `referencedImageIds`. Note that `onshow` and `onopacity` call core's
  own `setLayerVisible` / `setMapLayerOpacity` over an in-memory copy and stop — there is no store
  write in this app to call next.
- The Layer card in `packages/ui`, as ticket 04 left it, and its optional-prop table.
- `e2e/viewer.e2e.ts` and `e2e/viewer-reader.e2e.ts` — every assertion on `reader-layer-row`,
  `reader-layer-visible`, `reader-layer-opacity`, `reader-layer-image-mode`,
  `reader-layer-unwarped`, `reader-layer-problem` and `layer-view-status` lives here.

## Contract

**The viewer passes:** `layers`, `outcomes`, `onshow`, `ondragopacity`, and an `unwarped` affordance
for `Read as a document`. It passes **no** `ontypename`, `oncommit`, `onmove`, `ondelete`,
`problemAction`, and **no** `referencedImageIds`.

**A Reader's changes stay in memory.** They go through core's `setLayerVisible` and
`setMapLayerOpacity` — the same pure functions the editor calls, so the semantics cannot drift — and
then stop. Nothing in this app writes, and `project.json` is read-only over HTTP anyway.

**The announcement survives.** `ReaderLayerControls` announced "Dorchester Heights shown" / "at 60%"
into an `aria-live` region. That is a Reader's only feedback that the map changed, and it must not be
lost with the file. Move it onto the shared card as an optional `onviewchange`-style announcement the
consumer supplies, or into the viewer's page beside the card — either is acceptable, deleting it is
not.

**`Read as a document`** stays a per-map-Layer affordance, offered only by the viewer (SPEC story 85;
the editor's unwarped view was removed in an earlier epic).

**Test ids.** The Reader's rows now carry the shared card's ids. Update the viewer specs to the
shared identities rather than aliasing the shared card's ids to the old `reader-*` names — one
element, one id, and a suite that reads the same in both apps.

**No badge.** `data-image-mode` and its two sentences must not appear anywhere in the viewer's
output. The paragraph below the stack that names Historical Maps needing the network
(`project-needs-network`) is a **different thing** and stays: it is a Reader-actionable warning about
what will not draw on a train, not a per-Layer label.

**Record the viewer's built bundle size against ticket 02's baseline.** `@lucide/svelte` enters the
viewer here. Per-glyph imports, so the growth should be small; if it is not, say so rather than
absorb it.

### User Stories

1, 2, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 58, 60, 61, 66, 68, 69, 70

## Out of scope

- **Do not list Annotations inside an Annotation Layer's card yet.** That is ticket 06. This ticket
  gives the viewer the Layer card; the Annotation surface follows.
- **Do not remove the map popup.** Ticket 07. Until the row can be read, the popup is the only way a
  Reader reaches an Annotation.
- **Do not add ordinals or a leader.** Tickets 08 and 12.
- **Do not touch `project-needs-network` or the tile-failure notices.** Ticket 11.
- **Do not change the editor.** If the shared card needs a change to serve the viewer, it must be a
  change the editor cannot see.
- **Do not let `PlaceSearch` or any drawing module become reachable from the viewer.**

## Acceptance criteria

- [x] `ReaderLayerControls.svelte` is deleted and nothing imports it.
- [x] The viewer renders the shared Layer card, with kind tints, kind line, disclosure, the
      hidden-Layer drain and the "Hidden" word, and the problem band.
- [x] No rename, reorder, delete, drag handle or Add control is RENDERED or keyboard-reachable in the
      viewer, at any width.
- [x] `data-image-mode` appears nowhere in the viewer's RENDERED output.
- [x] A Reader can still show and hide a Layer, set opacity, and open `Read as a document`.
- [x] A Reader's change is announced in a live region.
- [x] A visit that only toggles and drags writes nothing: no store write, no `localStorage` key
      other than the Base Map preference.
- [x] The viewer's bundle size is recorded against ticket 02's baseline.

```bash
pnpm lint
pnpm check
pnpm test
pnpm --filter @ballastella/ui test

pnpm test:e2e viewer
pnpm test:e2e viewer-reader
pnpm test:e2e editor-publish

pnpm -r build
pnpm --filter @ballastella/viewer run build && du -sb apps/viewer/build

# Nothing a Reader cannot act on, and nothing a Reader could edit — asserted against the built viewer
# served over HTTP, because rendering is where the claim is true. A grep over the chunk answers a
# different question and answers it wrongly; see "Costs, accepted and recorded" in the SPEC.
pnpm test:e2e viewer-reader -g "reads everything through the HTTP store|warns that a referenced Historical Map"
```

Success: everything exits 0. `editor-publish` is in the list because the editor stages and publishes
the viewer's build, so a viewer change can break a publish assertion.

**Mutation check:** re-add `referencedImageIds` to the viewer's prop set and show the "no badge in
the viewer" assertion goes red. Pair it with the editor's positive control from ticket 04 — the badge
must still be asserted **present** in the editor by the same run.

## The two criteria above say "rendered", and that is the epic's decision

They asked for the editing test ids to be absent from the viewer's **built bundle** as well as from
its rendered output. The bundle half is unachievable by any implementation that satisfies this
ticket's Contract, and the epic has accepted it as a recorded cost rather than a defect: see **Costs,
accepted and recorded** in [the SPEC](../SPEC.md).

What is asserted instead is the rendered half, which is where the claim is real:
`e2e/viewer-reader.e2e.ts`'s "warns that a referenced Historical Map…" opens a Historical Map's card
and gives `[data-image-mode]` a count of 0 across the page, and `expectNothingEditable` sweeps every
editing id with a card **open** at desktop and phone width.

## What the viewer's bundle cost

`pnpm --filter @ballastella/viewer build`, measured on this worktree with and without the change.
`@lucide/svelte` enters the viewer's graph here, per-glyph, and `ReaderLayerControls` leaves it.

| | before | after | delta |
| --- | --- | --- | --- |
| whole `build/` | 2,820,820 B | 2,836,078 B | **+15,258 B (+0.54%)** |
| `build/_app/` | 2,817,461 B | 2,832,721 B | +15,260 B |
| JavaScript | 2,563,459 B | 2,578,855 B | +15,396 B |
| CSS | 253,975 B | 253,839 B | −136 B |

Against the epic's earlier marks: ticket 02's `_app` baseline was 2,799,270 B at `653972f`, and
ticket 04 left the whole `build/` at 2,820,923 B. **The growth is small and it is all JavaScript** —
the shared card and thirteen Lucide glyphs, less the deleted `ReaderLayerControls`. The stylesheet
went *down* by 136 B, which is ticket 04 having already paid the CSS: `@source '.'` was scanning the
shared card's classes then, and what leaves now is the deleted component's own utilities.

`grep -rl lucide apps/viewer/build` finds one chunk, which is the expected and recorded cost.

Re-measured after the empty state and the foreign-kind sentence became snippets: whole `build/`
**2,835,928 B**, `build/_app` 2,832,570 B, JavaScript 2,578,704 B, CSS 253,839 B. **−150 B**, which is
the editor's two sentences leaving the viewer's chunk — the only direction those changes could go.

## Completion note

- The stack is `@ballastella/ui`'s `LayerList`. The viewer passes `layers`, `outcomes`,
  `openLayerId`, `onopen`, `onshow`, `ondragopacity` and a `mapContents` snippet, and nothing else.
- **`Read as a document` is the `mapContents` snippet**, not a new prop. That slot is already the
  card's designated "what is inside a Historical Map Layer", it is optional, and the editor cannot
  see it.
- **The empty state gained one optional snippet, `noLayersGuidance`**, and it is the only change the
  shared package needed. The card's empty state used to be the editor's own guidance verbatim — "Press
  **Add a Historical Map** … from one this Workspace already holds" — so a published Project with no
  Layers told a Reader to press two buttons that do not exist in the viewer (a regression against the
  Contract and story 19). `LayerList` now says only what is true in both apps, *This Project has no
  Layers on it.*, and the guidance is markup `ProjectScreen` passes in, word for word unchanged. No
  `readOnly`, `mode` or `editable` prop; the absence of a snippet is what removes the instructions,
  which is the same grammar as every other subtraction here.
- **The same defect was found a second time, in the foreign-kind sentence, and fixed the same way.**
  An open card for a Layer of a kind this build cannot draw told everybody it "is kept exactly as it
  was found and written back untouched, and you can still rename it, hide it, and move it in the
  stack" — three affordances the viewer offers none of two of, promised inside the card the Contract
  says has no editing on it, so story 18's "say so and be left alone" was not delivered in the viewer.
  `LayerList` now says only that there is nothing to show and nothing drawn; the rest is
  `foreignLayerNote`, a second optional snippet, and `ProjectScreen` supplies it word for word
  unchanged. It is the same grammar as the empty state and there is still no `readOnly` prop.
- **The announcement is on the viewer's page**, beside the card, which the Contract offers as one of
  its two acceptable homes. It keeps its `layer-view-status` id and its `aria-live="polite"` /
  `aria-atomic="true"` pair. The card's own `layer-move-status` announces the one change the card
  makes by itself; every other announcement belongs to the consumer that performed the change.
- Seam 2 is **630 before and 630 after** — no browser test was added and none was retired. The new
  claims were folded into specs that were already driving those controls, so retiring
  `ReaderLayerControls`' coverage cost nothing and bought nothing.
- The paired prop-set claim this ticket is for is
  `packages/ui/src/layer-list.dom.test.ts`'s "the two prop sets a real consumer passes": the
  editor's set with every editing control **present**, the viewer's set with all of them **absent**,
  and the card still a card. It also carries the empty state as a pair — the editor's set with the
  guidance snippet, the viewer's with the Reader's sentence and no snippet — and three claims that
  were assumed rather than asserted: the kind tint on a shown card of each kind (story 10), the
  sentence saying the top of the list draws over everything below it (story 13), and the foreign-kind
  note inside a Reader's open card (story 18).
- **`expectNothingEditable` sweeps prose as well as controls.** The empty-state regression was
  invisible to it because the two Add names are `<strong>` text in a `<p>` and `getByRole('button')`
  cannot see them, so it now also asserts that neither Add label, no mention of "this Workspace" and
  no "you can still rename" appears anywhere in the viewer's `textContent`. **It runs in two states**:
  in "reads everything through the HTTP store" with a drawable Layer's card open, and in "a Layer
  whose kind this build cannot draw is listed and says so" with the *foreign* Layer's card open —
  the only state in which that sentence exists at all, and the reason the first sweep could never
  have caught it.
- The editor's own foreign-kind wording has its positive control in `e2e/editor-layers.e2e.ts`'s "is
  listed, is reorderable, and is written back intact", which already opens that card: `packages/ui`
  may not import from `apps/` (ADR-0034), so the words cannot be asserted at Seam 3 and the viewer's
  absence needs somewhere real to be paired against.

**Mutation check, both halves in one run.** With `referencedImageIds` re-added to the viewer's prop
set, `pnpm test:e2e viewer-reader editor-layers -g "warns that a referenced Historical Map|shows the
Layer as a local copy"`:

- viewer, **red**: `layer-image-mode` `toHaveCount(0)` — expected 0, received 1;
- editor, **green** in the same run: "shows the Layer as a local copy" still finds the badge.

At Seam 3, adding `referencedImageIds` to `viewerProps()` turns "offers a Reader the same card with
none of them" red on the same element. Both mutations were reverted.

**The `localStorage` half of "a visit that only looks writes nothing" is asserted where the toggling
happens.** "Reads everything through the HTTP store" now compares the *whole* of `localStorage` after
a Reader has hidden a Layer, shown it again, dragged opacity, switched Base Map and switched theme,
and allows exactly one key: the Base Map preference, by value as well as by name. The Base Map specs
below it keep their `startsWith('ballastella.baseMap')` filter, which is right for what they claim and
blind to what this one claims. Mutation: a `localStorage.setItem` in the shared card's disclosure
handler turns it red with `+ "ballastella.layerOpen": "l-map"`; reverted.

**The foreign-kind sentence, both directions.** Dropping `{@render foreignLayerNote()}` turns the
editor half of "tells a Reader a Layer of a kind this build cannot draw is left alone" red; putting
the editing promise back into the shared paragraph turns the viewer half of it red on the "rename"
assertion *and* turns the browser sweep red with `“you can still rename” in the viewer`. Reverted,
after which the editor's positive control and the viewer's absence pass in one run.

## Coverage gaps

Two stories this ticket claims are delivered and are **not** asserted anywhere. Neither is worth its
price at Seam 2, which has no budget, and neither can be asserted honestly at Seam 3.

- **Story 68 — the stack's order comes from the markup.** Order is asserted only through MapLibre's
  own layer order; nothing asserts that the DOM sequence of `layer-row` follows the author's order.
  The `<ol>`/`<li>` structure is asserted, so "position comes from the markup" holds; "the markup's
  positions are the author's" does not. **Pre-existing — not introduced by this ticket.**
- **Story 70 — it holds up in both themes.** Nothing ties the Layer card to a theme in either app.
  The behaviour is delivered — the viewer's `layout.css` imports `@ballastella/ui/layout.css`, which
  defines `--layer-kind-ink-map`, `--layer-kind-ink-annotation` and `--layer-problem-ink` — but a
  proper assertion needs a theme sweep that does not exist and would cost Seam 2 budget there is none
  of.

## Blocked by

- 04 — the Layer card moves to the shared package

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
- [x] No rename, reorder, delete, drag handle or Add control appears anywhere in the viewer, at any
      width, and none is reachable by keyboard.
- [ ] ⚠ `data-image-mode` appears nowhere in the viewer's rendered output or built bundle. **The
      rendered half holds and is asserted; the built-bundle half cannot hold** — see the note below.
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
# Nothing a Reader cannot act on, and nothing a Reader could edit:
grep -rl "data-image-mode\|layer-rename\|layer-move-up\|layer-delete" apps/viewer/build/_app/ || echo "clean"
```

Success: everything exits 0 and the grep prints `clean`. `editor-publish` is in the list because the
editor stages and publishes the viewer's build, so a viewer change can break a publish assertion.

**Mutation check:** re-add `referencedImageIds` to the viewer's prop set and show the "no badge in
the viewer" assertion goes red. Pair it with the editor's positive control from ticket 04 — the badge
must still be asserted **present** in the editor by the same run.

## ⚠ One acceptance command cannot pass as written, and it is not an implementation choice

```bash
grep -rl "data-image-mode\|layer-rename\|layer-move-up\|layer-delete" apps/viewer/build/_app/
```

This prints `apps/viewer/build/_app/immutable/nodes/2.*.js` — one hit for each of the four strings —
and no implementation that satisfies this ticket's Contract can make it print `clean`.

**Why.** The Contract, ADR-0034 and ticket 04 together say the two apps render *one* component and
the viewer subtracts by passing fewer callbacks. Those callbacks are read at **runtime**, so
`{#if onmove}` and `{#if referencedImageIds}` are branches in the compiled module rather than
build-time conditions. Compiling `LayerList.svelte` into the viewer therefore brings every
`data-testid` in it, including the four the grep names. A bundler cannot remove them: whether the
viewer passes `onmove` is not knowable from the module graph, which is the whole point of the design
— and it is the same property that makes `readOnly` unnecessary.

**What is actually true, and is asserted:**

- Nothing carrying `data-image-mode` is in the viewer's **rendered DOM**:
  `e2e/viewer-reader.e2e.ts`'s "warns that a referenced Historical Map…" opens the Historical Map's
  card and asserts `[data-image-mode]` has count 0 across the page. Its mutation check is recorded
  below.
- None of the four controls exists in the viewer's DOM at desktop or phone width:
  `expectNothingEditable` in the same spec, run with a card **open**, since all four live inside the
  open card in the editor and a closed-card sweep would be vacuous.

**What would make the grep pass, and why it was not done.** Only moving the editing markup out of
`LayerList` into snippets the editor supplies — a change to the editor's call site, which this
ticket puts out of scope, and a reversal of ticket 04's Contract, which fixes `referencedImageIds`
and the write callbacks as optional *props*. That is a decision for the epic rather than for this
ticket, so it was left alone rather than improvised. **The criterion above wants rewording to name
the rendered output** (where the claim is real and enforced) or the epic wants a different seam.

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

## Completion note

- The stack is `@ballastella/ui`'s `LayerList`. The viewer passes `layers`, `outcomes`,
  `openLayerId`, `onopen`, `onshow`, `ondragopacity` and a `mapContents` snippet, and nothing else.
- **`Read as a document` is the `mapContents` snippet**, not a new prop. That slot is already the
  card's designated "what is inside a Historical Map Layer", it is optional, and the editor cannot
  see it — so nothing in the shared package changed at all for this ticket.
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
  and the card still a card.

**Mutation check, both halves in one run.** With `referencedImageIds` re-added to the viewer's prop
set, `pnpm test:e2e viewer-reader editor-layers -g "warns that a referenced Historical Map|shows the
Layer as a local copy"`:

- viewer, **red**: `layer-image-mode` `toHaveCount(0)` — expected 0, received 1;
- editor, **green** in the same run: "shows the Layer as a local copy" still finds the badge.

At Seam 3, adding `referencedImageIds` to `viewerProps()` turns "offers a Reader the same card with
none of them" red on the same element. Both mutations were reverted.

## Blocked by

- 04 — the Layer card moves to the shared package

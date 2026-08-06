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

- [x] Clicking the Historical Map then the Base Map creates one numbered pair
- [x] The pending half is visible and labelled, and Escape cancels it leaving no trace in UI state or on disk
- [x] Dragging either half moves the pair, and produces **exactly one** store write, on pointer-up
- [x] Selecting either half visibly highlights its partner in the other pane
- [x] Deleting removes both halves
- [x] Ordinals are visible and remain stable across reload
- [x] With a pending half present, autosave writes a valid Georeference Annotation **excluding** the incomplete pair, and does not throw
- [x] With 3 or more pairs, the Historical Map renders warped on the Base Map — asserted by tiles arriving **and decoding**, not by an absence of console errors; needs the `@allmaps/render` patch, see note 1
- [x] `alignments/<image-id>.json` is a valid Georeference Annotation, parseable by `@allmaps/annotation`
- [x] Committed fixture Alignments round-trip through serialise → deserialise with identical Control Points and Resource Mask
- [~] The written transformation type is `polynomial1` — never `straight`, never `polynomial` — **`straight` and the bare alias are both excluded and the type reads back as `polynomial1`, but the literal string cannot be written: `@allmaps/annotation` silently drops it**; see note 2
- [x] Reloading restores all pairs, their ordinals, and the warped render
- [x] Every pairing action is achievable by keyboard, and the pending state is announced to assistive technology

```bash
pnpm --filter @ballastella/core test    # serialisation, fixture round-trips, half-pair skipping
pnpm test:e2e                    # pairing, Escape, drag-commit-count, cross-pane highlight, reload
pnpm -r build && pnpm lint && pnpm check
```

Success: all exit 0. The drag test must assert the **number** of store writes, not merely that a write happened — a per-pointer-move implementation passes a "did it save" test and fails this one.

## Blocked by

- Ticket 04
- Ticket 06

## Comments

### Implementation, 2026-08-06

**Twelve of thirteen criteria are met and green. One is `[~]`, and it is not missing work** — it is
an encoding that ADR-0013 asks for and `@allmaps/annotation` cannot express; see note 2. Results:

```
pnpm --filter @ballastella/core test    24 files, 543 tests passed
CI=1 pnpm test:e2e                      104 passed, no flakes
pnpm -r build && pnpm lint && pnpm check    all exit 0
```

Pairing, numbered ordinals, cross-pane highlight, drag-commits-once, deletion, Escape, keyboard
operation, persistence as a IIIF Georeference Annotation, the `@allmaps/*` fixture round-trips, and
**warped rendering** are all done and asserted.

### Note 1 — warped rendering works, and it rests on the local patch

This slice was started under the tracker's open question 5, with warped rendering believed blocked.
It is not blocked: `patches/@allmaps__render@1.0.0-beta.83.patch` landed on `main` mid-ticket and was
merged in. Both criteria that depended on it are now `[x]` with real assertions.

**Asserted by tiles arriving and decoding, never by an absence of console errors.** That distinction
is the whole lesson of the defect: `@allmaps/render` logged the tile failure and swallowed it, so a
suite that checked the console went green while the map rendered blank. The signal used instead is
`renderer.tileCache.getCachedTiles()` — `CacheableTile.isCachedTile()` is `data !== undefined`, and
`data` is the ImageData the tile worker produced, so a cached tile is one that came all the way
through the ADR-0011 shim. Three tests turn on it: the third pair making the map appear
(`editor-alignment.e2e.ts`), the render surviving a reload, and the injection point itself
(`editor-warped-fetch.e2e.ts`).

**A defect of mine that this found.** Dropping back below the minimum Control Point count removed the
layer but left the page still saying "drawn from 3 Control Points" — a claim about a Historical Map
placed by points the user had just deleted. `BaseMapPane` now reports `onwarped(null)` when it stops
drawing, rather than leaving the page to infer a lifecycle it cannot see.

**I verified the defect independently before the patch existed**, three ways, because the instruction
was not to take ticket 06's finding on faith: statically in
`dist/tilecache/CacheableWorkerImageDataTile.js`, through ticket 06's own Chromium assertion, and
through the real pairing UI. All three agreed with ticket 06. That work is not wasted — see note 5,
which corroborates why the patch takes the shape it does.

### Note 2 — `polynomial1` cannot be written literally, and writing it destroys the field

Found by writing the fixture round-trip, which is exactly what it is for. Measured both directions
against the pinned `@allmaps/annotation@1.0.0-beta.37`:

- Its `transformation` is validated by a Zod enum of
  `helmert | polynomial | thinPlateSpline | projective | straight | linear`. **`polynomial1` is not
  a member.** The schema is `parseIfValid(ValidTransformationSchema).or(…)`, and `parseIfValid` wraps
  `z.unknown().transform(…)`, which *always succeeds* — returning `undefined` when the inner parse
  failed. So the `.or(…)` branch, which does know how to read `polynomial1`, is unreachable dead code.
- Therefore `generateAnnotation({ …, transformation: { type: 'polynomial1' } })` writes **no
  transformation at all**, and `parseAnnotation` of a hand-built file containing `polynomial1`
  returns `transformation: undefined`. Verified in both directions and pinned by a test that fails
  when upstream fixes it.

**ADR-0013's literal wording cannot be satisfied.** What is written instead is
`{ type: 'polynomial', options: { order: 1 } }`, produced by `transformationTypeToTypeAndOrder` —
the upstream helper ADR-0013 itself names — which round-trips unchanged and comes back as exactly
`polynomial1` through the inverse. `straight` is unreachable from our `TransformationType` union, and
the order is explicit so nothing is left to be inferred, which is the ambiguity the ADR is written
against. **A human should decide whether ADR-0013's sentence "always store the explicit
`polynomial1`" should be reworded**; it is the only reason this criterion is `[~]` rather than `[x]`,
and the substance of it is met.

### Note 3 — a second upstream defect, in the Resource Mask, fixed here

The Resource Mask is the one part of the document that does **not** travel as JSON numbers:
`generateAnnotation` stringifies it into an SVG `polygon points` attribute, and `Annotation1Schema`
validates that attribute against a regex whose number pattern is `-?\d+(\.\d+)?` — **plain decimal
only**. `Number#toString` switches to exponential below 1e-6, so a mask vertex at, say, 1.5e-7 image
pixels is written happily and then makes the **entire** Alignment unreadable on the next open, taking
the Control Points with it.

Nothing in this slice can reach that state — the mask is the full image rectangle and its vertices
are integers. It is fixed anyway, in ~15 lines, because the failure is silent, arrives on *reopening*
rather than on saving, costs the user everything rather than the one vertex that provoked it, and
**ticket 08 makes the mask editable**. No precision is given up: the notation changes, not the value.
The `awkward-coordinates` fixture's first vertex is exactly this case and is asserted to round-trip
to the bit.

### Note 4 — what the `@allmaps/*` fixture round-trip actually asserts

This is one of the epic's four named risk items, so being precise about it. Three committed fixtures
in `packages/core/src/alignment/fixtures/`, **prettier-ignored, because the bytes are the assertion**:

| Fixture | What it is for |
|---|---|
| `floride-1657.json` | A realistic 6-point Alignment over the committed fixture pyramid, 1200 × 851 |
| `awkward-coordinates.json` | Precision: full float64 significance, both signs, sub-pixel resource coordinates, a 6-vertex non-convex mask, and the sub-1e-6 vertex from note 3 |
| `allmaps-shaped.json` | A document in the shape Allmaps' own editor emits — `id`, `created`, `modified`, `partOf`, `provider`, `_allmaps`, and a polygon that repeats its closing vertex (SPEC story 91) |

They are **frozen documents read off disk**, not objects built and immediately taken apart. A test
that serialised its own output would keep passing through any upstream change that was merely
self-consistent; these bytes cannot move, so a parser that starts reading them differently fails.
What is asserted, per fixture: exact equality of Control Points and Resource Mask across
serialise → deserialise; **byte-identity** of re-serialisation against the committed file;
`validateAnnotation` acceptance by upstream's own validator; and idempotence over five round-trips,
because drift that only shows on the third save is the usual shape of this bug.

**Measured agreement.** The file's own contribution to coordinate error is **exactly zero** — every
value travels as a JSON number or a plain-decimal string, both lossless for a float64, so there is no
error budget to spend and any inexactness at all is a defect. Asserted as `toBe(0)`, not as a
tolerance. The composite pane → file → pane loop, which is where ADR-0005's drift failure lives:

| Pyramid | file only | pane → file → pane | ticket 06 recorded |
|---|---|---|---|
| 700 × 500, scale factors 1–4 | 0 | 2.323e-10 px | 2.32e-10 px |
| 60000 × 24000, scale factors 1–256 | 0 | 1.488e-8 px | 1.49e-8 px |

Against `ROUND_TRIP_TOLERANCE_PX` = 1e-6, sampled off the binary grid. **This slice spent none of the
headroom**, and reproduces ticket 06's figures to three significant figures. No tolerance was touched.

### Note 5 — the patch assessment I was asked for, which corroborates the applied patch

Before the patch landed I was asked to assess whether a `pnpm patch` would work and what it would
cost, as a recommendation rather than as applied work. **Verified empirically in a scratch directory
outside the repository, nothing committed**: I reproduced upstream's worker verbatim from
`dist/workers/fetch-and-get-image-data.js` and `@allmaps/stdlib`'s `fetchUrl`, drove it in headless
Chromium over a local server, and passed it a main-thread `fetchFn` of exactly ADR-0011's shape.

| What was tried | Result |
|---|---|
| Unpatched, `fetchFn` raw — beta.83 as shipped | `DataCloneError: … async (input, init) => {…} could not be cloned` |
| **The obvious one-line fix, `proxy(this.fetchFn)`** | **`DataCloneError: … AbortSignal object could not be cloned`** |
| Same, with no `AbortSignal` in `init` | `TypeError: Unserializable return value` — a `Response` is not cloneable either |
| Proxied `fetchFn`, no signal, shim returning `Comlink.proxy(response)` | Works: `blob()` → 99 bytes, `createImageBitmap` → 8×8 |
| Fetch **and** decode on the main thread, bypassing the worker | Works: `ImageData` 8×8, 256 bytes |

**This independently reaches the same conclusion the applied patch is built on, and the two accounts
agree.** Two things are worth keeping on the record.

The tracker's characterisation "the fix is one line upstream" (open question 5, and ticket 06's
option 1) **was wrong**, and measurably so. Proxying `fetchFn` only moves the `DataCloneError` from
the function to the `AbortSignal` that upstream's own worker puts into `init` — and nothing outside
`@allmaps/render` can stop that signal crossing the boundary. Ticket 19 should carry the table above
rather than the one-line framing, or the upstream conversation starts from a premise that does not
hold.

And a detail the last-but-one row exposes, which matters if anyone ever revisits the proxy route:
through a Comlink proxy `typeof response.ok === 'function'`, so `!response.ok` is always false and
upstream's `fetchUrl` error handling silently never fires. The applied patch avoids this entirely by
keeping the `Response` on the main thread and handing the worker a `blob:` URL — which is the last
row, plus the decode staying off the main thread. That is strictly better than the variant I measured
as working, and it is why I did not need to recommend anything.

On ADR-0010's exact-pinning rule, which I was asked about: the patch survives it, and
`scripts/check-allmaps-patch.mjs` is what makes that true rather than hopeful. Worth noting that
`@allmaps/render` is a **transitive** dependency — `@allmaps/maplibre@1.0.0-beta.43` asks for
`^1.0.0-beta.83` — so it is not in the catalog and is pinned only by the lockfile and by the patch
entry. Patching it means taking ownership of a package the manifests do not name, which is ticket 19's
problem to retire.

### Deviations and things worth knowing

- **`terra-draw` was not added, deliberately.** The ticket's tooling block names it and ADR-0005 says
  control points go through it, but two things point the other way and I judged them decisive.
  ADR-0022 says the pairing is ours because no drawing library has linked points across two maps — so
  terra-draw would carry none of the six behaviours. And the criterion "every pairing action is
  achievable by keyboard" is not reachable through it at all: terra-draw draws into WebGL layers,
  which are not focusable and have no keyboard story, so a DOM path would be needed anyway. Control
  Points therefore arrive through the pane's existing `overlayPoints` seam, as MapLibre `Marker`s
  carrying real `<button>` elements — focusable, named, `aria-pressed`, arrow-key movable.
  **This is the one deviation from the ticket's stated tooling and a reviewer should confirm it.**
  Nothing is foreclosed: terra-draw still has to arrive for annotations in ticket 10 and the Resource
  Mask in ticket 08, which are genuinely shape-drawing rather than linked points.
- **The `/warped` dev route is deleted**, as ticket 06 asked. `WarpedMapLayer` now lives in the Base
  Map pane, fed the Alignment once it can be solved, and `editor-warped-fetch.e2e.ts` drives the real
  pane through the real pairing UI instead of a hand-built georeferenced map.
- **The merge of `main`'s patch needed reconciling, not taking a side.** `main`'s edit to
  `editor-warped-fetch.e2e.ts` was made against ticket 06's dev-route structure — it referenced
  `added`, `imageId`, and `outcome` from a test body this branch had already replaced. Kept this
  branch's structure, which is what `main`'s own helpers were built on, and adopted `main`'s assertion
  (`getCachedTiles()`). `playwright.config.ts` was taken from `main` unchanged, including
  `workers: 4`.
- **`project.json` is untouched by this slice.** The Alignment is discovered by path convention at
  `alignments/<image-id>.json`, the same way `listIngestedImages` finds pyramids. `alignmentRef`
  belongs to the Layer union, which ticket 09 owns and this ticket lists as out of scope — so there
  was nothing to record, and recording it early would have been a write with nothing behind it.
  `EditorSession` remains the only writer of `project.json`, trivially.
- **Ordinals are derived from position in the file and never stored.** A Georeference Annotation has
  nowhere to put one, and inventing a place — a sidecar index, an `_allmaps` key — would be the
  proprietary index SPEC story 94 rules out. Consequence: deleting point 3 of 5 renumbers the two
  after it. Reload stability, which is what the criterion asks for, comes for free.
- **Placing the first half of a pair writes nothing at all.** So Escape leaves no file behind, not
  even an empty one — asserted directly, because an `alignments/<id>.json` with zero pairs would be a
  trace on disk and, in a Workspace kept in git or Dropbox, a change to sync.
- **One latent bug of ticket 03's was found and fixed.** The overlay layer assigned
  `element.className` wholesale, which wiped the `maplibregl-marker` class MapLibre puts on the
  element itself — costing it `position: absolute` and leaving points tens of pixels from where they
  were placed. Ticket 03 never hit it because it assigned once, before constructing the `Marker`.
  Caught by ticket 03's own browser tests, which is exactly what they are for.
- **`window.ballastellaAlignmentWrites` is a new browser-test handle**, on the same terms as
  `ballastellaServedTiles` and `ballastellaBaseMap`. It exists because the drag criterion is about a
  **count** and a write into OPFS issues no request, so there is nothing outside the page to count.
- **The Control Point list is a `<ul>`.** Several existing e2e tests count Historical Maps with a bare
  `getByRole('listitem')`, which is safe only because that list is absent when there are no Control
  Points. A future slice adding a third list on this page should expect to disambiguate.
- **A defect found by the new warped tests, and fixed:** dropping back below the minimum Control Point
  count removed the layer but left the page still claiming "drawn from 3 Control Points" — a statement
  about a Historical Map placed by points the user had just deleted. `BaseMapPane` now reports
  `onwarped(null)` when it stops drawing, instead of leaving the page to infer a lifecycle it cannot
  see.
- **`pnpm test:e2e` was run with `CI=1` on the committed ports 4173/4174**, verified free before each
  run; `playwright.config.ts` carries `main`'s values unmodified. **No flakes observed in any full
  run** — two clean runs of 102 before the merge, and 104 after it. One flake was mine and is fixed
  rather than absorbed: resetting the write counter raced the completed pair's own write, which failed
  as "a write happened mid-drag" — the most misleading form possible, since that is the defect the
  test exists to catch.

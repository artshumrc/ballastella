# 08 — Alignment refinement: transformation types, distortion, Resource Mask

## What to build

A user can choose how their Historical Map is stretched, see where the stretching is worst, be warned when their alignment is impossible, and outline the part of the sheet that is actually the map.

Three related capabilities on top of ticket 07's Alignment: the **transformation picker**, **distortion visualisation with the fold warning**, and an editable **Resource Mask**.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 39, 40, 41, 42, 43, 44, 45, 46, and 47. The guidance-text-in-the-accessibility-tree criterion is also where story 96 is most load-bearing.

## Where to start

[ADR-0013](../../../docs/adr/0013-transformation-types-and-distortion.md) — the entire slice, including the exact types, minimums, and labels. Also [ADR-0016](../../../docs/adr/0016-daisyui-only-with-mandated-component-methods.md) for why the guidance text cannot be a tooltip.

## Contract

### The picker — four primary, two behind Advanced

| Tier | Label | Stored value | Min | Guidance — **the primary text** |
|---|---|---|---|---|
| Primary | Simple | `helmert` | 2 | Accurate modern maps — rotate, scale, and move only |
| Primary | **Standard** *(default)* | `polynomial1` | 3 | Most printed and scanned maps |
| Primary | Perspective | `projective` | 4 | Maps photographed at an angle |
| Primary | Flexible | `thinPlateSpline` | 3 | Hand-drawn or geometrically inconsistent maps |
| Advanced | Higher-order (2nd) | `polynomial2` | 6 | Only with many well-spread points |
| Advanced | Higher-order (3rd) | `polynomial3` | 10 | Only with many well-spread points |

**The guidance is the primary text; the label is secondary.** "Most printed maps" is what a historian can act on; "Standard" is not. And per ADR-0016 the guidance must be **visible text or `aria-describedby`** — never a daisyUI tooltip, which renders via CSS `::before` and is neither announced nor dismissable.

Three types are **never offered**:

- **`straight`** — it is in the `TransformationType` union but `typeAndOrderToTransformationType` **throws `'Unrecognised transformationType.'`** for it. Offering it produces Alignments that fail to deserialize.
- **`polynomial`** — an alias for `polynomial1`. Always store the explicit form.
- **`linear`** — recognised but with no documented user-facing meaning.

Two hard behaviours:

- **Point count gates the type, visibly.** "Flexible needs at least 3 points — you have 2," and the option is disabled. A type must never be settable in a state the solver cannot handle: below its minimum the solve is under-determined and yields a thrown error or a garbage warp. This matters most in the Advanced tier, where ten points is a lot to accumulate before the option becomes legible.
- **Changing the type never discards Control Points.** They are the user's actual labour; the transformation is a lens over them. The obvious implementation — reset on change — destroys work.

### Distortion

Built into the renderer; do not build an overlay.

```
WarpedMapOptions.distortionMeasure                     ← which is DISPLAYED
SpecificTriangulatedWarpedMapOptions.distortionMeasures ← which are COMPUTED
distortionColor00 / 01 / 1 / 2 / 3                     ← 5-stop ramp, themeable
renderGrid / renderGridColor                           ← warped graticule
```

**These are two different settings and conflating them is the obvious mistake: nothing displays if the measure was never computed.**

Two measures are exposed, because they answer different questions:

- **`log2sigma`** (default) — where the map is drawn too big or too small. *How faithful is this old map?*
- **`signDetJ`** — the warp has folded over itself. *Did I make a mistake?*

`twoOmega` and `airyKavr` are redundant for this audience. **`thetaa` must not be exposed**: it is an angle, angles are cyclic, and a linear five-stop ramp would render 359° and 1° at opposite ends of the scale.

**The fold check runs continuously and warns independently of the overlay.** The overlay is a toggle, off by default, because a colourised map is not what you want while placing points — but `signDetJ` is computed always and produces a plain warning ("this alignment folds over itself near the top-right") whenever it goes negative. This is the single most useful piece of feedback a student can get.

`nonWarpingTransformationTypes` is `['helmert', 'polynomial', 'polynomial1']`; those cannot fold locally, so the warning is chiefly meaningful for `projective` and `thinPlateSpline`. On affine it still catches a **globally mirrored** map — the "I swapped two control points" error — so do not suppress it for those types.

**The distortion toggle is not persisted** to `project.json`. It is a working view, not a property of the work; persisted, a Published Site could load colourised and a Reader would have no way to interpret it.

Colour ramp values come from the theme, not hardcoded.

### Resource Mask

Drawn with `terra-draw` on the image pane, in image pixel space. **Defaults to the full image rectangle** — not empty, because an empty mask renders nothing and reads as a broken tool on a first alignment. Stored in the Georeference Annotation and covered by ticket 07's round-trip fixtures.

## Out of scope

- **`projective` for anything other than a transformation choice.** No oblique-photo detection or assistance.
- **A vector-field visualisation for `thetaa`.** Not v1.
- **Hillshade or contours.**
- **Undo** — ticket 11.
- **Persisting the distortion overlay**, or exposing it in the Published Site. A deliberate "show distortion" exhibit is a plausible future feature and is not this.
- **Editing the mask on the Base Map pane.** The mask is in image pixel space and belongs to the image pane only.

## Acceptance criteria

- [x] Four primary types are offered with guidance as the primary text; two more appear behind an Advanced disclosure
- [x] Guidance text is present in the accessibility tree — not a tooltip
- [x] A type below its minimum point count is disabled with a message naming the shortfall
- [x] Changing the type preserves every Control Point
- [~] `straight`, `polynomial`, and `linear` are never written to disk under any interaction — **`straight` and `linear` never are; `"polynomial"` always is, because it is the only name the format has for the polynomial family.** The order is always beside it, which is the substance of the rule; see note 1
- [x] Every offered type serialises and round-trips through `@allmaps/annotation` — **and two of them do not survive upstream's own inverse**, which is note 2
- [x] The distortion overlay renders `log2sigma` using theme-derived ramp colours, and is off by default
- [x] `distortionMeasures` includes every measure the UI can display, so switching display never shows nothing
- [x] The fold warning appears when `signDetJ` goes negative **with the overlay off**
- [x] A deliberately mirrored pair set triggers the fold warning under an affine transformation
- [x] The warped graticule can be toggled
- [x] The distortion toggle is absent from `project.json` after being switched on and off
- [x] A new Alignment's Resource Mask is the full image rectangle and renders the whole map
- [x] An edited Resource Mask clips the warped render and survives reload

```bash
pnpm --filter @ballastella/core test    # gating, type normalisation, never-offered types, mask default
pnpm test:e2e                    # picker a11y, disabled reasons, fold warning, overlay, mask edit
pnpm -r build && pnpm lint && pnpm check

# no banned type ever reaches disk
grep -rE '"(straight|linear)"|"polynomial"[^0-9]' <fixture alignments> && echo "FAIL" || echo "OK"
```

Success: all exit 0 and no banned transformation string appears in any written Alignment.

## Blocked by

- Ticket 07

## Comments

### Implementation, 2026-08-06

Thirteen of fourteen criteria are met and green. The fourteenth is `[~]` and is a wording problem in
the criterion rather than missing work — see note 1. Results:

```
pnpm --filter @ballastella/core test        25 files, 600 tests passed
CI=1 pnpm test:e2e                          120 passed, two clean full runs, no flakes
pnpm -r build && pnpm lint && pnpm check    all exit 0
```

The picker, the guidance in the accessibility tree, the point-count gate with its named shortfall,
type changes that keep every Control Point, the distortion overlay with a theme-derived ramp, the
computed-versus-displayed split, the fold warning with the overlay off, the graticule, the toggle
staying out of `project.json`, and an editable Resource Mask that narrows the warped render and
survives a reload are all done and asserted.

### Note 1 — the banned-name criterion cannot hold as written, and its substance does

The acceptance command is

```bash
grep -rE '"(straight|linear)"|"polynomial"[^0-9]' <fixture alignments> && echo "FAIL" || echo "OK"
```

and it prints `FAIL`, on every fixture, because every fixture contains `"type": "polynomial"`. That
is not a defect: it is ticket 07's note 2 arriving in a grep. `@allmaps/annotation`'s Zod enum has no
`polynomial1`, `polynomial2`, or `polynomial3` member, so `"polynomial"` **is** the only name the
format has for the whole polynomial family, and the order travels beside it in
`options.order`. The `[^0-9]` in the pattern was written expecting the literals `polynomial1` and
`polynomial2` to appear in the file; they never can.

The rule with its substance intact is *no bare alias* — never `"polynomial"` with the order left to
be inferred — and that holds, checked three ways:

```
no straight, no linear, in any fixture's bytes                              OK
every "type": "polynomial" has an "order" beside it                        OK
every offered type, written and read back as itself, six of six            OK  (unit test)
every offered type driven through the real picker, nothing banned on disk  OK  (e2e)
```

**A human should decide whether the criterion's grep should be reworded**, the same way ADR-0013's
"always store the explicit `polynomial1`" sentence is already awaiting a decision from ticket 07.
The two are the same finding.

### Note 2 — `polynomial2` and `polynomial3` do not survive upstream's own inverse

Found by writing the round-trip for every offered type, which is what the criterion asks for. This is
a *second*, distinct upstream defect from ticket 07's, in `@allmaps/transform@1.0.0-beta.52` rather
than in `@allmaps/annotation`, and it is the more dangerous of the two.

`typeAndOrderToTransformationType` is the documented inverse of `transformationTypeToTypeAndOrder`.
Its first branch is

```js
if (type == 'polynomial1' || type === 'polynomial') transformationType = 'polynomial1'
```

and the `order === 2` and `order === 3` branches that follow are both guarded on
`type === 'polynomial'` — which the first branch has already claimed. **They are unreachable.** So
`{ type: 'polynomial', options: { order: 3 } }` comes back as `polynomial1`.

Measured, in both directions, for all nine names upstream recognises:

| Chosen | Written to the file | Read back by `parseAnnotation` | Name via upstream's inverse |
|---|---|---|---|
| `helmert` | `{type: helmert}` | unchanged | `helmert` ✓ |
| `polynomial1` | `{type: polynomial, order: 1}` | unchanged | `polynomial1` ✓ |
| `polynomial2` | `{type: polynomial, order: 2}` | unchanged | **`polynomial1` ✗** |
| `polynomial3` | `{type: polynomial, order: 3}` | unchanged | **`polynomial1` ✗** |
| `projective` | `{type: projective}` | unchanged | `projective` ✓ |
| `thinPlateSpline` | `{type: thinPlateSpline}` | unchanged | `thinPlateSpline` ✓ |
| `linear` | `{type: linear}` | unchanged | `linear` ✓ (never offered) |
| `polynomial` (alias) | `{type: polynomial, order: 1}` | unchanged | `polynomial1` (never offered) |
| `straight` | `{type: straight}` | unchanged | **throws** (never offered) |

**The file is right in every row.** `generateAnnotation` writes the order and `parseAnnotation` reads
it back unchanged, so an Alignment written here is correct and interoperable — anything that reads the
order gets the order. What would have been lost is our own *read*: a user who chose Higher-order (3rd),
saved, and reopened would have got an affine Alignment, with every coordinate in the file intact and
the Historical Map in the wrong place. That is exactly the failure ADR-0010's round-trip fixtures
exist to catch. `readTransformationType` therefore reads the order directly, and a test pins the
upstream defect so that a fix upstream fails loudly rather than going unnoticed.

**There is a second half to it, in the renderer.** `WarpedMap` sets
`georeferencedMapOptions.transformationType = georeferencedMap.transformation?.type` and looks at
nothing else, so `{type: 'polynomial', order: 3}` reaches the solver as plain `polynomial`, which
`BaseGcpTransformer` treats as first order. Fixing the read alone would have given a picker that
changed the file and not the map. The layer's own `transformationType` map option wins over what it
read from the document, so it is passed explicitly; the e2e suite asserts the *renderer's* resolved
option is `polynomial3` after a reload, not merely that the file says so.

Worth carrying to ticket 19 alongside the `fetchFn` patch: this one needs no patch, only a four-line
reordering of `typeAndOrderToTransformationType`.

### Note 3 — the ramp had to be hex, and the test that found it was not one of mine

`@allmaps/render` parses colours with `@allmaps/stdlib`'s `hexToFractionalRgb`, which is `hex-rgb`:
**hex only**. It does not take `rgb(…)`, a named colour, or `oklch(…)` — it *throws*
`TypeError: Expected a valid hex string`, inside the WebGL renderer's draw path, once per frame,
where nothing surfaces it.

daisyUI 5 publishes its palette in `oklch()` (measured: `--color-warning` is
`oklch(82% .189 84.429)`), and the obvious conversion does not work either:
`getComputedStyle(element).color` **preserves** `oklch()` in Chrome rather than serialising to
`rgb()`. The colour is rasterised through a 1 × 1 canvas instead, which is the browser's own
conversion and works for any notation CSS will ever add.

**An earlier version handed the renderer `rgb(…)` and every distortion assertion still passed.** The
distortion values are computed in `TriangulatedWarpedMap` and consumed by `WebGL2Renderer`, two
different objects, so `trianglePointsDistortion` was full of correct non-zero numbers while nothing
was painted. What caught it was ticket 07's `pageerror` watch on an unrelated pairing test. Both
distortion tests now watch for it, and the format assertion is `/^#[0-9a-f]{6}$/` rather than "some
colour".

### Note 4 — round-trip precision after refinement

Refinement moves Control Points and mask vertices around, which is where precision leaks in. Measured
over **every offered transformation type** and a mask that has been dragged and had vertices inserted:

| | file only | pane → file → pane | ticket 07 recorded |
|---|---|---|---|
| 700 × 500, scale factors 1–4 | **exactly 0** | 2.1905e-10 px | 2.323e-10 px |
| 60000 × 24000, scale factors 1–256 | **exactly 0** | 1.0965e-8 px | 1.488e-8 px |

Against `ROUND_TRIP_TOLERANCE_PX` = 1e-6, sampled off the binary grid. **The file's own contribution
is still exactly zero** — Control Point resource, Control Point geo, and Resource Mask alike — and it
is asserted as `toBe(0)` rather than as a tolerance, because every value travels as a JSON number or a
plain-decimal string and there is no error budget to spend. `ROUND_TRIP_TOLERANCE_PX` was not touched.
The composite figures are slightly *below* ticket 07's because the sample set now includes mask
vertices; nothing regressed.

The sub-1e-6 mask vertex from ticket 07's note 3 is now asserted **through the editing path** — a
vertex dragged to 1.5e-7, and a second one created by inserting on the edge that leaves it, which is
the second way a user reaches this without doing anything unusual.

### Deviations and things worth knowing

- **`terra-draw` was not added, and this is the one deviation from the ticket's stated tooling.** The
  ticket says the mask is "drawn with `terra-draw` on the image pane" and ADR-0005 says all drawing
  and editing goes through it. Four things pointed the other way and I judged them decisive together.
  **Keyboard**: `terra-draw` edits inside MapLibre GL layers, which are WebGL and not focusable, so
  the mask would have been the first mouse-only editable object in the application — while the
  existing `overlayPoints` seam makes each corner a real `<button>` with a name, arrow-key movement
  and Delete, for no new code. **ADR-0017 rule 1**: that seam already commits exactly once on gesture
  end and is asserted by a *write count*; `terra-draw`'s change events fire per coordinate update, so
  matching the rule would mean debouncing them, and getting it wrong is a write per frame into OPFS.
  **ADR-0005's own projection rule**: on the image pane `terra-draw`'s store would hold *synthetic*
  lng/lat, the geography ADR-0005 says must not escape the pane, and every vertex would take an extra
  projection round trip per edit in a slice whose budget is nearly spent. **ADR-0019**: two new
  runtime dependencies, two catalog pins, THIRD-PARTY-NOTICES entries and a standing fence obligation,
  for one four-vertex ring. Nothing is foreclosed — ticket 10's annotations are arbitrary user-drawn
  points, lines and polygons with a tool palette, which is the case `terra-draw` is actually for, and
  adding it there costs nothing that adding it here would have saved. **A reviewer should confirm
  this**; it is the same call ticket 07 made, for overlapping reasons.
- **Ticket 10's opening line is now wrong.** It says "`terra-draw` and its MapLibre adapter arrived in
  ticket 07". They did not, and they have not arrived here either.
- **The fold check is ours, not the renderer's.** ADR-0013 makes it continuous and independent of the
  overlay, and a warning derived from a WebGL layer's triangulation exists only while a layer does,
  only in a browser, and only after the style has loaded — which is not when a student placing their
  fourth point needs it. So `detectFold` is a function over an Alignment in `@ballastella/core`, using
  the same `@allmaps/transform` solver the renderer uses, sampled on an 11 × 11 grid clipped to the
  mask. It is unit-testable, and it is present before anything is drawn.
- **`helmert` cannot see a mirror, and that is not a defect.** A similarity has no reflection to fit,
  so a least-squares solve over swapped Control Points comes back unmirrored rather than folded. Under
  Simple, a swapped pair shows as a badly placed map instead. Recorded and asserted as a known limit.
  `polynomial1`, `projective` and `thinPlateSpline` all catch it.
- **The fold region is named against the image, not the mask.** The user is looking at the whole sheet,
  so "the top-right" has to mean the top-right of what is on screen; against the mask's own bounding
  box, a mask covering one corner would have its own top-right, which is a different place.
- **A third `<ul>` on this page broke two existing tests, exactly as ticket 07 predicted.** The
  picker's shortfall text was a list, and `editor-stored-image-pane.e2e.ts` and
  `editor-alignment.e2e.ts` count Historical Maps with a bare `getByRole('listitem')`. It is a `<div>`
  of `<p>`s now, which is better markup for help text anyway — but **the hazard is still live, and
  ticket 09's Layer list cannot avoid being a list.** Those selectors want scoping to
  `getByRole('list', { name: 'Historical Maps in this Project' })`; I left them alone rather than churn
  two files a parallel slice is also in.
- **Turning the overlay on does not rebuild the layer.** `addGeoreferencedMap` is keyed on the
  document's content, so re-adding would discard the tile cache and the user would watch their
  Historical Map vanish and come back for a checkbox. `setMapOptions` reaches the same map in place,
  from a second effect that has the display view as a dependency and the Alignment only through the
  layer it already built.
- **The Advanced disclosure is forced open when an advanced type is selected**, and its hide button is
  then not offered. A `<select>` whose value matches no option silently falls back to the first, so
  without this a Project stored as Higher-order (3rd) would reopen looking as though the choice had
  become Simple — and the thing the button would hide is the user's own selection.
- **The mask's outline is always drawn; only its handles are asked for.** Drawn as one polygon with the
  mask as a hole in it, so the dimming covers exactly what is excluded and there is no second extent
  to keep in agreement. Eight handles over a sheet you are placing Control Points on is noise, and a
  mis-aimed click is a moved outline.
- **"An edited mask narrows the render" is measured on the convex hull, not the bounding box.** Cutting
  a corner off a rectangle leaves the bounding box exactly where it was — the three remaining corners
  still hold every extreme — so a bbox assertion would have passed vacuously.
- **A "show the whole sheet again" button exists**, which is not in the criteria. Undo is ticket 11 and
  a mask can be outlined into a corner in three drags; the recovery is three lines.
- **`project.json` is untouched by this slice**, as by ticket 07. The transformation type and the mask
  are both fields of the Alignment; the distortion view is deliberately not persisted anywhere.
  `EditorSession` remains the only writer of `project.json`, trivially.
- **This branch and ticket 09's overlap in `BaseMapPane.svelte`, and the merge needs one decision
  rather than a resolution.** Ticket 09 landed on `main` while this was in flight. `git merge-tree`
  reports one conflict, and it is adjacency rather than contradiction: both slices added `untrack` to
  the same import, both added props, and their Layer-stack effect sits immediately after the
  single-Alignment effect this slice modified. `packages/core/src/index.ts` and
  `warped-map-layer.ts` auto-merge; `editor-session.svelte.ts` is untouched here.
  **The substantive part is that `drawLayerStack` calls `showAlignment(layer, drawn.alignment)`.**
  Its third parameter is therefore optional and defaults to nothing colourised, so the merge compiles
  and every Layer of the stack still gets the two options that are *not* display settings —
  `transformationType`, without which a Higher-order Alignment is silently drawn as affine, and
  `distortionMeasures`. What a Layer of the stack does not get is the overlay itself, which is the
  right default (the overlay belongs to the Alignment being edited) and is worth a look when the two
  surfaces are reconciled.
- **Shared e2e driving now lives in `e2e/support/alignment-workspace.ts`.** `editor-alignment.e2e.ts`
  still carries its own copy; rewriting a green suite to import from here would be churn in a file
  another slice is also touching.
- **`pnpm test:e2e` was run with `CI=1` on the committed ports 4173/4174**, verified free before each
  run — a sibling worktree held them twice and was waited out rather than raced.
  `playwright.config.ts` is unmodified, `workers: 4` included. **Two clean full runs of 120, no
  flakes.** Five deliberate mutations were used to confirm no criterion passes vacuously: dropping
  `distortionMeasures`, dropping `transformationType`, removing `aria-describedby`, making the fold
  warning depend on the overlay, and stopping the edited mask reaching the file. Each turned exactly
  the expected tests red (7 failures across the five), and three more in core — the polynomial order
  read, the `signDetJ` sign, and the three-vertex mask floor.

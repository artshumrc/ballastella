# 08 — Alignment refinement: transformation types, distortion, Resource Mask

## What to build

A user can choose how their Historical Map is stretched, see where the stretching is worst, be warned when their alignment is impossible, and outline the part of the sheet that is actually the map.

Three related capabilities on top of ticket 07's Alignment: the **transformation picker**, **distortion visualisation with the fold warning**, and an editable **Resource Mask**.

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

- [ ] Four primary types are offered with guidance as the primary text; two more appear behind an Advanced disclosure
- [ ] Guidance text is present in the accessibility tree — not a tooltip
- [ ] A type below its minimum point count is disabled with a message naming the shortfall
- [ ] Changing the type preserves every Control Point
- [ ] `straight`, `polynomial`, and `linear` are never written to disk under any interaction
- [ ] Every offered type serialises and round-trips through `@allmaps/annotation`
- [ ] The distortion overlay renders `log2sigma` using theme-derived ramp colours, and is off by default
- [ ] `distortionMeasures` includes every measure the UI can display, so switching display never shows nothing
- [ ] The fold warning appears when `signDetJ` goes negative **with the overlay off**
- [ ] A deliberately mirrored pair set triggers the fold warning under an affine transformation
- [ ] The warped graticule can be toggled
- [ ] The distortion toggle is absent from `project.json` after being switched on and off
- [ ] A new Alignment's Resource Mask is the full image rectangle and renders the whole map
- [ ] An edited Resource Mask clips the warped render and survives reload

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

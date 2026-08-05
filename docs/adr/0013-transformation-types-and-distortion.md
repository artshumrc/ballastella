# Transformation types: four primary, two behind Advanced, with distortion visualisation in v1

`@allmaps/transform` exposes nine transformation types — `straight`, `helmert`, `polynomial`, `polynomial1`, `polynomial2`, `polynomial3`, `thinPlateSpline`, `projective`, `linear` — each with a different minimum control-point count. Six are exposed, in two tiers.

| Tier | Label | Stored value | Min | Guidance (the primary text) |
|---|---|---|---|---|
| Primary | Simple | `helmert` | 2 | Accurate modern maps — rotate, scale, and move only |
| Primary | **Standard** *(default)* | `polynomial1` | 3 | Most printed and scanned maps |
| Primary | Perspective | `projective` | 4 | Maps photographed at an angle |
| Primary | Flexible | `thinPlateSpline` | 3, wants more | Hand-drawn or geometrically inconsistent maps |
| Advanced | Higher-order (2nd) | `polynomial2` | 6 | Only with many well-spread points |
| Advanced | Higher-order (3rd) | `polynomial3` | 10 | Only with many well-spread points |

The four primary types span the real range of need, and none substitutes for another. `helmert` preserves angles; `polynomial1` (affine) adds non-uniform scale and shear but **keeps parallel lines parallel**; `projective` adds exactly the thing affine cannot express — parallel lines converging, i.e. perspective; and `thinPlateSpline` is *interpolating*, passing exactly through the control points but smoothly blending between them rather than modelling a global perspective.

`projective` is primary, not deferred, because its use case is central rather than exotic: **a map photographed at an angle** — on a table, on a wall, in a bound atlas that will not lie flat. That is the archive-with-a-phone scenario, which is precisely what the local-image ingestion path exists to serve. With only the four corners of a photographed map, `thinPlateSpline` gives a visibly worse result.

`polynomial2` and `polynomial3` sit behind a disclosure because they require 6 and 10 points and, with sparse or clustered points, produce spectacular edge distortion that reads as the tool being broken. But they are not omitted: a user who has placed thirty control points on a distorted sixteenth-century map has a legitimate reason to want third-order, and hiding it entirely means hitting a ceiling with no explanation.

## Three types are never exposed

- **`straight` must never be offered — it is not round-trippable.** `typeAndOrderToTransformationType` handles `helmert`, `polynomial{,1,2,3}`, `thinPlateSpline`, `linear`, and `projective`, and **throws `'Unrecognised transformationType.'` for `straight`**, despite `straight` being a member of the `TransformationType` union. Exposing it would produce alignments that fail to deserialize.
- **`polynomial` is an alias for `polynomial1`** (`transformationTypeToTypeAndOrder` maps both to polynomial order 1). Always store the explicit `polynomial1`.
- **`linear`** is recognised as distinct from `polynomial1` but has no documented user-facing meaning.

**The guidance text, not the label, is the primary text in the picker.** "Most printed maps" is what a historian can act on; "Standard" is not. Labels are secondary, and are presentation only — the value stored in the Georeference Annotation is always the canonical Allmaps string, following the same boundary discipline as ADR-0004.

## Distortion visualisation ships in v1

Originally proposed as deferred; pulled into v1 because Suzanne asked for it specifically, and because it turns out to be built into the renderer rather than something we build:

- `WarpedMapOptions.distortionMeasure` selects which measure is **displayed** (a layer option, reachable through `MapLibreWarpedMapLayerOptions`).
- `SpecificTriangulatedWarpedMapOptions.distortionMeasures` selects which are **computed**. These are two different settings and conflating them is the obvious mistake: nothing displays if the measure was never computed.
- `distortionColor00 / 01 / 1 / 2 / 3` is a five-stop colour ramp, so it can be themed rather than hardcoded.
- `TriangulatedWarpedMap` keeps `previousTrianglePointsDistortion`, so transitions between transformation types can animate.

### Which measures are exposed

`DistortionMeasure` offers five: `log2sigma`, `twoOmega`, `airyKavr`, `signDetJ`, `thetaa`. Two are exposed, because they answer different questions.

- **`log2sigma`** (default) — log₂ of the area scale factor: where the map is drawn too big or too small relative to reality. The one a historian can reason about untrained, and zero means "no area change," so a diverging ramp reads naturally. This answers *how faithful is this old map?*
- **`signDetJ`** — sign of the Jacobian determinant; negative means the warp has folded over itself. This answers *did I make a mistake?*, since a fold almost always means a mis-placed control point rather than a quirk of the original mapmaker.

`twoOmega` and `airyKavr` are largely redundant for this audience. **`thetaa` is excluded for a technical reason: it is an angle, and angles are cyclic**, so pushing it through a linear five-stop colour ramp is actively misleading — 359° and 1° would render at opposite ends of the scale. It needs a vector-field visualisation, which is a different feature.

**The fold check is always on, independent of the overlay.** The colour overlay is a toggle, off by default, because a colourised map is not what you want while placing control points. But `signDetJ` is computed continuously and surfaces a plain warning — "this alignment folds over itself near the top-right" — whenever it goes negative. That is the correctness signal for free, without the visual cost, and it is the single most useful piece of feedback a student can receive.

**The distortion toggle is not persisted in `project.json`.** It is a working view, not a property of the work. Persisted, it would become layer display state under ADR-0002, and a published site could then load with a colourised map a reader has no way to interpret. A deliberate "show distortion" exhibit in a published site is a plausible future feature; it is not the same thing as remembering a debugging toggle.

`renderGrid` / `renderGridColor` render a warped graticule and come from the same options object. Also pedagogically valuable — seeing a regular grid bend is the most direct way to show *what a transformation does* — and effectively free.

## Consequences

- **Point count gates the type, visibly.** Show "Flexible needs at least 3 points — you have 2" and disable the option. The type must never be settable in a state the solver cannot handle; with too few points the solve is under-determined and yields either a thrown error or a garbage warp. This matters most in the Advanced tier, where ten points is a lot to have accumulated before the option becomes legible.
- **`nonWarpingTransformationTypes` is `['helmert', 'polynomial', 'polynomial1']`.** Those cannot fold locally, so the `signDetJ` warning is chiefly meaningful for `projective` and `thinPlateSpline`. On affine it still catches a *globally mirrored* map, which is the "I swapped two control points" error.
- **Changing the transformation type must never discard control points.** They are the user's actual labour; the transformation is a lens over them. The obvious implementation — reset on change — destroys work.
- **The resource mask defaults to the full image rectangle**, editable from there. Not empty: an empty mask renders nothing, which reads as a broken tool on a user's first alignment.

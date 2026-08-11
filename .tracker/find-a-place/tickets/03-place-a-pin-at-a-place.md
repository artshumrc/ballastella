# Place a Pin at a Place

## What to build

The same search surface slice 1 built, now on an open Annotation Layer, where choosing a candidate **frames the map on it and drops a Pin there** — titled with what the scholar typed, selected, and immediately draggable.

This is the slice the epic exists for.

**The gesture it serves:** a scholar looks up an address, sees the Pin land in the middle of a river, and drags it onto the quay — reading against the Base Map, or against a Historical Map layered over it. **The lookup is the cheap step; the correction is the scholarship.** A design that treats the service's answer as authoritative is designing against the actual use.

Read [`SPEC.md`](../SPEC.md) and [ADR-0029](../../../docs/adr/0029-place-lookup-is-a-warned-service-that-leaves-nothing-behind.md) first.

## Where to start

- **The search component slice 1 built. Reuse it.** If it needs a prop to distinguish framing-only from framing-and-placing, add one. **Do not fork it** — a criterion below asserts they are the same component.
- `apps/editor/src/lib/annotations/annotation-editing.svelte.ts` — `#addDrawn` is the creation path a placed Place must go **through**, not around. Read its header: an Annotation is drawn with the last one's style via `styleForNewAnnotation` in core, and that is the whole of what replaced a Layer's `defaultStyle`. **Note that `#addDrawn` does not set a title** — see the write-count contract below before designing around that.
- `apps/editor/src/lib/annotations/AnnotationLayerContents.svelte` and `AnnotationTools.svelte` — the surface, and the toolbar idiom the control sits beside. `AnnotationTools` documents why it has exactly one render path, which is what makes this the structurally correct home.
- `packages/core/src/annotation/annotation.ts` — `newAnnotation`, `setText`, `styleForNewAnnotation`, `addAnnotation`.
- `packages/core/src/annotation/geojson.ts` — read the two load-bearing properties in its header. The byte-identity round-trip is what one criterion below leans on directly.
- `apps/editor/src/lib/overlay/overlay-points.ts` — `annotation-vertex` is already a focusable, draggable, arrow-key-movable DOM `<button>` on a MapLibre `Marker`, and a `Marker` is a DOM overlay above the WebGL canvas. **The drag gesture needs no new code.** Read the note explaining why there is no `annotation-edge` kind.
- `e2e/editor-annotations.e2e.ts` — how a drawing gesture is driven and how the bytes it wrote are asserted.

## Contract

**A placed Pin is a `Point`.** The bounding box frames the camera and **never reaches the file**. Neither the rectangle nor a real administrative boundary becomes geometry — ADR-0029 records that the first is cartographically false (a rectangle labelled *Paris* takes in Boulogne) and the second is an ODbL question with teeth, and that **both are declined rather than deferred**.

**The title is the scholar's own query string.** Not the service's display name, which for Boston Common is `Boston Common, Boston, Suffolk County, Massachusetts, 02108, United States`. A pre-fill people delete every time is worse than an empty field, because now they must notice it.

**Nothing records that a lookup was involved.** No provenance property, no status flag, no new overlay point kind. ADR-0029 records that the strongest version of this — a scholar-owned "not checked yet" flag that self-clears — was argued for and **declined by human decision**. It is not an oversight, and building it is not tidying up.

**One store write, not two.** The obvious construction — add the Annotation, then set its title — is two commits and violates ADR-0017 rule 1, which this repository asserts by **counting**. The title must be present in the commit that creates the Annotation. Expect to give the creation path a title parameter.

**It goes through the existing creation path**, so style inheritance, selection, and the write path are the ones already asserted rather than a second implementation of each.

**Placing always frames.** A scholar looking at Amsterdam who picks a Boston address must not get a Pin off-screen — invisible, unverifiable, and uncorrectable, when correcting it is the entire point.

**The Pin is selected on placement**, so retitling it does not begin with hunting for it — exactly as a drawn one is.

## Out of scope

- **The Base Map pane's navigation.** Slice 1 delivered it. This slice adds placing on a different surface.
- **The failure outcomes.** Slice 2 owns them. Render whatever the shared component already renders.
- **The lint scan, deployment warning, probe, hosting docs.** Slice 4.
- **Widening undo.** ADR-0014 scopes single-level undo to the last *destructive* action. Placing is not destructive and deleting the Pin is already undoable. Do not touch the undo stack.
- **Lines and shapes from a lookup.** A Place is a point.
- **Any new `OverlayPointKind`.** `overlay-points.ts` records what a kind nothing produces costs.
- **Coordinate read-out in the Annotation editor.** A real gap, named in the spec's problem statement, deliberately on the path of no story here.
- **The published viewer.**

## Acceptance criteria

- [ ] On an open Annotation Layer, submitting a place name and choosing a candidate drops a Pin at that candidate's point and frames the map on it.
- [ ] The written GeoJSON holds a `Point`, asserted on **geometry type and coordinates**. A bounding box reaching the file must fail this.
- [ ] The Pin's `title` is the string the scholar typed, asserted against the **written bytes** rather than against the field.
- [ ] **A Pin placed from a lookup is byte-identical to a Pin drawn by hand and given the same title** — asserted by producing both and comparing the serialised files. This is the epic's central claim and it is directly checkable.
- [ ] The Pin carries no property naming a service, a query, a status, or an origin.
- [ ] The Pin is selected immediately after placement.
- [ ] The Pin is draggable immediately **and** movable by keyboard, through the existing vertex affordance — asserted **with a Historical Map Layer visible above the Base Map**, which is the stakeholder's actual gesture.
- [ ] **Placing produces exactly one store write**, asserted by counting. **Mutate this specifically:** split it into create-then-title, confirm the count assertion goes red, and restore.
- [ ] Style inheritance matches a hand-drawn Annotation — draw a coloured one, then place one, and assert it took the same colour.
- [ ] The candidate list is **the component slice 1 built, not a copy** — asserted by a wording or behaviour change in the shared component moving both surfaces.
- [ ] The mutation check is recorded per criterion. **Report any surviving mutation as green, with its reason.**

```sh
pnpm --filter @ballastella/core exec vitest run src/annotation src/places
pnpm exec playwright test e2e/editor-annotations.e2e.ts
pnpm lint && pnpm check && pnpm -r build && pnpm -r test
pnpm test:e2e
```

All four exit 0. **Read exit codes directly.** Never pass `--reporter=`. Do not pipe gate output through `grep`. No test may reach the network — drive every lookup by routing to the fixture committed in slice 1.

## Blocked by

- Slice 1 — [`01-find-a-place-and-go-to-it.md`](./01-find-a-place-and-go-to-it.md)

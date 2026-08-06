# Aligning becomes its own route

## What to build

Aligning a Historical Map moves out of the Project page and onto a route of its own: a split screen with the sheet on one side and the world on the other, reached by a button and left by a button.

Demonstrable end to end: from the Project page, click Align on a Historical Map; the alignment view opens at `/align/?p=<project>&layer=<layer-id>`; place Control Points, refine the mask, choose how the map is stretched; click back and land on the Project you came from with the work saved.

The distortion overlay, its measure choice, and the bent grid move behind a single "Check this alignment" disclosure in the same slice. The fold warning stays always on.

## Where to start

- `apps/editor/src/lib/alignment/AlignmentWorkspace.svelte` — 847 lines, currently mounted inline by `ProjectView`. This moves; it does not get rewritten. Note its **module-level `live` pairing state** and read the comment explaining why it is module state and not a captured instance: an undo record outlives the component, and a route change already destroys and rebuilds it. That comment is describing exactly the situation this ticket makes routine.
- `apps/editor/src/lib/components/ProjectView.svelte` — where `AlignmentWorkspace` is mounted today, around the `imageServiceFetch && shown` block, and the per-image selector buttons above it.
- `apps/editor/src/routes/layers/+page.svelte` — read its header for the pattern a full-page route uses: workspace host, `session.open(openDirectory)`, the recovery and problem states, `SaveIndicator`, `UndoControl`.
- `apps/editor/src/lib/alignment/DistortionControls.svelte` and `TransformationPicker.svelte` — the first goes behind the disclosure, the second stays visible.
- `e2e/support/alignment-workspace.ts` — the existing helper every alignment e2e spec uses to reach the workspace. It needs to navigate rather than scroll.
- `apps/editor/src/routes/+layout.ts` and `apps/editor/src/routes/base-map/+page.svelte` — the latter is the model for a `?p=`-addressed full-page route, including the mistake its comment records (it once called `EditorSession.opfs()` directly and wrote to the wrong Workspace).

## Contract

**The route is `/align/?p=<project-directory>&layer=<layer-id>`.** Keyed by **Layer id, not image id.** The Layer is what the user clicked and what owns the name; the image id is recoverable from the Layer. It also means the route is honest when the Layer has no Control Points yet.

**A prerendered route selecting its subject client-side, exactly as ADR-0008 requires.** No SPA fallback file, no per-Project artefact. The Workspace comes from the root layout's `useWorkspaceHost()` — never `EditorSession.opfs()`, which is the ticket-12 bug the `/base-map/` route's comment records.

**Every state the layers route handles, this route handles**: no Workspace (`host.unsupported`), storage still starting, no `?p=`, unreachable Workspace or awaiting folder (`WorkspaceRecovery`), `session.projectProblem` for missing and unopenable Projects, and — new here — **a `layer` parameter naming a Layer that is not in this Project**, which must say so and offer the way back rather than rendering an empty split screen.

**The alignment view fits its Base Map to the Alignment's Control Points when there are any.** With none, the deployment default is acceptable in this slice; ticket 09 supplies the Project-content fit and this route adopts it then.

**Distortion goes behind one disclosure labelled for what it is for**, not for what it is. The overlay, the measure choice between `log2sigma` and `signDetJ`, and the bent grid are all inside it, closed by default, and their state is **not persisted** — it is a working view, never Project data (ADR-0002). **The fold warning is not inside the disclosure**: it runs continuously and warns independently, because it is a correctness warning about a contradictory Control Point and not a visualisation.

**`TransformationPicker` stays visible.** Its plain-language guidance is the accessibility feature that SPEC story 47 asks for; hiding it would be hiding the thing that makes the choice possible without a cartography course. The guidance must remain **visible text**, never a tooltip (ADR-0016).

**Getting back is one obvious control** to `/?p=<project>`, and it must be reachable by keyboard from anywhere on the page.

## Out of scope

- **Do not rewrite `AlignmentWorkspace`.** Move it and give it a route. Pairing, mask editing, undo, and the two panes all work; changing them here means debugging someone else's slice.
- **Do not delete `ProjectView` or `/base-map/`.** Ticket 04. In this slice `ProjectView` keeps its Historical Maps list and its per-map buttons, and gains an Align button that navigates. That entry point is deliberately temporary.
- **Do not move the Align button to a Layer card.** There are no Layer cards on this screen yet. Ticket 05.
- **Do not build the remote-map pane.** Ticket 07. This route aligns only what it can align today.
- **Do not add a Base Map switcher to this route** if that means a third place the author default can be written. Keep whichever single switcher `AlignmentWorkspace` already carries and do not add another.
- **Do not persist the disclosure's open state**, the distortion measure, or the grid.

## Acceptance criteria

- [ ] `/align/?p=<project>&layer=<layer-id>` renders the sheet and the Base Map side by side and places a Control Point pair by click-then-click.
- [ ] The route builds and prerenders under the static adapter, and the built output contains no SPA fallback file.
- [ ] Opening the route with no `?p=`, with a missing Project, with an unopenable Project, and with a `layer` id not in the Project each render a named state with a link back — never a blank split screen and never an unhandled rejection.
- [ ] Placing a Control Point, navigating back to the Project, and returning to the alignment view shows that Control Point.
- [ ] The undo control still reverses a Control Point move after navigating away from the alignment view and back.
- [ ] The distortion overlay, its measure choice, and the bent grid are absent from the accessibility tree until the disclosure is opened.
- [ ] The fold warning appears for a self-intersecting set of Control Points **with the disclosure closed**.
- [ ] The transformation guidance is present as text in the accessibility tree, not as a `title` or CSS-generated tooltip.
- [ ] Reloading the alignment view does not reopen the disclosure.
- [ ] Every control on the route is reachable by keyboard, and the way back is among them.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm exec playwright test e2e/editor-alignment.e2e.ts e2e/editor-alignment-refinement.e2e.ts e2e/editor-undo.e2e.ts
pnpm test:e2e
```

All green. `e2e/support/alignment-workspace.ts` must be updated to navigate to the route; every spec using it should then pass with no change to its own assertions, which is the signal that the move preserved behaviour rather than altering it.

For the fold-warning and disclosure criteria, break each behaviour and confirm the test goes red — a check for the *absence* of an element passes trivially if the selector is wrong.

## Blocked by

- Ticket 01

## Implementation notes

**Pressing Align writes the Alignment, and that is what creates the Layer.** The route is keyed by
Layer id, and a Historical Map nobody has aligned has no Layer in this Project — so something had to
turn "this map" into "the Layer that draws it". `EditorSession.ensureMapLayerFor` does it by routing
`newAlignment` through the existing `writeAlignment`, which writes `alignments/<id>.json` and *then*
calls `#ensureMapLayer`. Writing the Alignment first is not incidental: `assertReferencesPresent`
requires it for every map Layer, `editor-layers.e2e.ts` has a test named for that invariant, and a
Layer created beside no Alignment is a Project this build exports and then refuses to import — the gap
ticket 01's review deferred to ticket 02. The visible consequence is that
`alignments/<id>.json` now appears when Align is pressed rather than at the first Control Point;
`editor-alignment.e2e.ts`'s "Escape … writes no Alignment at all" was rewritten to assert the criterion
it was actually about (a mis-started pair writes nothing) as byte-identity rather than as absence.

**The `removedMapLayers` tombstone is honoured by Align, not lifted.** A map whose Layer was deleted
gets a named refusal on the Project page rather than a silently recreated Layer. Re-adding a Workspace
map to a Project is SPEC story 23 and ticket 06's affordance, and making Align an exception would put
the resurrection this tombstone exists to prevent behind a button instead of behind a write.

**`#ensureMapLayer`'s creation path is now unreachable from the interface**, and two tests changed
shape because of it. Every Alignment write is preceded by an Align click that already made the Layer,
so the method's early return is what runs. `editor-undo.e2e.ts`'s resurrection-trap test now asserts
that Align refuses (in this session and in a later one, so the *file* is what carries the tombstone),
and its "two Alignment writes in flight" test is now a regression guard rather than a reproduction —
the delayed `manifest.json` read widens the window inside `ensureMapLayerFor` instead. **Ticket 02
should decide whether `#ensureMapLayer` survives at all**: once a Layer is created when a map is added,
nothing is left for it to do.

**`BaseMapPane` gained a `fitTo` prop, fitted on array identity rather than on contents.** The page
hands over a new array exactly when it wants a fit — once, in `AlignmentWorkspace.loadAlignment` — so a
dragged Control Point cannot pull the earth out from under the pointer. Ticket 09's Project-content fit
is a second caller of the same prop.

**Closing "Check this alignment" resets the distortion view.** Not in the contract, but the alternative
is a Historical Map left colourised with the only control that turns it off no longer on the page. The
cost is that reopening starts from the default rather than the last measure.

**The header's way-back link is inside `{#if session !== null}`.** SvelteKit throws on
`url.searchParams` while prerendering, and the header renders outside the route's state chain, so
reading `?p=` there killed the build. `session` is `null` in exactly the same condition, and every
named state below the header carries its own way back.

**Two e2e helpers needed a `scrollIntoViewIfNeeded`-shaped fix.** The route's header and its
screen-reader explainer make the page ~120px taller than `ProjectView` was, which pushed a Resource
Mask handle below the fold — `page.mouse` takes viewport coordinates and does no actionability check,
so the drag landed on nothing and reported no error. `dragBy` already documents this hazard; the one
inline drag in `editor-alignment-refinement.e2e.ts` now takes the same precaution.

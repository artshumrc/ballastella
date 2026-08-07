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

- [x] `/align/?p=<project>&layer=<layer-id>` renders the sheet and the Base Map side by side and places a Control Point pair by click-then-click.
- [x] The route builds and prerenders under the static adapter, and the built output contains no SPA fallback file.
- [x] Opening the route with no `?p=`, with a missing Project, with an unopenable Project, and with a `layer` id not in the Project each render a named state with a link back — never a blank split screen and never an unhandled rejection.
- [x] Placing a Control Point, navigating back to the Project, and returning to the alignment view shows that Control Point.
- [x] The undo control still reverses a Control Point move after navigating away from the alignment view and back.
- [x] The distortion overlay, its measure choice, and the bent grid are absent from the accessibility tree until the disclosure is opened.
- [x] The fold warning appears for a self-intersecting set of Control Points **with the disclosure closed**.
- [x] The transformation guidance is present as text in the accessibility tree, not as a `title` or CSS-generated tooltip.
- [x] Reloading the alignment view does not reopen the disclosure.
- [x] Every control on the route is reachable by keyboard, and the way back is among them.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm exec playwright test e2e/editor-alignment.e2e.ts e2e/editor-alignment-refinement.e2e.ts e2e/editor-undo.e2e.ts
pnpm test:e2e
```

All green. `e2e/support/alignment-workspace.ts` must be updated to navigate to the route; every spec using it should then pass with no change to its own assertions, which is the signal that the move preserved behaviour rather than altering it.

For the fold-warning and disclosure criteria, break each behaviour and confirm the test goes red — a check for the *absence* of an element passes trivially if the selector is wrong.

## Blocked by

- Ticket 01

## Mutation evidence

Every criterion was checked by breaking the behaviour and confirming the test went red. Each mutation
was applied alone, the editor rebuilt, and the named test run; all were reverted afterwards.

| Criterion | Mutation | What went red |
| --- | --- | --- |
| 1 | the route matches `?layer=` against `MapLayer.imageId` instead of `.id` | `image-pane` never appears |
| 2 | `adapter({ fallback: '200.html' })` | `200.html is an SPA fallback` |
| 3 | the `{:else if layer === null}` branch removed | `layer-missing` not found |
| 3 | the heading hard-coded to `Project not found` | `This Project cannot be opened` not found |
| 4 | `readAlignment` returns `newAlignment` and discards the stored bytes | 0 Control Point rows after the round trip |
| 5 | `putBack` reverses `recordedOn` instead of resolving `live` | the Alignment on disk drops to 3 pairs from 4 |
| 6 | `DistortionControls` rendered unconditionally | the overlay checkbox is in the accessibility tree with the disclosure closed |
| 7 | the fold warning moved inside `{#if checking}` | `fold-warning` not found with the disclosure closed |
| 8 | the guidance paragraph emptied and moved to `title=` | the guidance is `hidden` |
| 9 | `checking` persisted in `sessionStorage` and restored on mount | `aria-expanded` is `true` after a reload |
| 10 | `tabindex="-1"` on the way back | `these controls cannot be reached by Tab: A[back-to-project]` |
| contract: fit | `fitTo` left empty in `loadAlignment` | the Base Map does not move when the route is reopened |

**Re-run after the reconciliation onto ticket 02**, for the review's findings and for the tests the
review required to survive rather than be deleted as tombstone fallout:

| What it protects | Mutation | What went red |
| --- | --- | --- |
| opening the view is not a write | `loadAlignment` calls `writeAlignment` after reading | `opening the alignment view wrote an Alignment`, 1 write recorded |
| story 36 against this route | the route adds one Layer on mount | `storedProjectFile` no longer byte-identical |
| a mis-started pair costs nothing | `clickHistoricalMap` saves for a pending half | 1 write recorded — **and byte-identity stayed green**, which is exactly why the count is there |
| an Alignment write never touches the stack | `writeAlignment` rewrites `project.json` after committing | `updatedAt` moved, in undo's byte-identity test |
| Align is a link, not a busy button | `<a>` changed back to `<button>` | `toHaveRole('link')` received `"button"` |
| no Layer means no Align control | the link rendered whatever `mapLayerFor` returned | `align-historical-map` count 1, expected 0 |
| `host.unsupported` | the branch deleted | `No storage for a Workspace` not found |
| `WorkspaceRecovery` | the branch made unreachable | `Workspace not reachable` not found |
| "Starting…" | the text emptied | the prerendered `align.html` no longer contains it |

Two notes on what the mutations revealed rather than confirmed.

**Criterion 6's first mutation was not a violation.** Replacing the conditional render with
`class:hidden` was caught only by the `data-testid` count, not by the `getByRole` queries — because
`display: none` genuinely does remove a subtree from the accessibility tree, so the criterion as
written was still met. The mutation that breaks the criterion is rendering the controls with no
hiding at all, and that is the one recorded above.

**Criterion 2's prerender half is structural rather than asserted against a matcher.** `statSync` on
`build/align.html` throws when the file is absent, so it cannot pass vacuously; only the fallback half
needed a mutation.

**Both new write-counting assertions were vacuous on their first run, and the mutation is what said
so.** `writeAlignment` records a write *after* its commit resolves, so reading the counter the moment
the gesture's visible effect lands reads it ahead of a write that is on its way; both now settle
first. The route test was worse: `recordAlignmentWrite` pushes only when
`window.ballastellaAlignmentWrites` exists and a reload throws the array away, so a counter armed once
before a reload counted nothing after it — every assertion downstream passing by construction. It is
armed twice now. This is the same class of defect as the un-failable fence this ticket's review found,
arrived at independently within an hour of writing the replacement, and it is the argument for the
mutation step rather than an anecdote about it.

## Implementation notes

**Align is a plain link, and opening the alignment view writes nothing.** The route is keyed by Layer
id, and since ticket 02 a Historical Map that is in a Project already has its Layer — adding the map
made it, along with its starter Alignment — so the `?layer=` the route needs exists before the user
reaches for it. `EditorSession.mapLayerFor` is the lookup that finds it: synchronous, read-only, and
the same one `#addMapLayer` consults to decide whether this Project already draws a map, so there is
one answer to that question rather than two that can drift.

**What this replaced, and why it had to go.** This ticket was first written against ticket 01's world,
where a map could be in a Project with no Layer, and it made the Layer on the way in:
`ensureMapLayerFor` routed `readAlignment` into `writeAlignment`. Under ADR-0023 that is a defect
rather than a convenience. `alignments/<id>.json` belongs to the **Workspace** and is shared by every
Project that draws the map, so for a map already aligned in another Project, pressing Align rewrote
somebody else's work — through `serialiseAlignment`, which regenerates the document from the model and
therefore silently drops any field a third-party Georeference Annotation carries that `Alignment` does
not model (SPEC story 60). In a Workspace kept in git or Dropbox, merely opening a view became a sync
event. It also forced the control to be a button that disabled itself across a store read with nothing
announcing why, and a `goto` needing a `svelte/no-navigation-without-resolve` suppression. All three
went with the write: a link needs no busy state, and a resolved path followed by a query string is the
shape the lint rule already recognises. **Ticket 18 still owns the general seam** — one writer for a
shared Alignment, and a fence — because nothing here stops the *next* caller inventing the same
overwrite; what is done here is the removal of this ticket's instance.

**A Historical Map with no Layer in this Project is a named state, not a missing control.**
`session.images` is the Workspace's list (ADR-0023), so a Project can be shown a map it does not draw;
and a Project whose starter Alignment failed to write has the pyramid without the Layer. Both render a
sentence where the Align link would be, because "there is no button" is indistinguishable from a page
that has not finished loading. The `layer === null` state on the route stays for the same reason it
always existed — a stale bookmark can name a Layer that is no longer there.

**The resurrection trap is now closed twice, and one test went with it.**
`editor-undo.e2e.ts`'s "survives an Alignment write, and survives one in a later session" drove a
gesture the interface no longer offers: with the alignment view keyed by Layer id, there is no way to
write an Alignment for a map this Project does not draw. Ticket 02 closed it in the model, ticket 03
closed it in the routing. What it asserted is still asserted by the two tests beside it. **The
cross-Project form is a named gap**, recorded in that file: two Projects drawing one Workspace map,
the Layer deleted in A, B goes on aligning it. That is reachable and untested, and it belongs beside
the other Workspace-sharing specs rather than in the undo file.

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

**Every e2e number here was measured on ports derived from this checkout's path.**
`playwright.config.ts` now hashes the repo root into a port pair, so a worktree can no longer be
served by — or serve — a sibling's `apps/*/build`. The throwaway config an earlier run of this ticket
used is gone, and nothing here edits ports.

**Two e2e helpers needed a `scrollIntoViewIfNeeded`-shaped fix.** The route's header and its
screen-reader explainer make the page ~120px taller than `ProjectView` was, which pushed a Resource
Mask handle below the fold — `page.mouse` takes viewport coordinates and does no actionability check,
so the drag landed on nothing and reported no error. `dragBy` already documents this hazard; the one
inline drag in `editor-alignment-refinement.e2e.ts` now takes the same precaution.

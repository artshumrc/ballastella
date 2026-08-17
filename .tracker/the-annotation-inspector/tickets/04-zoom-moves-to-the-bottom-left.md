# 04 — Zoom moves to the bottom-left in every map pane

## What to build

MapLibre's `NavigationControl` sits at the top-right of all three map panes. The Annotation Inspector
docks into that corner, so the corner has to be cleared first — and cleared everywhere, so that "zoom
is at the bottom-left in this application" is one thing to learn rather than one thing plus an
exception.

Move it to `bottom-left` in all three panes: the Project screen's Base Map pane, the viewer's reader
pane, and the alignment route's image pane. A prefactor: nothing else changes and no user gains a
feature, but the corner ticket 06 needs is empty when it gets there.

## Where to start

- `apps/editor/src/lib/base-map/BaseMapPane.svelte` — `created.addControl(new NavigationControl({}),
  'top-right')`. Note also the overlay at the pane's **top-left**: an `absolute top-2 left-2 z-10 w-72`
  container holding `PlaceSearch`. That is why the Inspector docks right and zoom moves left-*bottom*
  rather than left-top.
- `apps/viewer/src/lib/ReaderMapPane.svelte` — `created.addControl(new NavigationControl({}),
  'top-right')`. This pane's top-left is empty.
- `apps/editor/src/lib/image-pane/ImagePane.svelte` — `created.addControl(new NavigationControl({
  showCompass: false }), 'top-right')`. The alignment route. **This one does not have to move** and is
  moving for consistency alone; keep the `showCompass: false` exactly as it is.
- `packages/ui/src/layout.css` — the rule headed "THE RULE THAT KEEPS THE LEADER OFF THE MAP'S OWN
  CONTROLS". It already names all four corners (`top-left`, `top-right`, `bottom-left`,
  `bottom-right`) at `z-index: 6`, so **no stylesheet change is needed** — but read the comment, because
  it explains why those numbers are compared against the leader's 5 in one shared stacking context, and
  ticket 06 depends on understanding it.
- MapLibre puts its attribution at `bottom-right` by default. Confirm bottom-left is genuinely free in
  each pane before moving anything into it.

## Contract

- **All three panes, `bottom-left`.** No pane keeps `top-right`, and no pane gets a different corner
  from the others.
- The controls' own options are unchanged: the image pane keeps `showCompass: false`, the other two keep
  their defaults.
- **No change to `layout.css`.** The z-index rule already covers `bottom-left`. If a control appears
  underneath the leader after the move, that is a finding to report rather than a rule to add — it
  would mean the existing rule is not doing what its comment claims.
- Nothing else moves. The editor's `PlaceSearch` overlay stays at the pane's top-left; the attribution
  stays where MapLibre puts it.

## User Stories

- **18.** As an author, I want the panel never to sit under the zoom control, so that I never have to
  dismiss a panel to zoom.

The benefit clause is forward-looking, which is what a prefactor's story looks like: after this ticket
the corner is permanently clear, so the panel ticket 06 docks there cannot ever be under the control.
Ticket 06 must not have to move a control to make room.

## Out of scope

- **The Annotation Inspector**, which does not exist yet. Do not add a placeholder, a container, or a
  `z-index` for it.
- Camera padding, `easeTo`, or anything about what the map does when an Annotation is selected — ticket
  07.
- Any other MapLibre control: no scale bar, no fullscreen, no geolocate.
- Restyling the controls, or overriding MapLibre's own CSS beyond what already exists.
- The `PlaceSearch` overlay's position, and the attribution's.

## Acceptance criteria

- [ ] `grep -rn "'top-right'" apps/ --include=*.svelte` returns nothing.
- [ ] All three panes call `addControl(..., 'bottom-left')`.
- [ ] In a real browser, each of the three panes renders `.maplibregl-ctrl-bottom-left` containing the
      zoom buttons, and `.maplibregl-ctrl-top-right` is empty or absent.
- [ ] The image pane's control still has no compass.
- [ ] The editor's Base Map pane still shows its place search at the top-left, unmoved.
- [ ] `pnpm precommit` passes in full — this touches three routes, so run the whole gate rather than a
      subset.

```bash
cd /home/dflood/repos/ballastella
grep -rn "'top-right'" apps/ --include=*.svelte || echo "clean"
grep -rn "addControl" apps/ --include=*.svelte
pnpm precommit
```

Success: the grep prints `clean`, `addControl` shows three call sites all reading `'bottom-left'`, and
`pnpm precommit` exits 0.

## Blocked by

None — can start immediately.

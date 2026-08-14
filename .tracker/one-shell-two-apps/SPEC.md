# One Shell, Two Apps

## Problem Statement

**A scholar publishes their Project and does not recognise it.**

The editor's Project screen is a Base Map with a sidebar of Layer cards: each card tinted in its kind's own colour, opening in place to reveal what is inside it. The published viewer shows the same Project — the same Layers, the same order, the same Annotations — and looks like a different application. There is no navigation bar at all, so the only way back to the list of Projects is a text link above the heading. The Layer stack is a column of bordered rows with `1/4`, `2/4` counters, no kind tint, no kind line, and no disclosure. An Annotation cannot be reached from the sidebar at all: the only way to read one is to find its pin on the map and click it.

**The two apps are not one interface with a part removed; they are two implementations of the same idea.** `ReaderLayerControls` and `LayerList` are separate files, arrived at separately. So are the Hub and the Front Page, which render the same `card bg-base-100 card-border` markup twice. So is the Base Map switcher. The kind-ink `color-mix` variables and the overlay-point styles exist in the editor's `layout.css` and nowhere else, which is why a published Layer card has no tint to lose. Every sentence the two apps share is spelled twice, and the ones that have already drifted are the ones nobody noticed drifting.

**The viewer tells a Reader things they cannot act on.** Each Historical Map Layer carries a badge reading *Held on another server — needs the network* or *In this site — no network needed*. Where the tiles live is the author's decision, taken at publish time. A Reader cannot copy a pyramid, cannot repoint a service, and cannot make the badge say the other thing. It is a true fact addressed to the wrong person.

**And inside the editor, an Annotation's details are detached from the Annotation.** Selecting a row in an Annotation Layer's list opens an editor panel *below the list* — a box headed "The west quay" sitting under a list in which "The west quay" is one of four rows, with nothing joining the two. With four Annotations and a 24 rem column, which row the panel belongs to is inferred rather than seen, and the panel is far enough down that the row and its own contents are often not on screen together.

## Solution

**One set of Svelte components and one stylesheet, used by both apps.** The editor and the viewer render the same navigation bar, the same Layer card, the same Project card list, the same map-pane chrome. The viewer differs by *absence*: it is handed fewer snippets and fewer callbacks. There is no read-only mode and no `readOnly` flag — a control the viewer does not get is a prop the viewer does not pass.

**The shell is the editor's, tightened.** A solid navigation bar across the top; a `base-300` Layer column with `base-100` kind-tinted cards; the map taking everything left over. This is the *Stack* direction from the shortlist, chosen over two alternatives that each asked one of the two apps to become something it is not.

**Everything on a canvas is numbered, and the number is on its row.** Annotations on the Project screen, Control Points on the alignment route. A dashed leader joins the selected mark to its row, across the boundary between the canvas and the sidebar. "Look at 3" works across a desk, and works for someone reading the ordinal rather than seeing the line.

**An Annotation opens inside its own row.** The separate editor panel is gone. The selected Annotation's row expands in place — animated, one at a time — to reveal its title, its description, its style controls and its delete in the editor, and its title and rendered description in the viewer. Which Annotation is active is no longer inferred from a panel below a list; it is the row that is open.

**A Reader gets a Layer sidebar that is worth having.** Kind tints, a disclosure, the Annotations listed inside their Layer, and every Annotation readable without hunting for its pin. The map popup retires on the Project screen in both apps: the row is where an Annotation is read, and the leader is what says which pin it belongs to.

**And the badges a Reader cannot act on go.** They stay in the editor, where making an offline copy is one button away and the fact is therefore actionable.

## User Stories

### Recognising the published work

1. As a scholar, I want my published Project to look like the Project screen I authored it on, so that I recognise my own work when I visit the site.
2. As a scholar, I want to talk a colleague through a published site over the phone while I have the editor open, so that we are looking at the same interface and not two dialects of one.
3. As a Reader, I want a navigation bar on every screen of a published site, so that I always know where I am and how to get back.
4. As a Reader, I want the site's own name in the bar, linking to the Front Page, so that the way home is in the same place on every page.
5. As a Reader, I want the Project's name shown as the place I am currently in, so that the bar tells me where I am rather than only where I can go.
6. As a Reader on a phone, I want the bar to keep the Project's name and the way home when everything else folds into a menu, so that the two things I need are never the two things that were dropped.
7. As a Reader, I want the theme control in the same place it is in the editor, so that one habit serves both.
8. As a scholar, I want the Hub and the Front Page to be the same list of Project cards, so that publishing does not reformat my Projects into something else.
9. As a Reader, I want the return links to Ballastella to sit in the bar with the other things that are true on every screen, so that they are findable rather than buried in prose.

### The Layer stack, in both apps

10. As a Reader, I want each Layer to be a card in its kind's own colour, so that a Historical Map and an Annotation Layer differ before I have read a word.
11. As a Reader, I want a Layer card to open in place to reveal what is inside it, so that the sidebar is a stack rather than a wall.
12. As a Reader, I want only one Layer card open at a time, so that the column does not become a scroll.
13. As a Reader, I want the top of the list to draw over everything below it, said in words on the screen, so that the order means something I can check.
14. As a Reader, I want to show and hide a Layer, so that I can see what is underneath.
15. As a Reader, I want to fade a Historical Map, so that I can compare it against the modern map beneath.
16. As a Reader, I want a hidden Layer's card drained of its colour and marked "Hidden" in words, so that I can find the Layer that has gone missing without relying on colour alone.
17. As a Reader, I want to be told plainly when a Layer could not be drawn and why, so that a blank patch of map has an explanation beside it.
18. As a Reader, I want a Layer of a kind this viewer does not understand to say so and be left alone, so that a site published by a newer version still opens.
19. As a Reader, I want never to be shown a control that would change the author's work, so that I cannot break something I am only reading.
20. As a Reader, I want no badge telling me where a Historical Map's tiles are held, so that I am not given a fact I have no way to act on.
21. As a scholar, I want that badge kept in the editor, so that the one person who can make an offline copy is still told when one is wanted.
22. As a Reader, I want my visibility and opacity changes announced, so that a change to the map is legible without seeing the canvas.
23. As a Reader, I want my changes to live for the length of my visit and be written nowhere, so that I cannot be blamed for altering a published record.

### An Annotation opens in its own row

24. As a scholar, I want an Annotation's details to open inside its own row, so that I can see which Annotation I am editing without inferring it.
25. As a scholar, I want the row to expand and collapse with a short animation, so that I can follow where the contents came from.
26. As a scholar, I want that animation to be instant when I have asked my system for less motion, so that the interface respects a setting I already made.
27. As a scholar, I want only one Annotation open at a time, so that the Layer card does not grow into a page.
28. As a scholar, I want clicking the open row again to close it, so that the gesture that opened it is the gesture that puts it away.
29. As a scholar, I want the keyboard to stay on the row I opened, so that a disclosure does not cost me my place.
30. As a scholar, I want an expanded row that has scrolled out of the column to be brought back into view, so that opening something does not hide it.
31. As a scholar, I want the open row's state announced as expanded or collapsed, so that the disclosure is legible to a screen reader.
32. As a Reader, I want to open an Annotation's row and read its title and description there, so that I do not have to find its pin on a map first.
33. As a Reader, I want an Annotation's description rendered rather than shown as Markdown source, so that I read what the scholar wrote.
34. As a Reader, I want a description written by a stranger to be inert wherever it is rendered, so that opening a published Project cannot run somebody else's code.
35. As a scholar, I want the row that is open to be the Annotation that is selected on the map, so that there is one answer to "which one is active" rather than two that can disagree.
36. As a scholar, I want starting a new Annotation to close whatever row was open, so that the panel under my pointer is never the wrong Annotation's.

### Numbers and leaders

37. As a scholar, I want every Annotation numbered on the map and on its row, so that I can refer to one out loud.
38. As a Reader, I want the same numbering, so that a scholar's written reference to "3" matches what I see.
39. As a scholar, I want a leader line from the selected mark to its row, so that the connection between the canvas and the sidebar is shown rather than remembered.
40. As a scholar, I want the leader to follow the map as I pan and zoom, so that it stays true rather than becoming a lie.
41. As a scholar, I want the leader to disappear when either of its ends is off screen, so that a line to nowhere is never drawn.
42. As a screen-reader user, I want the ordinal and the expanded state to carry the connection, so that nothing about which Annotation is active depends on seeing a line.
43. As a scholar, I want the ordinal to be a display fact and never written into my GeoJSON, so that renumbering does not rewrite my files.
44. As a scholar, I want Control Points numbered on both panes and on their rows, so that "point 7" identifies one pair.
45. As a scholar, I want a leader from the selected Control Point to its row, so that a list of eleven pairs is navigable.
46. As a scholar on a phone, I want the leader replaced by the row simply being open and highlighted, so that a column too narrow to draw a line in is not given a broken one.

### The alignment route

47. As a scholar, I want the alignment route to wear the same navigation bar as everything else, so that I do not arrive somewhere that looks like another program.
48. As a scholar, I want the two panes to be exactly equal in width, so that neither sheet nor earth is privileged by the layout.
49. As a scholar, I want the Control Point column to be solid and docked, so that nothing floats over a pane I am clicking to sub-pixel accuracy.
50. As a scholar, I want the alignment route to exist only in the editor, so that a published site does not carry a screen no Reader can use.
51. As a scholar, I want the save indicator and the undo control on this route as on every other, so that I never wonder whether alignment work is being kept.

### The Hub and the Front Page

52. As a scholar, I want one card per Project with its folder, its Layer count and when it was last saved, so that I can find my work.
53. As a Reader, I want the same card without the things I cannot do, so that the list is not a menu of disabled controls.
54. As a scholar, I want New Project, the per-Project menu and Publish on the Hub and nowhere in the viewer, so that authoring actions exist only where authoring happens.
55. As a Reader, I want the site's own sentence about itself, so that I know what I am looking at and who made it.
56. As a Reader, I want a site with no Projects yet, and a site whose Projects are all off the Front Page, to say two different things, so that I am not sent looking for files that are exactly where they were left.

### Shared components as an engineering property

57. As a contributor, I want the Layer card to exist once, so that a change to it cannot land in one app and not the other.
58. As a contributor, I want the viewer to remove editing by passing fewer props, so that "read-only" is not a mode that can be got wrong.
59. As a contributor, I want a shared component tested where it lives rather than twice, so that the test suite does not grow a second copy of the same claim.
60. As a contributor, I want a test that asserts an editing control is absent from the viewer *and* present in the editor, so that the absence cannot pass vacuously.
61. As a maintainer, I want the viewer's bundle measured before and after, so that sharing components does not silently make every published site larger.
62. As a maintainer, I want the dependency fence kept, so that the viewer still cannot reach the tiler or a drawing library.
63. As a maintainer, I want nothing in the shared package to import from either app, so that the seam is a seam rather than a name.
64. As a contributor, I want the theme modules to stay separate and the reason recorded, so that a future contributor does not "fix" a deliberate divergence.
65. As a scholar, I want none of this to change a single byte in my Workspace, so that a redesign is not a migration.

### Accessibility, throughout

66. As a keyboard user, I want every control in a Layer card reachable in a sensible order, so that the sidebar is operable without a pointer.
67. As a keyboard user, I want the disclosure to be a real button with a real expanded state, so that my screen reader tells me what it does.
68. As a screen-reader user, I want the stack's order to come from the markup, so that "above" means the same thing to me as it does to a sighted Reader.
69. As a screen-reader user, I want every state that is shown in colour also shown in words, so that no information reaches only one sense.
70. As a Reader with low vision, I want the interface to hold up in both themes, so that neither is the second-class one.

## Implementation Decisions

### The shared package — a new ADR, amending ADR-0019

`packages/ui`, publishing `.svelte` and `.ts` **source** with `svelte` as a peer dependency. No build step, no `dist`: the apps' bundlers compile it, which is the arrangement `core` already uses and the reason `core` has `check` and `test` scripts and no `build`.

[ADR-0019](../../docs/adr/0019-minimal-pnpm-monorepo.md) says one `core` package "until a seam proves itself". Shared Svelte components are that seam, and the ADR must be amended rather than quietly contradicted. The components do **not** go into `core`: `core` is the domain model and adding Svelte to it would put a UI framework under the alignment serialiser.

**What moves:**

| Subject | Modules |
| --- | --- |
| Chrome | the navigation bar and its page-chrome slot, the modal dialog, the menu popover |
| The stack | the Layer list and card, the Layer-kind style table, the Annotation list and row |
| An Annotation | the Annotation editor and its colour and line-style pickers, the shape icons |
| Projects | the Project card list rendered by both the Hub and the Front Page |
| Map chrome | zoom, attribution, the notices, the `sr-only` live regions |
| Base Map | the switcher |
| Styles | one `layout.css` — today the kind-ink `color-mix` variables and the overlay-point rules exist in the editor's copy alone |

**What does not move:** `theme.svelte.ts` stays two modules. The viewer reads `prefers-color-scheme` once at construction; the editor keeps a stored preference and a live listener because an author sits in it for hours. The divergence is already argued in the viewer's own module header and that argument is unchanged — what is shared is the *control*, not the signal behind it.

### How the viewer subtracts

**By passing less.** `LayerList` already takes every write as a callback (`ontypename`, `onmove`, `ondelete`, `ondragopacity`) and every editor-specific block as a snippet (`mapContents`, `annotationContents`, `problemAction`). Where a prop is required today and the viewer has no answer for it, it becomes optional, and its absence is what removes the control. There is no `readOnly` prop and no `mode` prop anywhere in the shared package.

`ReaderLayerControls` is **deleted**. The behaviours in it that are genuinely a Reader's — the announcement of a view change, *Read as a document* — become optional affordances on the shared card, offered to whichever app passes them.

The `data-image-mode` badge stays in the editor's prop set and is not passed by the viewer. Its test ids and the assertions on them move with it.

### The Annotation row becomes a disclosure

The Annotation editor is rendered **inside the selected row's `<li>`**, not as a sibling of the list.

- **Selection and expansion are one state, not two.** One Annotation is selected at a time and the selected one is the open one, so the row's `aria-pressed` is replaced by `aria-expanded` plus `aria-controls`. Clicking an open row closes it and deselects, which is what clicking a chosen row already does.
- **One row open at a time**, mirroring the rule the Layer cards already follow.
- **The animation is a height transition, 220 ms, `cubicOut`, and zero when the user has asked for less motion.** That is not a new decision: it is the same pair the Layer cards' reorder already uses, read from the same signal.
- **Focus is never taken.** The disclosure is the row's own button, so opening and closing leave the keyboard exactly where it was — unlike the Layer card's delete and reorder, which move focus only because the element that held it stopped existing.
- **After expanding, the row's header is scrolled back into view if it has left the column.** A 24 rem sidebar can push a row off its own screen by opening it.
- **The map popup retires on the Project screen in both apps.** The row is where an Annotation is read; the leader is what says which pin it belongs to. On a phone, where there is no room for a leader, tapping a pin opens the row and scrolls it into view.

⚠ **The sanitiser does not retire with the popup.** `renderAnnotationPopup` holds this repository's one `setHTML` ([ADR-0009](../../docs/adr/0009-annotations-use-simplestyle-spec.md)); the row renders a description through `renderDescription`, which is the same core path the Annotation editor already uses. The claim that a stranger's description is inert **moves to the row** and is not deleted. This is the single highest-risk consequence in the epic and every ticket touching it must say so.

### Numbers

An ordinal is the index of an Annotation within its collection, and of a Control Point within its Alignment. **Display state, never written** ([ADR-0002](../../docs/adr/0002-display-state-separate-from-portable-documents.md)): no GeoJSON feature gains an `id` or a property from this, and no Alignment file changes. Renumbering after a delete is a re-render, not a write.

The Control Point marker already carries its ordinal inside it — `pane-overlay-point-control-point` draws it as text, because [ADR-0022](../../docs/adr/0022-control-point-pairing-is-click-then-click.md) wanted "look at point 7" to work over a student's shoulder. What is new is the ordinal on the *row* and the leader between them.

### The leader layer

One absolutely-positioned SVG spanning the sidebar and the canvas together, above both, `aria-hidden`, `pointer-events: none`. It draws a single dashed polyline from the selected mark to its row.

Recomputed on: map move and zoom, sidebar scroll, the expand/collapse transition, window resize, and any change to which Layers are shown. Not drawn at all when either end is outside its container, or below the breakpoint at which the sidebar sits under the map.

⚠ **This is the most expensive single feature in the epic and it is the one that can be deferred without invalidating anything else.** The ordinal and the open row carry the meaning on their own; the leader makes it immediate. It is sequenced after the disclosure deliberately, so that a ticket that runs into trouble with it fails late rather than blocking the rest.

### Routes, unchanged

No route is added, removed or renamed. `/align` and the image-pane harness remain editor-only, and nothing in the viewer's bundle may import them — a screen no Reader can reach must not cost a published site bytes.

### No format change

Nothing in this epic writes a different byte to disk. No `formatVersion` bump, no migration, no change to the Workspace layout. A Project authored before this epic and one authored after must be byte-identical for the same actions, and that is an assertion rather than an aspiration.

### Costs, accepted and recorded

- **`@lucide/svelte` becomes a viewer dependency.** Per-glyph imports, so the weight is small; `scripts/check-viewer-deps.mjs` permits it. The before-and-after bundle size is recorded.
- **`terra-draw` is not in the way.** It is not a dependency anywhere in this repository — every mention is a comment arguing why it was declined, three tickets running — and the tiler draws in no dependency of its own. The drawing surface can therefore live in the shared package like anything else; it is simply not passed to the viewer.
- **Every moved component's harness moves with it**, and the component seam must exist in `packages/ui` or the shared components are tested in the app they left.

## Testing Decisions

### What makes a good test here

Unchanged, and it governs: **assert on rendered UI and on file contents, never on internal call sequences, private state or module structure.** A test that survives moving a component between packages and fails when a Reader's Layer card stops rendering is a good test. A test asserting that `LayerList` is imported from `@ballastella/ui` is not.

**The mutation check is mandatory.** Every assertion rewired here must be shown to go red when the behaviour it claims to cover is broken. This epic is unusually exposed to vacuous green, because most of its claims are about something being *absent*.

### The seam each claim belongs at

**Seam 3 — component and DOM, in Node — is the home for nearly all of it.** Mounting one component against props is exactly the shape of this epic's subject: what a card renders, whether a row expands, whether `aria-expanded` follows the selection, whether focus stays put, whether the viewer's prop set produces a card with no rename button. Prior art is `layer-list.dom.test.ts` with `LayerListHarness.svelte`, and `annotation-layer-contents.dom.test.ts` — including the harness pattern, which exists because a component that calls back and waits for new props cannot be driven honestly from a test body.

**This seam must gain a home in `packages/ui`.** It lives in `apps/editor` today. A shared component tested from the app it used to live in is tested through a consumer, and the second consumer is then untested or duplicated.

**The paired prop-set test is the shape that matters.** For every affordance the viewer removes, one test mounts the component with the editor's props and asserts the control is **present**, and mounts it with the viewer's props and asserts it is **absent**. An absence asserted alone passes when the test id is renamed; asserted against its own positive control, it cannot.

**Seam 2 — Playwright — keeps only what needs the real application:**

- the published viewer really renders the shared card, in a real build served over HTTP;
- no editing affordance is reachable in the published build — the absence claim, made once against the thing that actually ships;
- the leader lands on the right row for a pin at a known projected point, which needs real MapLibre;
- an untrusted description is inert **in the row**, which is the moved half of `viewer-reader.e2e.ts`'s existing popup claim;
- a session that only looks leaves every file byte-identical.

**Seam 1 — pure Vitest over the in-memory store — keeps** anything that turns out to be a pure function. Ordinals are computed from a collection's order and can be asserted here rather than through a DOM.

### The Seam 2 budget

`scripts/check-seam-2-size.mjs` caps the number of browser tests and runs in `pnpm lint`. New Seam 2 tests here are therefore paid for, and retiring `ReaderLayerControls`' browser coverage should leave the count **lower** than it started. Record the before and after; a ticket that raises the ceiling has to argue for it.

### Fences

- `scripts/check-viewer-deps.mjs` keeps working and keeps walking every reachable manifest — including the new package's.
- A new check: **nothing in `packages/ui` may import from `apps/*`.** A shared package that reaches back into a consumer is not shared.
- The ADR-0006 absolute-path scan and the deploy-artifact checks in `.github/workflows/` read built output and stay there.

## Out of Scope

- **The other two directions.** Atlas (full-bleed canvas, floating panels) and Ledger (three panes, a reading pane instead of a popup) are not being built. Neither is Rail, which was not shortlisted.
- **Apparatus's typography.** No serif, no new type scale, no plate captions. The type system is whatever daisyUI's theme already gives.
- **The future Layer-sidebar metadata.** The leader joins an Annotation to its row and a Control Point to its row, and nothing else. Connecting a Layer to descriptive metadata is the thing this makes possible later; it is not this.
- **Any change to files on disk.** No `formatVersion`, no storage layout, no Project or Alignment or GeoJSON shape.
- **The Base Map catalog, publishing, the remote flows, transfer, offline caching.** Untouched except where they render through a component that moved.
- **The image-pane developer harness** keeps its current appearance.
- **Retiring the viewer's unwarped document view** or its `triiiceratops` dependency.
- **The editor's own information architecture.** No route is added or removed; nothing moves between screens. This epic changes what the screens are made of, not what is on them.

## Further Notes

The three directions and their trade-offs were drawn across all four screens before this was chosen, at
<https://claude.ai/code/artifact/ed770a5f-59e1-41bb-8cb3-9da7c21ceced>. Two findings from that work are
worth keeping here, because they will otherwise be re-derived:

**All three directions converged on `/align`** — two panes and a docked column on the right — by three
different arguments. So the alignment route is nearly free whichever shell is chosen, and it was
correctly not the screen that decided this.

**The measured canvas width at 1120 px** was Atlas 1120, Stack 797, Ledger 492. Stack was chosen partly
on that number: it is the only one of the three that gives the map most of the screen without giving up
a permanent sidebar.

**Why the row-disclosure change was made to Stack.** The direction as drawn kept the Annotation editor as
a separate box below the list, which is what the editor does today. The change moves it inside the row so
that "which Annotation is active" is a fact about the shape of the sidebar rather than a thing to work
out — and it makes the leader line's job smaller, which is what allows the leader to be sequenced last
and dropped if it proves unstable.

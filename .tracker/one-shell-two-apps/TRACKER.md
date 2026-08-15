# Tracker for one-shell-two-apps

## Purpose

This document tracks the status of all tickets in the epic.

The editor and the published viewer are two implementations of one idea, and a scholar does not
recognise their own Project once it is published. This epic puts both apps on **one set of Svelte
components and one stylesheet** — the *Stack* shell — so that the viewer is the editor with the
editing passed out rather than a second interface that resembles it. Within that, an Annotation's
details move inside its own row as an animated disclosure, and everything on a canvas gains an
ordinal joined to its row by a leader.

The spec is [SPEC.md](./SPEC.md). Every one of its 70 user stories is claimed by at least one ticket
below.

## Current Status

Overall status: `In Progress`

Current ticket: 08 (wave 5), 11 (in review)

Last updated: 2026-08-14

## Ledger

| Number | Filename | Status | Depends On | Claimed By |
| --- | --- | --- | --- | --- |
| 01 | [01-an-annotation-opens-in-its-own-row.md](./tickets/01-an-annotation-opens-in-its-own-row.md) | Completed | — | — |
| 02 | [02-a-shared-ui-package-proved-by-the-base-map-switcher.md](./tickets/02-a-shared-ui-package-proved-by-the-base-map-switcher.md) | Completed | — | — |
| 03 | [03-one-bar-shell-and-the-viewer-gets-a-navigation-bar.md](./tickets/03-one-bar-shell-and-the-viewer-gets-a-navigation-bar.md) | Completed | 02 | — |
| 04 | [04-the-layer-card-moves-to-the-shared-package.md](./tickets/04-the-layer-card-moves-to-the-shared-package.md) | Completed | 02 | — |
| 05 | [05-the-readers-stack-becomes-the-layer-card.md](./tickets/05-the-readers-stack-becomes-the-layer-card.md) | Completed | 04 | — |
| 06 | [06-a-reader-reads-an-annotation-in-its-row.md](./tickets/06-a-reader-reads-an-annotation-in-its-row.md) | Completed | 01, 05 | — |
| 07 | [07-the-map-popup-retires-on-the-project-screen.md](./tickets/07-the-map-popup-retires-on-the-project-screen.md) | Not Started | 06 | — |
| 08 | [08-annotations-are-numbered-on-the-map-and-on-the-row.md](./tickets/08-annotations-are-numbered-on-the-map-and-on-the-row.md) | In Progress | 06 | run-epic wave 5 |
| 09 | [09-the-hub-and-the-front-page-are-one-list.md](./tickets/09-the-hub-and-the-front-page-are-one-list.md) | Completed | 02 | — |
| 10 | [10-the-alignment-route-joins-the-shell.md](./tickets/10-the-alignment-route-joins-the-shell.md) | Not Started | 03, 08 | — |
| 11 | [11-the-map-panes-notices-are-one-component.md](./tickets/11-the-map-panes-notices-are-one-component.md) | In Progress | 05 | run-epic wave 4 |
| 12 | [12-the-leader-line.md](./tickets/12-the-leader-line.md) | Not Started | 08, 10 | — |

## Notes on the shape of this epic

**Two tickets can start immediately, and they do not touch each other.** 01 is the interaction change
inside the editor's Annotation surface; 02 creates `packages/ui` and proves it with one small
component. Neither blocks the other, and starting both first de-risks the two things most likely to
go wrong — a novel interaction, and a new package boundary.

**04 is a deliberate prefactor.** It moves the Layer card and makes every editing prop optional while
changing nothing a user sees. Make the change easy, then make the easy change: 05 is then a small
ticket that deletes `ReaderLayerControls` and passes fewer props.

**Two decisions taken during slicing, recorded here because they contradict a naive reading of the
spec's "what moves" table:**

- **The navigation bar does not move wholesale.** It carries the Workspace switcher, remote settings
  and the PWA install offer, and moving it would put all of that in the viewer's reachable graph.
  What is shared is a bar *shell* with slots; each app supplies its own items. See ticket 03.
- **The Annotation surface does not move wholesale either.** It imports `PlaceSearch`, and a
  Published Site quietly issuing place lookups is what ADR-0029 is written against. The list and the
  row are shared; the tools and the search stay editor snippets. See ticket 06.

**The `.pane-overlay-point-*` rules stay in the editor's stylesheet**, not the shared one: the viewer
draws no Control Points and no Resource Mask handles, and shipping rules for a screen no Reader can
reach is the growth ADR-0019 makes a dependency-graph property. See ticket 02.

**Story 52 is only partly delivered, and that is a recorded decision rather than an oversight.** The
story asks for a Project card carrying "its folder, its Layer count and when it was last saved". The
folder and the last-saved line are there; **the Layer count was never built**, in this epic or before
it, and none of ticket 09's acceptance criteria asked for one. The Contract's "offline availability"
line is likewise unbuilt and has no defined source of truth. Both were left alone deliberately: a
Layer count on the Hub would mean reading every Project's `project.json` on a screen that currently
does no per-Project read. See ticket 09.

**12 is droppable.** The leader line is the most expensive feature here and the last one sequenced.
The ordinal (08) and the open row (01) carry its meaning on their own, so a ticket that runs into
trouble with the projection maths can be stopped without invalidating anything before it.

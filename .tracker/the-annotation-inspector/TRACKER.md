# Tracker for the-annotation-inspector

## Purpose

This document tracks the status of all tickets in the epic.

An Annotation's content is read beside the map rather than inside its row. The left column keeps what
a Layer owns — membership in a group that can be shown, hidden, ordered and deleted — and an
Annotation's title, description and style move to the **Annotation Inspector**, a panel docked over
the map pane's top-right, as tall as its own content. In the editor it has a Text face and a Style
face, and styling is always a deliberate press away; in the viewer it has one face, so there is no tab
strip at all. Every difference between the two apps is an absent callback or an unpassed snippet.
Alongside it, `New Annotation` stops being a mode and becomes an action: one press, one Annotation,
and finishing a shape returns everything to rest.

The spec is [SPEC.md](./SPEC.md). All 75 of its user stories are claimed by exactly one ticket below.

⚠ **This epic reverses `one-shell-two-apps` ticket 01** — the decision that an Annotation's details
open *inside* its own row, argued at length in `AnnotationRow.svelte`'s header. Ticket 01 here writes
the ADR that replaces that reasoning, and it blocks the two tickets that perform the reversal.

## Current Status

Overall status: `In Progress`

Current ticket: 05

Last updated: 2026-08-17

## Ledger

| Number | Filename | Status | Depends On |
| --- | --- | --- | --- |
| 01 | [01-record-the-reversal.md](./tickets/01-record-the-reversal.md) | Completed | — |
| 02 | [02-the-selected-row-is-unmistakable.md](./tickets/02-the-selected-row-is-unmistakable.md) | Completed | — |
| 03 | [03-new-annotation-becomes-an-action.md](./tickets/03-new-annotation-becomes-an-action.md) | Completed | — |
| 04 | [04-zoom-moves-to-the-bottom-left.md](./tickets/04-zoom-moves-to-the-bottom-left.md) | Completed | — |
| 05 | [05-the-inspector-proved-at-the-component-seam.md](./tickets/05-the-inspector-proved-at-the-component-seam.md) | In Progress | 01 |
| 06 | [06-an-author-reads-and-writes-in-the-inspector.md](./tickets/06-an-author-reads-and-writes-in-the-inspector.md) | Not Started | 01, 02, 03, 04, 05 |
| 07 | [07-the-inspector-never-hides-the-mark.md](./tickets/07-the-inspector-never-hides-the-mark.md) | Not Started | 06 |
| 08 | [08-a-reader-reads-in-the-same-inspector.md](./tickets/08-a-reader-reads-in-the-same-inspector.md) | Not Started | 06 |
| 09 | [09-both-apps-stack-on-a-phone.md](./tickets/09-both-apps-stack-on-a-phone.md) | Not Started | 06, 08 |

## Notes on the shape of this epic

**Four tickets are on the frontier from the start** and none of them touches another's files: 01 is two
markdown documents, 02 is the selection mark on the shared row, 03 turns *New Annotation* into an
action inside the editor's drawing surface, and 04 moves a MapLibre control in three panes. Starting
them in parallel de-risks 06, which is the epic's one large ticket.

**02, 03 and 04 are deliberate prefactors.** Each one makes 06 smaller: 02 settles the row's selection
mark so 06 does not restyle a row while also moving a panel across the screen; 03 deletes the
`choosing` branch from the file 06 rewrites; 04 empties the corner 06 docks into. Make the change easy,
then make the easy change.

**05 → 06 → 08 is expand–contract on a shared component.** 05 adds `AnnotationInspector` beside the
existing disclosure without either app rendering it. 06 switches the editor over while the viewer keeps
passing `contents`, so both apps stay green. 08 switches the viewer and then deletes `contents`,
`keepInView`, `scrollSettled`, `scrollingAncestor`, the slide and `data-reveal-ms`. Deleting any of that
before 08 breaks the viewer.

**07 is separate from 06 because of where its claims can live.** Camera padding, the height cap with
internal scroll, and the leader's z-order under the panel all need a real MapLibre in a real viewport.
Bundling them into 06 would have made one ticket that could not land.

**05 carries the parity proof, and that is why it exists as its own ticket.** `apps/viewer` has no unit
tests at all, so "the viewer offers none of this" is either asserted at the component seam — the
Inspector's `style` snippet withheld, no tab strip in the DOM — or it can only be asserted against a
built browser. The epic adds **no new kind of seam**; 05 adds one harness at a seam that already exists.

**Two things ticket 01's ADR must not skip**, because they are the reasons the reversal is defensible
rather than merely decided: what moored the details when they were inside the row, and what moors them
now that they are not — the leader, and the ordinal repeated in the Inspector's header from the shared
name rules.

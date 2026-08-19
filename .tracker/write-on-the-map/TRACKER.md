# Tracker for write-on-the-map

## Purpose

This document tracks the status of all tickets in the epic.

A fourth Annotation: the **Label**. A scholar picks *Label* from the drawing tools, clicks a place on
the earth, and types — and the words are drawn on the map there, in a colour they choose, on a
background colour they choose, at one of three sizes. A Label is a Point whose simplestyle
`marker-symbol` is `"label"`, so the file format gains nothing: the words are `title`, the text
colour is `marker-color`, the background is `fill` and `fill-opacity`, and the three sizes are
`marker-size`, whose values simplestyle already names `small`, `medium` and `large`. ADR-0009 gains a
note recording the convention rather than an amendment.

The spec is [SPEC.md](./SPEC.md).

✅ **The background chip is proved.** Ticket 01 drew a stretched SDF chip in a browser at all three
sizes, both text lengths and two colours: the corners keep their radius and `icon-color` tints one
registered image per feature, so the epic takes the spec's **primary** design and not the contingency.
Its `## Answer` also records two things ticket 02 must get right — the distance field's edge belongs at
alpha 192/256 rather than at the halfway value `pin-icon.ts` uses, and `content`/`stretchX`/`stretchY`
are in the image's own pixels.

⚠ **Labels are the first Annotation that needs the Base Map's glyphs.** The viewer strips `glyphs`
and drops every `symbol` layer on a Published Site written without display assets, under a comment
asserting that nothing the Layer stack draws needs them. That comment becomes false the day this
ships, as does the notice promising a Reader that the Annotations are unaffected.

## Current Status

Overall status: `In Progress`

Current ticket: 03 and 09 (frontier)

Last updated: 2026-08-19

## Ledger

| Number | Filename | Status | Depends On |
| --- | --- | --- | --- |
| 01 | [01-prove-the-background-chip.md](./tickets/01-prove-the-background-chip.md) | Completed | — |
| 02 | [02-a-label-in-a-layer-is-drawn.md](./tickets/02-a-label-in-a-layer-is-drawn.md) | Completed | 01 |
| 03 | [03-place-a-label-and-type-its-words.md](./tickets/03-place-a-label-and-type-its-words.md) | Not Started | 02 |
| 04 | [04-style-a-label.md](./tickets/04-style-a-label.md) | Not Started | 03 |
| 05 | [05-the-labels-text-face.md](./tickets/05-the-labels-text-face.md) | Not Started | 03 |
| 06 | [06-a-label-is-an-ordinary-annotation.md](./tickets/06-a-label-is-an-ordinary-annotation.md) | Not Started | 03, 04, 05 |
| 07 | [07-a-label-is-a-file-other-tools-can-read.md](./tickets/07-a-label-is-a-file-other-tools-can-read.md) | Not Started | 03 |
| 08 | [08-a-published-site-draws-labels.md](./tickets/08-a-published-site-draws-labels.md) | Not Started | 04, 05 |
| 09 | [09-a-site-without-typefaces-says-so.md](./tickets/09-a-site-without-typefaces-says-so.md) | Not Started | 02 |

Ticket 01 is a spike: its product is an `## Answer` recording whether the chip is a stretched SDF
coloured per feature or one plain image per colour, and it leaves `src/` unchanged. Every ticket that
draws a Label sits behind it.

All 65 of the spec's user stories are claimed by exactly one ticket. Ticket 01 claims none, which is
what a spike is.

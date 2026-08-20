# Tracker for sidereal-ruled

## Purpose

This document tracks the status of all tickets in the epic.

Both apps shipped on stock daisyUI with no font declaration anywhere in the repository. This epic
installs the generated theme ADR-0016 always named: the **Sidereal** palette, **Bluu Next over
Instrument Sans** self-hosted at 119 KB, and the **Ruled** structural position — square structure,
soft controls, hairlines defined as a mix against `base-content` because `base-300` is also a ground.
Two rules travel with it and are enforced everywhere: no left border for emphasis or selected status,
and no monospaced face at all.

Alongside the theme it fixes the five arrangements a palette cannot reach — the navigation bar's flat
source order, the workspace menu that is half a settings panel, a Publish modal starved inside
daisyUI's 32rem box, Workspace settings' flat six concerns, and an align sidebar arguing in 400 words
where the delete control is a ghost `btn-xs` — and turns the Workspace Home into two columns drawing
one card component in both apps.

The Project page's layout is **not** touched: it takes the tokens and nothing else.

The spec is [SPEC.md](./SPEC.md); the design reference is
[ADR-0036](../../docs/adr/0036-sidereal-ruled-the-generated-theme-and-two-rules-about-marking.md).

All 78 of the spec's user stories are claimed by exactly one ticket below, checked both ways: every
story appears on a ticket, and every story cited on a ticket exists in the spec, with its text
matching verbatim.

**Ticket 01 is the wide one and it is not a vertical slice by choice.** The theme, the two faces and
the two marking rules are one stylesheet change with codebase-wide blast radius and no markup, and
every other ticket is drawn inside it — so building a surface before it lands means building that
surface twice. It carries 27 stories for that reason.

**Two tickets are takeable immediately: 01 and 08.** Ticket 08 is independent of the theme because it
moves one element in a flex column and unifies one z-index.

⚠ **Ticket 01 corrects the font path this epic was designed with.** `paths: { relative: true }` is
mandatory under ADR-0006 because the publish target is unknown at build time, so an absolute
`url('/fonts/…')` 404s on every site published into a subdirectory. The files live in
`packages/ui/src/fonts/` and are referenced relatively from `packages/ui/src/layout.css`, which is one
copy in the repository rather than two under `static/`.

## Current Status

Overall status: `In Progress`

Current ticket: 05 and 03 (in parallel); 01, 02, 06 and 08 completed

Last updated: 2026-08-19

## Ledger

| Number | Filename | Status | Depends On | Claimed By |
| --- | --- | --- | --- | --- |
| 01 | [01-the-theme-the-faces-and-the-two-marking-rules.md](./tickets/01-the-theme-the-faces-and-the-two-marking-rules.md) | Completed | — | run-epic/01 |
| 02 | [02-workspace-settings-becomes-three-groups.md](./tickets/02-workspace-settings-becomes-three-groups.md) | Completed | 01 | run-epic/02 |
| 03 | [03-the-workspace-menu-answers-one-question.md](./tickets/03-the-workspace-menu-answers-one-question.md) | In Progress | 01, 02 | run-epic/03 |
| 04 | [04-the-navigation-bar-becomes-two-tiers.md](./tickets/04-the-navigation-bar-becomes-two-tiers.md) | Not Started | 01, 03 | — |
| 05 | [05-workspace-home-becomes-two-columns.md](./tickets/05-workspace-home-becomes-two-columns.md) | In Progress | 01 | run-epic/05 |
| 06 | [06-publish-becomes-a-receipt.md](./tickets/06-publish-becomes-a-receipt.md) | Completed | 01 | run-epic/06 |
| 07 | [07-the-align-sidebar-puts-the-points-first.md](./tickets/07-the-align-sidebar-puts-the-points-first.md) | Not Started | 01, 05 | — |
| 08 | [08-the-project-pages-furniture.md](./tickets/08-the-project-pages-furniture.md) | Completed | — | run-epic/08 |

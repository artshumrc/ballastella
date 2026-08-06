# Tracker for workspace-and-layers

## Purpose

This document tracks the status of all tickets in the epic. The goal of `workspace-and-layers` is to reshape Ballastella around one working screen and one shared pool of material: a Project is a Base Map with a Layer sidebar and the scholar stays there; Historical Maps and their Alignments belong to the Workspace so one map is prepared and aligned once and used by any number of Projects; a map on a Library's server can be aligned in place; the Base Map opens on the scholar's own work and is cached offline only when asked for; and backup, handoff, and review become three distinct, honest artefacts. Scope, decisions, and testing approach are in [SPEC.md](./SPEC.md); the reasoning behind individual decisions is in [docs/adr](../../docs/adr) — principally [ADR-0023](../../docs/adr/0023-historical-maps-and-alignments-live-in-the-workspace.md), [ADR-0024](../../docs/adr/0024-backup-and-handoff-are-different-artefacts.md), [ADR-0025](../../docs/adr/0025-no-base-map-ships-offline-is-per-project-and-opt-in.md), and [ADR-0026](../../docs/adr/0026-the-opening-view-is-computed-from-the-projects-content.md) — and vocabulary is in [CONTEXT.md](../../CONTEXT.md).

## Current Status

Overall status: `In Progress`

Current ticket: **09 is in progress.** 01, 02, 03 and 08 are done; 03 is reconciled onto 02 and awaiting merge.

This epic follows [`ballastella-v1`](../ballastella-v1/TRACKER.md), whose implementation is complete and merged. Two things carry across and should be read before any ticket is written:

- **Four of v1's open questions are closed by this epic**, three of them by deletion rather than by answer — the Layer tombstone, `fflate`'s entry ceiling, ADR-0005's `terra-draw` mandate, and ADR-0013's unwritable `polynomial1` literal. The rest remain v1's and are untouched here; ADR-0025's build-fence pattern is a useful precedent for the canonical-URL question, which is the same shape.
- **v1's finding about green tickets holds and should be assumed to hold again.** Every reviewed v1 ticket yielded substantive defects after its implementer reported all criteria passing, including data loss in three tickets and three criteria passing *vacuously* — delete the code under test, tests stay green. The mutation check is therefore mandatory in this epic rather than advisory: break the behaviour, confirm the test goes red.

Two sequencing notes for whoever breaks this into tickets:

- **The rooting of `createStoreImageFetch` is the riskiest change in the epic** and should land early, alone, and behind the new lint fence. It is the ADR-0011 injection shim resolving the ADR-0004 placeholder, which v1's SPEC calls the most fragile invariant in the project, and its failure mode is a plausible pane of the wrong map rather than an error.
- **Two claims in the spec rest on documentation, not measurement**, and no ticket may commit to them unverified: `modern-tar`'s streaming and PAX behaviour, and the tile counts and byte totals for a realistic Project extent. The tar claim carries more weight — ADR-0024 justifies the entire format change on it.

Last updated: 2026-08-06

## Ledger

`Fulfills` lists the [SPEC.md](./SPEC.md) user stories a ticket delivers.

| Number | Filename | Status | Depends On | Fulfills |
| --- | --- | --- | --- | --- |
| 01 | [01-historical-maps-move-to-the-workspace.md](./tickets/01-historical-maps-move-to-the-workspace.md) | Completed | — | 61, 62, 66, 67 |
| 02 | [02-a-layer-is-created-when-a-map-is-added.md](./tickets/02-a-layer-is-created-when-a-map-is-added.md) | Completed | 01 | 18, 34, 35, 68 |
| 03 | [03-aligning-becomes-its-own-route.md](./tickets/03-aligning-becomes-its-own-route.md) | Completed | 01 | 37, 38, 41–55, 57–60 |
| 04 | [04-the-project-screen-replaces-the-project-page.md](./tickets/04-the-project-screen-replaces-the-project-page.md) | Not Started | 03 | 1, 2, 3, 10–13, 109, 110 |
| 05 | [05-the-layer-sidebar-opens-one-layer-at-a-time.md](./tickets/05-the-layer-sidebar-opens-one-layer-at-a-time.md) | Not Started | 02, 04 | 14–17, 20 |
| 06 | [06-add-a-historical-map-from-three-sources.md](./tickets/06-add-a-historical-map-from-three-sources.md) | Not Started | 02, 05 | 21–30, 33, 36, 106 |
| 07 | [07-align-a-referenced-historical-map-in-place.md](./tickets/07-align-a-referenced-historical-map-in-place.md) | Not Started | 06 | 31, 32, 39, 40, 56, 80, 81 |
| 08 | [08-the-workspaces-historical-maps-on-the-hub.md](./tickets/08-the-workspaces-historical-maps-on-the-hub.md) | Completed | 01 | 23, 63, 64, 65, 98 |
| 09 | [09-the-project-opens-on-its-own-content.md](./tickets/09-the-project-opens-on-its-own-content.md) | In Progress | 01 | 4, 5, 7, 8, 9, 100 |
| 10 | [10-no-base-map-ships.md](./tickets/10-no-base-map-ships.md) | Not Started | 09 | 74, 102, 103 |
| 11 | [11-make-a-project-available-offline.md](./tickets/11-make-a-project-available-offline.md) | Not Started | 08, 10 | 6, 69–73, 75–79, 97, 99 |
| 12 | [12-the-opfs-root-holds-several-named-workspaces.md](./tickets/12-the-opfs-root-holds-several-named-workspaces.md) | Not Started | 04 | 88, 105, 107, 108 |
| 13 | [13-back-up-and-restore-a-workspace-as-a-tar.md](./tickets/13-back-up-and-restore-a-workspace-as-a-tar.md) | Not Started | 01, 12 | 82–87 |
| 14 | [14-hand-off-a-project-and-review-one.md](./tickets/14-hand-off-a-project-and-review-one.md) | Not Started | 13 | 89–95 |
| 15 | [15-remove-the-editors-unwarped-view.md](./tickets/15-remove-the-editors-unwarped-view.md) | Not Started | 07 | 101 |
| 16 | [16-the-offline-copy-has-one-name.md](./tickets/16-the-offline-copy-has-one-name.md) | Not Started | 02, 03, 09 | — |
| 17 | [17-the-e2e-suite-tells-the-truth.md](./tickets/17-the-e2e-suite-tells-the-truth.md) | Not Started | 02, 03, 09 | — |
| 18 | [18-a-shared-alignment-is-not-overwritten-by-accident.md](./tickets/18-a-shared-alignment-is-not-overwritten-by-accident.md) | Not Started | 02, 03 | 60 |

**16, 17 and 18 were added during implementation, not planning.** They are debt the epic's own reviews surfaced. 16 is a rename the ubiquitous language already mandates and the code never did. 17 is the e2e suite, which flakes at roughly one run in three and therefore cannot be trusted to catch the races this epic keeps finding.

**18 is the important one.** ADR-0023 made an Alignment shared by every Project that uses its map, and nothing was changed to reflect what that means for a *write*. Tickets 02 and 03 then **independently invented the same blind overwrite**, and in ticket 02's case the correct guard sits two lines from the hole. Two authors reaching for the same mistake is a missing invariant, not two lapses, and the failure mode is ticket 01's: no error, no log, just a colleague's Control Points quietly gone. Each branch fixes its own instance; 18 makes a third impossible.

**Stories 111–114 are deliberately absent from the table.** Visible text rather than tooltips, screen-reader announcement of what the map does, no silent service-worker activation, and the refusal of a newer `formatVersion` are **cross-cutting constraints inside every ticket that adds UI**, the same treatment v1 gave accessibility. Attributing them to one ticket would be misleading in both directions. Story 96 — publishing from one place — is already built and only has to keep working; several tickets assert that it does.

## Critical path

01 → 03 → 04 → 05 → 06 → 07 → 15 is the long chain, seven deep. Three tickets hang off 01 directly and can run beside it once it lands: 02, 08, and 09. The Base Map pair (10, 11) and the transfer pair (13, 14) are each two-deep tails that join late.

**Ticket 01 gates almost everything and is the largest and riskiest of the fifteen.** It relocates `images/` and `alignments/` to the Workspace root, reshapes `MapLayer`, deletes `imageMode` and the half-committed-copy repair path, and roots `createStoreImageFetch` at the Workspace — the ADR-0011 shim whose failure mode is a pane showing the *wrong map* rather than an error. It was deliberately not split: the blast radius is dozens of call sites rather than thousands, so expand–contract would cost more than it saved, and nothing is deployed so the tests move with it. It is nonetheless the ticket most likely to exceed a single context window, and the new lint fence it adds is what protects every later ticket from silently reintroducing a Project-rooted path.

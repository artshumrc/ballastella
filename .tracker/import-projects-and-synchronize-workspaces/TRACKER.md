# Tracker for import-projects-and-synchronize-workspaces

## Purpose

This document tracks the implementation of detached Project Import and explicit whole-Workspace synchronization with a Remote.

See [SPEC.md](./SPEC.md), [ADR-0037](../../docs/adr/0037-import-copies-a-project-into-the-current-workspace.md), and [ADR-0038](../../docs/adr/0038-workspace-synchronization-is-explicit-and-baseline-based.md).

## Current Status

Overall status: `Not Started`

Current ticket: — tickets 01 and 03 are on the frontier

Last updated: 2026-08-20

## Ledger

| Number | Filename | Status | Depends On |
| --- | --- | --- | --- |
| 01 | [01-establish-installation-local-sync-evidence.md](./tickets/01-establish-installation-local-sync-evidence.md) | Not Started | — |
| 02 | [02-separate-sync-source-from-published-output.md](./tickets/02-separate-sync-source-from-published-output.md) | Not Started | 01 |
| 03 | [03-extract-read-only-project-import-sources.md](./tickets/03-extract-read-only-project-import-sources.md) | Not Started | — |
| 04 | [04-commit-project-imports-atomically.md](./tickets/04-commit-project-imports-atomically.md) | Not Started | 03 |
| 05 | [05-recover-interrupted-project-imports.md](./tickets/05-recover-interrupted-project-imports.md) | Not Started | 04 |
| 06 | [06-remap-imported-project-closures.md](./tickets/06-remap-imported-project-closures.md) | Not Started | 03, 04 |
| 07 | [07-allocate-import-names-without-collisions.md](./tickets/07-allocate-import-names-without-collisions.md) | Not Started | 06 |
| 08 | [08-record-import-provenance-and-publication-state.md](./tickets/08-record-import-provenance-and-publication-state.md) | Not Started | 03, 06 |
| 09 | [09-plan-workspace-synchronization.md](./tickets/09-plan-workspace-synchronization.md) | Not Started | 01, 02 |
| 10 | [10-track-local-changes-without-rehashing.md](./tickets/10-track-local-changes-without-rehashing.md) | Not Started | 01, 02, 09 |
| 11 | [11-open-a-workspace-from-github.md](./tickets/11-open-a-workspace-from-github.md) | Not Started | 01, 02, 09, 10 |
| 12 | [12-show-remote-status.md](./tickets/12-show-remote-status.md) | Not Started | 09, 10, 11 |
| 13 | [13-import-project-bundles-from-workspace-home.md](./tickets/13-import-project-bundles-from-workspace-home.md) | Not Started | 03, 04, 05, 06, 07, 08, 10 |
| 14 | [14-update-non-destructive-remote-changes.md](./tickets/14-update-non-destructive-remote-changes.md) | Not Started | 09, 10, 11, 12 |
| 15 | [15-update-deletions-atomically.md](./tickets/15-update-deletions-atomically.md) | Not Started | 14 |
| 16 | [16-make-publish-baseline-aware.md](./tickets/16-make-publish-baseline-aware.md) | Not Started | 09, 10, 12, 14 |
| 17 | [17-protect-bound-workspaces-during-import.md](./tickets/17-protect-bound-workspaces-during-import.md) | Not Started | 01, 02, 07, 09, 10, 13, 14 |
| 18 | [18-import-or-review-published-projects.md](./tickets/18-import-or-review-published-projects.md) | Not Started | 02, 03, 04, 05, 06, 07, 08, 11, 13, 17 |
| 19 | [19-import-the-current-reviewed-state.md](./tickets/19-import-the-current-reviewed-state.md) | Not Started | 01, 03, 04, 05, 06, 07, 08, 13 |
| 20 | [20-make-project-import-accessible.md](./tickets/20-make-project-import-accessible.md) | Not Started | 13, 18, 19 |
| 21 | [21-verify-sync-workflows-across-backings.md](./tickets/21-verify-sync-workflows-across-backings.md) | Not Started | 11, 12, 14, 15, 16, 20 |

## Ordering

Tickets 01 and 03 can start immediately. Ticket 01 establishes durable synchronization evidence; ticket 03 extracts the read-only Project closure boundary. Their lanes proceed independently until Import must reserve Remote directories and register local changes.

Tickets 02, 09, 10, 11, and 12 build the synchronization evidence, planner, affordable status, and Open flow. Tickets 04 through 08 build atomic detached Import without a UI. Ticket 13 is the first complete Project Bundle Import workflow.

Tickets 14 through 16 add inbound Update and make Publish consume the same Baseline. Ticket 17 then makes Import safe in a bound Workspace. Tickets 18 and 19 add the two remaining Project sources; ticket 20 completes Project Import accessibility. Ticket 21 is the final cross-backing and Seam 2 conformance gate.

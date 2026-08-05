# Tracker for ballastella-v1

## Purpose

This document tracks the status of all tickets in the epic. The goal of `ballastella-v1` is to deliver the first release of Ballastella: a browser application that aligns historical maps onto the modern world and annotates them, storing all work as standard-format files in a folder the user owns, and publishing that folder as a static website. Scope, decisions, and testing approach are defined in [SPEC.md](./SPEC.md); the reasoning behind individual decisions is in [docs/adr](../../docs/adr), and vocabulary is in [CONTEXT.md](../../CONTEXT.md).

## Current Status

Overall status: `Not Started`

Current ticket: none — ticket 01 is unblocked and ready to pick up.

Last updated: 2026-08-05

## Ledger

| Number | Filename | Status | Depends On |
| --- | --- | --- | --- |
| 01 | [01-monorepo-skeleton-and-toolchain.md](./tickets/01-monorepo-skeleton-and-toolchain.md) | Not Started | — |
| 02 | [02-workspace-and-project-lifecycle.md](./tickets/02-workspace-and-project-lifecycle.md) | Not Started | 01 |
| 03 | [03-image-pane-synthetic-projection.md](./tickets/03-image-pane-synthetic-projection.md) | Not Started | 01 |
| 04 | [04-base-map-pane-and-catalog.md](./tickets/04-base-map-pane-and-catalog.md) | Not Started | 01 |
| 05 | [05-local-image-to-level-0-pyramid.md](./tickets/05-local-image-to-level-0-pyramid.md) | Not Started | 02 |
| 06 | [06-injection-layer-local-tiles-to-renderers.md](./tickets/06-injection-layer-local-tiles-to-renderers.md) | Not Started | 03, 05 |
| 07 | [07-alignment-control-point-pairing.md](./tickets/07-alignment-control-point-pairing.md) | Not Started | 04, 06 |
| 08 | [08-alignment-refinement.md](./tickets/08-alignment-refinement.md) | Not Started | 07 |
| 09 | [09-layers.md](./tickets/09-layers.md) | Not Started | 07 |
| 10 | [10-annotations.md](./tickets/10-annotations.md) | Not Started | 09 |
| 11 | [11-single-level-undo.md](./tickets/11-single-level-undo.md) | Not Started | 08, 10 |
| 12 | [12-file-system-access-adapter.md](./tickets/12-file-system-access-adapter.md) | Not Started | 02 |
| 13 | [13-zip-export-and-import.md](./tickets/13-zip-export-and-import.md) | Not Started | 02 |
| 14 | [14-remote-iiif-ingest.md](./tickets/14-remote-iiif-ingest.md) | Not Started | 09 |
| 15 | [15-mirroring-offline-copies.md](./tickets/15-mirroring-offline-copies.md) | Not Started | 05, 14 |
| 16 | [16-publish.md](./tickets/16-publish.md) | Not Started | 09, 10 |
| 17 | [17-viewer-read-only-exploration.md](./tickets/17-viewer-read-only-exploration.md) | Not Started | 16 |
| 18 | [18-pwa-manifest-and-service-worker.md](./tickets/18-pwa-manifest-and-service-worker.md) | Not Started | 16 |

## Sequencing notes

Ticket 01 is a prefactor and must land first: it fixes the commands (`pnpm -r test`, `pnpm test:e2e`, and the rest) that every other ticket's acceptance criteria are written against. In a greenfield repo nothing else can have runnable criteria until it exists.

**After 01, three tickets run in parallel: 02, 03, and 04.** Ticket 03 is deliberately unblocked by the storage work so the project's largest unknown can be attacked immediately — see below. The long pole is 01 → 04 → 07 → 09 → 10 → 16 → 17.

### The four risk items, and where they live

The spec's build order is dictated by risk, not feature order. Each of these produces a number or a validation that later tickets depend on:

1. **The synthetic projection for the image pane** — ticket 03. The largest unknown, and its failure is *silent*: Control Points that drift as the user zooms. Must land with a numeric pixel → lng/lat → pixel round-trip assertion at every zoom level. Visual confirmation does not satisfy it.
2. **The `createImageBitmap` decode ceiling** — ticket 05. The measured number sets the `wasm-vips` threshold and cannot be guessed. It must be recorded with browser and method, since it cannot be re-derived from the code.
3. **A generated `info.json` validated against Allmaps end to end** — ticket 05, before anything is built on the pyramid format.
4. **`@allmaps/*` fixture round-trips** — ticket 07. Every one of those packages is pre-1.0, so this test is what stands between a beta bump and every Alignment in the field being subtly misplaced.

### Cross-cutting constraints

These will otherwise be rediscovered, or missed, per ticket:

- **`ProjectStore` is built OPFS-first**, before the File System Access adapter (ticket 12), so the abstraction is not shaped around one backend (ADR-0001). Ticket 12 must pass ticket 02's shared adapter suite *unchanged*; needing to widen the interface is a signal the interface was wrong, not that the adapter is special.
- **`apps/viewer` must never depend on `terra-draw`, the tiler, or `wasm-vips`** (ADR-0019). Ticket 01 adds a CI check; treat it as a standing review item, not a one-off.
- **Accessibility is an acceptance criterion inside every ticket that adds UI**, not a slice of its own. Keyboard reach, focus management, announced status, and ADR-0016's mandated component methods. A single accessibility pass at the end reliably becomes a graveyard.
- **Autosave lands in ticket 02**, not late, so tickets 05–15 do not each improvise their own saving and then get retrofitted — which is how ADR-0017's atomic-write rule quietly fails to happen.
- **Format migration is deliberately not a ticket.** Ticket 02 writes `formatVersion` and implements the *refusal* of anything newer, which is the part that protects users from old forks. Migration machinery with zero migrations would be speculative and untestable; the first real format change brings its own ticket.
- **Markdown sanitisation is asserted twice** — in ticket 10 where it is written, and again in ticket 17 where the viewer runs on the user's own domain. It is the one place in this epic where a bug is a security vulnerability rather than a defect.

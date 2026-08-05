# Ballastella

A browser-based tool for placing historical map images onto the modern world and annotating them, where a scholar's work lives as ordinary files they own rather than rows in someone else's database.

A **ballastella** — also Jacob's staff — is a graduated pole with a sliding crosspiece, used from the fourteenth century to measure the angular height of a star above the horizon and so establish one's position. It is the ancestor of the sextant. The name was chosen because a Control Point pair is a sighting: the user observes a feature on a historical map, observes the same feature on the earth, and the correspondence yields a position.

## Status

**Planning.** This repository currently holds the specification and the architectural record — no application code has been written yet. Work is tracked in [`.tracker/ballastella-v1/TRACKER.md`](.tracker/ballastella-v1/TRACKER.md).

## The idea

A historian has a photograph or scan of a historical map and wants to show where its places actually are on the earth, then write about them — labelling sites, tracing routes, outlining regions — and publish the result so colleagues and students can explore it.

Today that requires either specialist GIS software with a steep learning curve and no publishing story, or a hosted platform that takes custody of the work: the scholarship becomes a row in someone else's database, the output lives on someone else's domain, and nothing is portable.

Ballastella is a browser application at a stable address that reads and writes **a folder the user owns**. A user picks a Workspace directory once. Inside it, each Project is a directory holding its Historical Maps as level-0 IIIF tiles, its Alignments as IIIF Georeference Annotations, and its Annotations as GeoJSON — plain files in open formats, written as the user works.

Publishing writes a read-only viewer into the workspace. That workspace, pushed to any static host, *is* the website. No server, no build pipeline, no account.

## Repository layout

| Path | What it holds |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | The project's ubiquitous language — the terms the code and UI are required to use, and the near-synonyms to avoid |
| [`docs/adr/`](docs/adr) | Architectural decision records, referenced by number throughout the spec |
| [`.tracker/ballastella-v1/SPEC.md`](.tracker/ballastella-v1/SPEC.md) | The v1 specification: problem, solution, user stories, scope |
| [`.tracker/ballastella-v1/TRACKER.md`](.tracker/ballastella-v1/TRACKER.md) | Ticket ledger, status, and dependency ordering |
| [`.tracker/ballastella-v1/tickets/`](.tracker/ballastella-v1/tickets) | The 18 tickets that make up v1 |

Start with `CONTEXT.md`, then `SPEC.md`. The ADRs explain *why* rather than *what*, and are best read on demand when the spec cites one.

## Licence

MIT — see [LICENSE](LICENSE) and [ADR-0021](docs/adr/0021-mit-licence-and-gpl-hygiene.md) for the reasoning.

⚠️ **A note for contributors before you copy any code in:** the Allmaps repository's `apps/editor` and `apps/viewer` are **GPL-3.0** (its `packages/*` are MIT). Reading them to understand their architecture is fine and has been done deliberately. Lifting a function from them silently relicenses this project. See [ADR-0021](docs/adr/0021-mit-licence-and-gpl-hygiene.md).

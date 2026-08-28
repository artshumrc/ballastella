# Ballastella

A browser-based tool for placing map images onto the modern world and annotating them, where a scholar's work lives as ordinary files they own rather than rows in someone else's database.

A **ballastella** — also Jacob's staff — is a graduated pole with a sliding crosspiece, used from the fourteenth century to measure the angular height of a star above the horizon and so establish one's position. It is the ancestor of the sextant. The name was chosen because a Control Point pair is a sighting: the user observes a feature on a map image, observes the same feature on the earth, and the correspondence yields a position.

## Status

**v1 is built and driven end to end.** Images are tiled in the browser, aligned against the modern world, annotated, and published as a static site. One human decision — a Base Map archive this deployment controls — is outstanding; that and the other known gaps are in [`docs/hosting.md`](docs/hosting.md).

```sh
pnpm install
pnpm -r build && pnpm -r test && pnpm lint && pnpm check && pnpm test:e2e
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for what each command covers, and for the three rules the toolchain enforces on your behalf.

## Hosting your own instance

Fork this repository, set **Settings → Pages → Source** to **GitHub Actions**, and push. `.github/workflows/pages.yml` builds the editor and deploys it to `https://<you>.github.io/<your-fork>/`. No server, no account, no API key or secret — CI asserts the last of those.

Your users then publish their own work from their own folders to repositories they own. Both halves, including the Base Map archive you should point at your own tiles before telling anyone the instance is ready, are in [`docs/hosting.md`](docs/hosting.md).

## The idea

A historian has a Map Image — a photograph or scan of an old map — and wants to show where its places actually are on the earth, then write about them — labelling sites, tracing routes, outlining regions — and publish the result so colleagues and students can explore it.

Today that requires either specialist GIS software with a steep learning curve and no publishing story, or a hosted platform that takes custody of the work: the scholarship becomes a row in someone else's database, the output lives on someone else's domain, and nothing is portable.

Ballastella is a browser application at a stable address that reads and writes **a folder the user owns**. A user picks a Workspace directory once. Inside it, each Project is a directory holding its Map Images as level-0 IIIF tiles, its Alignments as IIIF Georeference Annotations, and its Annotations as GeoJSON — plain files in open formats, written as the user works.

Publishing writes a read-only viewer into the workspace. That workspace, pushed to any static host, *is* the website. No server, no build pipeline, no account.

## Repository layout

| Path | What it holds |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | The project's ubiquitous language — the terms the code and UI are required to use, and the near-synonyms to avoid |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to work here, the commands, and the GPL fence against the Allmaps applications |
| [`packages/core/`](packages/core) | `@ballastella/core` — domain model, `ProjectStore` and adapters, IIIF glue, alignment serialisation, annotation styling |
| [`apps/editor/`](apps/editor) | `@ballastella/editor` — the authoring app |
| [`apps/viewer/`](apps/viewer) | `@ballastella/viewer` — the lean read-only viewer written into published sites |
| [`e2e/`](e2e) | Playwright browser tests, run against both built apps |
| [`docs/hosting.md`](docs/hosting.md) | How to host an instance, and how a user publishes a Workspace as a site |
| [`docs/adr/`](docs/adr) | Architectural decision records — every decision that would otherwise be surprising, referenced by number throughout the code |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Layout, the toolchain rules, the test seams, the accessibility bar |

Start with `CONTEXT.md`, then `CONTRIBUTING.md`. The ADRs explain *why* rather than *what*, and are best read on demand when a module's comments cite one.

Work in flight is tracked in Botley rather than in this repository, and an Epic is deleted once it lands — so nothing here cites one. What a finished Epic leaves behind is the code, the glossary, this README, `CONTRIBUTING.md`, and an ADR wherever the decision was hard to reverse.

## Licence

MIT — see [LICENSE](LICENSE) and [ADR-0021](docs/adr/0021-mit-licence-and-gpl-hygiene.md) for the reasoning.

⚠️ **A note for contributors before you copy any code in:** the Allmaps repository's `apps/editor` and `apps/viewer` are **GPL-3.0** (its `packages/*` are MIT). Reading them to understand their architecture is fine and has been done deliberately. Lifting a function from them silently relicenses this project. See [ADR-0021](docs/adr/0021-mit-licence-and-gpl-hygiene.md).

# Contributing to Ballastella

Read [`CONTEXT.md`](CONTEXT.md) first. It defines the project's vocabulary — Workspace,
Project, Layer, Historical Map, Alignment, Control Point — and the near-synonyms to avoid.
The code and the UI are required to use those words, so a pull request that calls an
Alignment a "georeference" or a Control Point a "GCP" will be asked to change.

Then read [`.tracker/ballastella-v1/SPEC.md`](.tracker/ballastella-v1/SPEC.md). The
[ADRs](docs/adr) explain _why_ rather than _what_, and are best read on demand when the
spec cites one.

## ⚠️ Do not copy code from the Allmaps applications

**`apps/` in the Allmaps repository is GPL-3.0. `packages/*` is MIT.**

**Reading Allmaps Editor for architecture is fine.** It has been done deliberately —
particularly for the MapLibre image-pane projection, which is the hardest part of this
project. **Copying code from it silently relicenses this project.**

This is precisely what a well-meaning contributor does while "just fixing the projection
bug", and it is near-impossible to unwind afterwards. Ballastella is MIT because
[ADR-0021](docs/adr/0021-mit-licence-and-gpl-hygiene.md) commits us to upstreaming code
into [triiiceratops](https://github.com/wetterberg/triiiceratops), which is MIT: under
GPL-3.0 code could flow from triiiceratops into this app but never back out.

So: read it, understand it, then write it yourself. If you are unsure whether something you
wrote is too close, say so in the pull request rather than leaving it to be discovered.

New dependencies whose licence is not plainly permissive — and any dependency that ships a
compiled artefact under a different licence from its wrapper — need an entry in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Layout

```
packages/core          @ballastella/core — domain model, ProjectStore + adapters,
                       IIIF glue, alignment serialisation, annotation styling
apps/editor            @ballastella/editor — the authoring app
apps/viewer            @ballastella/viewer — the read-only viewer written into
                       published sites
e2e/                   Playwright browser tests, run against both built apps
scripts/               repository checks
```

One `core` package, deliberately, until a seam proves itself
([ADR-0019](docs/adr/0019-minimal-pnpm-monorepo.md)). `core` publishes its TypeScript source
rather than a build artefact, so there is no build step to keep in sync and no stale `dist`
to debug; the apps' bundlers compile it. That is why `core` has `check` and `test` scripts
but no `build`.

## Commands

| Command                              | Purpose                                        |
| ------------------------------------ | ---------------------------------------------- |
| `pnpm install`                       | install                                        |
| `pnpm -r build`                      | build all packages and apps                    |
| `pnpm -r test`                       | unit and integration tests (Vitest)            |
| `pnpm --filter @ballastella/core test` | core tests only                              |
| `pnpm test:e2e`                      | browser tests (Playwright, headless Chromium)  |
| `pnpm lint`                          | lint, format check, and the source fences      |
| `pnpm check:bundles`                 | ADR-0019 against built output (needs a build)  |
| `pnpm check`                         | Svelte and TypeScript checks                   |
| `pnpm format`                        | rewrite formatting in place                    |

CI runs all of them on every push.

## Three rules the toolchain enforces for you

**`apps/viewer` must never depend on `terra-draw`, the tiler, or `wasm-vips`**
([ADR-0019](docs/adr/0019-minimal-pnpm-monorepo.md)). The viewer is a separate build so that
its leanness is enforced by the dependency graph rather than by tree-shaking, because
tree-shaking is not a boundary: one incautious import and every published site silently
grows by megabytes, with no error and nobody looking. `scripts/check-viewer-deps.mjs` runs
as part of `pnpm lint` and fails if any of them appear in the viewer's manifest.

The tiler is not in a manifest — it lives inside `@ballastella/core`, which the viewer does
depend on — so `scripts/check-tiler-lazy.mjs` covers that half. It runs in `pnpm lint` over the
source (nothing under `packages/core/src` may name `wasm-vips`; nothing in `apps/editor/src` may
import it other than dynamically), and again as `pnpm check:bundles` **after `pnpm -r build`**,
where it walks the built editor's chunk graph and greps the built viewer for the tiler's own
string literals. Both halves fail if they find nothing to guard, because the check they replaced
— a `grep` for a module specifier that bundling resolves away — reported success unconditionally.

**No asset may be referenced by an absolute path.** `paths.relative: true` is set in both
apps' `svelte.config.js` and is mandatory
([ADR-0006](docs/adr/0006-the-project-directory-is-the-published-site.md)): the publish
target — a domain root or a project subdirectory — is unknown at build time. CI greps the
built output, because the config is not what ships.

**No module outside `packages/core/src/base-map/catalog.ts` may name a Base Map entry.** The
catalog is deployment configuration, and replacing it is the whole of pointing a fork at its own
tiles ([ADR-0020](docs/adr/0020-base-map-catalog-author-default-and-reader-switching.md)).
`scripts/check-base-map-catalog.mjs` runs as part of `pnpm lint` and fails if an entry id or an
archive appears anywhere else, because a special case keyed on one id still works perfectly on
this deployment and fails only on the fork, where nobody is looking. Tests are exempt: the
browser suite asserts that the switcher offers exactly this deployment's catalog, which it can
only do by naming it.

## Dependency versions

Shared versions live in the `catalog:` block of `pnpm-workspace.yaml`, not in individual
manifests, so both apps cannot drift apart and a bump is one visible diff.

**Every `@allmaps/*` entry is an exact version with no range specifier.** All of them are
pre-1.0, and an Allmaps upgrade is a migration event
([ADR-0010](docs/adr/0010-integer-format-version-with-forward-only-migrations.md)) — which
is what the committed alignment fixtures and their round-trip test exist to catch. Nothing
else is pinned exactly.

## Accessibility

A Harvard-hosted teaching tool is held to WCAG 2.1 AA, and interactive components are where
that is won or lost. [ADR-0016](docs/adr/0016-daisyui-only-with-mandated-component-methods.md)
**mandates a method per surface** rather than only a library, because daisyUI documents
several options per component and states no preference:

| Surface           | Mandated                                       |
| ----------------- | ---------------------------------------------- |
| Modal             | `<dialog>` + `showModal()` / `close()`         |
| Dropdown / menu   | Popover API (`popover` + `popovertarget`)      |
| Tabs              | radio inputs with `role="tablist"`             |
| Select            | native `<select>`                              |
| Opacity           | native `<input type="range">`                  |
| Status            | `aria-live="polite"` region                    |

Banned: the checkbox-hack modal, the anchor/hash modal, the `<details>` dropdown, and the
CSS-focus dropdown.

**Tooltips are not an information channel.** daisyUI renders them via CSS `::before`, so
they are neither announced nor dismissable. Anything a user needs is visible text or
`aria-describedby`.

Accessibility is an acceptance criterion inside every change that adds UI — keyboard reach,
focus management, announced status — not a pass at the end. A single accessibility pass at
the end reliably becomes a graveyard.

## Tests

[SPEC.md's Testing Decisions](.tracker/ballastella-v1/SPEC.md#testing-decisions) is binding.
The short version: **the user's folder is the product**, so "after this sequence of actions
the store contains these files with this content" is not a proxy for behaviour — it _is_ the
behaviour. Assert on file contents and on rendered UI, never on internal call sequences,
private state, or module structure. A test that would still pass after `core` is reorganised
and would fail if a user's Project stopped loading is a good test; a test asserting that a
particular function was called is not.

There are two seams and no others: an in-memory `ProjectStore` for application logic, and
Playwright against headless Chromium for the running app. There is deliberately no
map-abstraction layer — Playwright drives real MapLibre.

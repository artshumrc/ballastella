# 01 — Monorepo skeleton, toolchain, licence and third-party notices

## What to build

The empty-but-working repository that every later ticket builds inside: a pnpm workspace with one `core` package and two SvelteKit apps, a test runner, a browser test runner, linting, CI, and the licence files.

No product behaviour. The deliverable is that **the commands in every other ticket's acceptance criteria exist and pass** on an empty codebase. Each app boots and renders a placeholder page; `core` exports nothing yet but builds and runs an empty test suite.

**Fulfills** — [SPEC.md](../SPEC.md) user story 102. Lays the groundwork for 80, 99, and 101 (`paths.relative`, the static adapter, and a toolchain with no server or secrets); those are demonstrated in ticket 16.

## Where to start

Read [CONTEXT.md](../../../CONTEXT.md) for vocabulary, then [ADR-0019](../../../docs/adr/0019-minimal-pnpm-monorepo.md) (structure), [ADR-0021](../../../docs/adr/0021-mit-licence-and-gpl-hygiene.md) (licensing), [ADR-0016](../../../docs/adr/0016-daisyui-only-with-mandated-component-methods.md) (UI dependency), and the Testing Decisions section of [SPEC.md](../SPEC.md).

The Allmaps monorepo (`github.com/allmaps/allmaps`) is a useful reference for pnpm workspace and `catalog:` layout. **Read `packages/` only. `apps/` is GPL-3.0 and must not be copied** — see ADR-0021.

## Contract

Package names and structure, because every later ticket's commands reference them:

```
packages/core          → @ballastella/core
apps/editor            → @ballastella/editor    (the authoring app)
apps/viewer            → @ballastella/viewer    (the read-only viewer)
```

**Before relying on the `@ballastella` scope, confirm it is claimable on npm.** A 404 on `@ballastella/core` proves only that the *package* does not exist; publishing into a scope owned by someone else fails with a 403, and the two are indistinguishable from the outside. If the scope is taken, fall back to `@dflood/ballastella-{core,editor,viewer}` — a scope whose ownership is already established — and update the commands below to match. Decide this **now**: the package names appear in every later ticket's acceptance commands, so changing them after ticket 05 means touching a dozen tickets.

Both apps are SvelteKit with `@sveltejs/adapter-static`, Svelte 5, and:

```js
// svelte.config.js — mandatory, see ADR-0006
kit: { paths: { relative: true } }
```

`paths.relative` is required now rather than later because the publish target — domain root or project subdirectory — is unknown at build time, and retrofitting it means auditing every asset reference.

**Dependency versions go in a pnpm catalog**, not in individual manifests. This is how ADR-0010's exact-pinning requirement for `@allmaps/*` is expressed once for both apps. Every `@allmaps/*` entry is an **exact** version, no range specifier, because all of them are pre-1.0.

**`apps/viewer` must never depend on `terra-draw`, the tiler, or `wasm-vips`** (ADR-0019). Add a check that fails CI if it does — reading its manifest is sufficient; this does not need to be clever.

Test commands, fixed here and referenced by every later ticket:

| Command | Purpose |
|---|---|
| `pnpm install` | install |
| `pnpm -r build` | build all packages and apps |
| `pnpm -r test` | unit and integration tests (Vitest) |
| `pnpm --filter @ballastella/core test` | core tests only |
| `pnpm test:e2e` | browser tests (Playwright, headless Chromium) |
| `pnpm lint` | lint and format check |
| `pnpm check` | Svelte and TypeScript checks |

Files that must exist: `LICENCE` (MIT), `THIRD-PARTY-NOTICES.md`, and `CONTRIBUTING.md`.

`CONTRIBUTING.md` must contain the GPL fence in plain words, because it is the only place a contributor will encounter it: **`apps/` in the Allmaps repository is GPL-3.0; `packages/*` is MIT. Reading Allmaps Editor for architecture is fine. Copying code from it silently relicenses this project.**

`THIRD-PARTY-NOTICES.md` must already carry the `wasm-vips` entry even though nothing imports it yet: the wrapper is MIT but the artefact is compiled **libvips, which is LGPL-2.1-or-later**. It is the one dependency where "MIT on npm" does not tell the whole story, and it will be forgotten if not written down before it is added.

## Out of scope

- **Any product behaviour.** No store, no map, no IIIF. Placeholder pages only.
- **Splitting `core` into finer packages.** ADR-0019 rejects that explicitly; one `core` until a seam proves itself.
- **A map-abstraction layer for testing.** SPEC's Testing Decisions rejects this; Playwright drives real MapLibre.
- **Adding `maplibre-gl`, `terra-draw`, `@allmaps/*`, or `triiiceratops` dependencies.** Their owning slices add them, so that a mistaken version is visible in one diff.
- **Deployment or hosting configuration.** Not in this epic.

## Acceptance criteria

- [x] `pnpm install` succeeds from a clean clone
- [x] `pnpm -r build` succeeds and produces static output for both apps
- [x] `pnpm -r test` succeeds with at least one trivial passing test in `@ballastella/core`
- [x] `pnpm test:e2e` succeeds with at least one Playwright test that loads each app and asserts its placeholder renders
- [x] `pnpm lint` and `pnpm check` succeed
- [x] Both apps' built output references assets by **relative** path (no leading `/`)
- [x] The viewer-dependency check fails when `terra-draw` is added to `apps/viewer` and passes when it is not
- [x] `LICENCE`, `THIRD-PARTY-NOTICES.md` (with the libvips/LGPL entry), and `CONTRIBUTING.md` (with the GPL fence) exist
- [x] CI runs all of the above on push

```bash
pnpm install
pnpm -r build && pnpm -r test && pnpm lint && pnpm check && pnpm test:e2e

# relative paths: expect NO output (no absolute asset refs)
grep -rEo '(src|href)="/[^"]*"' apps/editor/build apps/viewer/build || echo "OK: no absolute asset paths"

# viewer fence: expect the check to FAIL here, then pass after undoing
pnpm --filter @ballastella/viewer add -D terra-draw && pnpm lint; \
  pnpm --filter @ballastella/viewer remove terra-draw && pnpm lint
```

Success: every command exits 0, the `grep` prints `OK: no absolute asset paths`, and the fence check exits non-zero while `terra-draw` is present.

## Blocked by

None — can start immediately.

## Comments

### Implementation, 2026-08-05

All acceptance criteria verified, including from a fresh `git clone` into a clean directory.
Dependencies were deliberately left unpinned so `pnpm install` resolves the latest stable
versions; the `catalog:` block records caret ranges, and `@allmaps/*` will be the only exact
pins when their owning tickets add them.

**The `@ballastella` npm scope could not be confirmed either way, and does not need to be.**
`@ballastella/core` returns 404 and the scope has no published packages — but the ticket's
own fallback, `@dflood`, returns exactly the same signal, so neither is distinguishable from
"owned but empty" without authenticating. The author confirmed there is no intent to publish
to npm. All three manifests are therefore `"private": true`, `core` is consumed as
`workspace:*`, and the registry is never contacted. Every acceptance command in every later
ticket stands as written. If publishing ever becomes real, the scope must be checked then.

**Deviations, each deliberate:**

- **`LICENSE`, not `LICENCE`.** The MIT text was already committed under the American
  spelling in 7e1aeb1 and `README.md` links to it. Renaming to match the ticket's spelling
  would break that link and diverge from the convention GitHub and npm tooling expect. The
  substance — MIT, at the repository root — is satisfied.
- **`core` has no `build` script.** It exports its TypeScript source (`"exports": {".":
"./src/index.ts"}`) rather than a build artefact, so there is no build step to keep in sync
  and no stale `dist/` to debug; the apps' bundlers compile it. `pnpm -r build` therefore
  builds the two apps, which are the only things that produce output. `core` is covered by
  `pnpm check` (`tsc --noEmit`) and `pnpm -r test`. Ticket 09's
  `pnpm --filter @ballastella/core exec tsc --noEmit` works as written.
- **Prettier ignores `*.md`.** Running it across the repository wanted to reflow the SPEC,
  the ticket ledger, and every ADR — 40-odd hand-written prose documents — which is an
  adjacent rewrite this ticket rules out, and would make every later edit to them an
  unreadable diff. Prettier now formats code; prose is reviewed by reading it.
- **TypeScript held at `^6`, not `^7`.** TypeScript 7.0.2 is out, but `svelte-check` and
  `@sveltejs/kit` peer on `^5 || ^6` and `typescript-eslint` on `<6.1.0`. Noted in
  `pnpm-workspace.yaml` so the constraint is visible where the version is.
- **Tailwind and daisyUI are installed here** (ADR-0016). No later ticket owns setting up the
  styling toolchain, and every UI ticket assumes it exists. Stock daisyUI themes for now —
  Tracy's generated theme replaces them, and ADR-0016 requires it to ship in the viewer too.
- **README.md status updated.** It claimed no application code had been written, which this
  ticket makes false.
- **A placeholder favicon** replaces the scaffold's Svelte logo, so published sites do not
  carry Svelte branding. Geometry only; it is not identity work.

**Carried forward, not done here:**

- **The tiler half of ADR-0019 is not manifest-visible.** `scripts/check-viewer-deps.mjs`
  catches `terra-draw` (and its adapters) and `wasm-vips` by reading `apps/viewer/package.json`,
  which is what the ticket asks for. The tiler will live inside `@ballastella/core`, so no
  manifest check can see it — and once the viewer depends on `core`, `wasm-vips` could reach
  the viewer transitively through `core` without touching the viewer's manifest. A transitive
  check was not added because the ticket says the check "does not need to be clever", but
  TRACKER.md already records this as a standing review item and this is the shape it takes.
- **Both apps declare `@ballastella/core` and import it for side effects only** in
  `+layout.ts`, so that `pnpm -r build` and `pnpm check` exercise app → core resolution while
  core is empty. Ticket 02 replaces that with a real import.

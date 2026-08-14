# A shared UI package for the components both apps render

> **Amends [ADR-0019](./0019-minimal-pnpm-monorepo.md).** That ADR settled on one `core` package
> "until a seam proves itself" and rejected `packages/{domain,store,iiif,map,ui}` as premature.
> Shared Svelte components are that seam. Everything else in ADR-0019 stands unchanged — two builds,
> the dependency fence, the catalog of shared versions — and this package joins the fence rather than
> stepping outside it.

```
packages/core        domain model, ProjectStore + adapters, IIIF glue,
                     alignment serialisation, annotation styling
packages/ui          the Svelte components and stylesheet both apps render
apps/editor          the authoring app
apps/viewer          the lean read-only viewer written into published sites
```

## Why the seam proved itself

The editor and the viewer render the same interface twice. `ReaderLayerControls` and `LayerList` are
separate files arrived at separately; so are the Hub and the Front Page; so was the Base Map
switcher. Every sentence the two apps share is spelled twice, and the ones that have already drifted
are the ones nobody noticed drifting — the kind-ink `color-mix` variables lived in the editor's
`layout.css` alone, which is why a published Layer card had no tint to lose.

ADR-0019's argument against decomposition was that "package boundaries invented before the code
exists are usually wrong". This one is not invented before the code: it is drawn around code that
already exists twice, and the cost it removes is a class of bug — a fix landing in one app and not
the other — rather than a tidiness.

## What this package is

**Source, not a build artefact.** `.svelte` and `.ts`, compiled by whichever app's bundler imports
them. No `build` script and no `dist`, which is exactly the arrangement `core` already uses and the
reason `core` has `check` and `test` scripts and no `build`: nothing to keep in sync, no stale
artefact to debug.

**`svelte` is a peer dependency, not a dependency.** The framework belongs to the app doing the
compiling. Two copies of Svelte's runtime in one page is a broken interface rather than a version
warning, and a package that carries its own copy is how that happens.

**The components do not go into `core`.** `core` is the domain model, and adding Svelte to it would
put a UI framework under the alignment serialiser and inside the OPFS worker — a dependency the
things that need `core` most have no use for.

**One stylesheet, `@ballastella/ui/layout.css`**, imported by each app's own `routes/layout.css`. It
carries what a shared component needs wherever it is rendered. It deliberately does **not** carry the
`.pane-overlay-point-*` rules: those style Control Points and Resource Mask handles, which no
published site draws, and shipping them into every one of them is precisely the leanness ADR-0019
makes a dependency-graph property rather than a hope.

**`theme.svelte.ts` stays two modules**, and this is the one thing the package's entry module points
*away* from itself. A Reader's theme is read from `prefers-color-scheme` once at construction; an
author sitting in the editor for hours gets a stored preference and a live listener. The divergence
is argued in the viewer's own module header, and merging the two would settle that argument by
deleting it. What is shared is the *control*, not the signal behind it.

## The fences

**`scripts/check-viewer-deps.mjs` walks this package too**, and needed no change to do it: it reads
the workspace globs out of `pnpm-workspace.yaml` and follows every `workspace:` dependency the viewer
reaches. That was verified by adding `terra-draw` to this package's manifest and watching the check
fail naming `@ballastella/ui`, rather than by assuming it.

**A new check, `scripts/check-ui-package-imports.mjs`: nothing in `packages/ui` may import from
`apps/`.** A shared package that reaches back into a consumer is not shared — it is one app's
directory that a second app happens to compile half of. The likeliest spelling is not an app's
package name but a SvelteKit alias: `$lib` and `$app/*` are what every component in this repository
is written with, and a contributor moving one here will carry them along by hand. Neither exists
outside an app, so a module here that used one would resolve to whichever consumer compiled it — two
apps, two different modules, one file. Like every other fence in this repository it fails when it
finds nothing to guard, and its patterns are run against specimens of what they exist to catch before
the scan begins.

## Consequences

- **The component seam gets a home here.** `packages/ui/vitest.config.ts` renders components against
  props in Node, against happy-dom, and every claim about what a shared component renders belongs in
  it. A shared component tested from the app it used to live in is tested through a consumer, and the
  second consumer is then either untested or carrying a copy of the same claim.
- **Every moved component's harness moves with it.** A test left behind in an app is a test that will
  be deleted with that app's copy or forgotten beside it.
- **Tailwind has to see this package's classes.** Automatic source detection reaches it today,
  because the base Tailwind crawls is the repository rather than the app that imported the
  stylesheet; `@source '.'` is written in the shared stylesheet anyway, because the failure it
  forecloses is silent — the utilities would simply be absent from both built stylesheets and the
  components would render unstyled with nothing erroring.
- **The viewer's bundle is measured across every move into this package**, and recorded in the
  ticket that made it. Sharing components must not silently make every published site larger. The
  Base Map switcher, the first component moved, cost 516 bytes of a 2.80 MB build.

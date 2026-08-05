# A minimal pnpm monorepo: one core package, two apps

```
packages/core        domain model, ProjectStore + adapters, IIIF glue,
                     alignment serialisation, annotation styling
apps/editor          the authoring app
apps/viewer          the lean read-only viewer written into published sites
```

ADR-0006 requires two builds. The question was how the viewer's leanness gets *enforced*, and that is what decides the structure.

**In a single app with two entry points, the viewer's leanness depends on tree-shaking, and tree-shaking is not a boundary.** One incautious import of a module that transitively reaches `terra-draw`, the tiler, or a `wasm-vips` chunk, and every published site silently grows by megabytes — no error, no failing test, nobody looking. With a separate app, `apps/viewer` simply does not list those dependencies, so the constraint is visible in the lockfile and in the bundle, and violating it requires deliberately adding a dependency rather than merely writing an import.

Full decomposition into `packages/{domain,store,iiif,map,ui}` was rejected as premature. Package boundaries invented before the code exists are usually wrong, and each costs a build step, a version to keep aligned, and a refactor when it turns out two of them are entangled. For a two-person team that is pure overhead. One `core` package; split later only when a seam proves itself.

## Consequences

- **Use pnpm catalogs for shared dependency versions**, as Allmaps does (their editor's `package.json` uses `catalog:` entries). This is the clean way to satisfy ADR-0010's requirement that `@allmaps/*` be pinned exactly: one place to pin, both apps inherit, and an Allmaps bump is a single visible diff rather than drift between apps.
- **Alignment fixtures live in the repo** for ADR-0010's round-trip test. Since every `@allmaps/*` package is pre-1.0, that test is what stands between a beta bump and every alignment in the field being subtly misplaced.
- `apps/viewer` must never depend on `terra-draw`, the tiler, or `wasm-vips`. This is checkable by inspection of its `package.json`.

# A shared UI package, proved by the Base Map switcher

## Parent

[SPEC.md](../SPEC.md)

## What to build

Create `packages/ui` — the home for Svelte components both apps render — and prove the whole
arrangement end to end by moving **one** real component into it: the Base Map switcher, which exists
twice today and differs only in where its catalog comes from.

The tracer has to go through every layer this epic will later use: the package and its manifest, the
shared stylesheet, the component seam's home, both apps importing it, and the two fences that keep
the boundary honest. When this lands, the interface is unchanged in both apps and there is a proven
road for everything that follows.

## Where to start

- `packages/core/package.json` — the model. `core` publishes TypeScript **source** with no build
  step, which is why it has `check` and `test` scripts and no `build`. `packages/ui` is that
  arrangement with `.svelte` files in it.
- `pnpm-workspace.yaml` — the `packages/*` glob already covers a new directory, and the `catalog:`
  block is where shared versions live. Nothing pins a version in a package manifest.
- `apps/editor/src/lib/base-map/BaseMapSwitcher.svelte` and
  `apps/viewer/src/lib/BaseMapSwitcher.svelte` — the two copies. The viewer's takes a `catalog` prop
  (ADR-0020: a Published Site keeps the catalog it was published with); the editor's reads
  `BASE_MAP_CATALOG` directly. The shared one takes the prop and the editor passes the constant.
- `apps/editor/vitest.config.ts` — the second project in `projects` is the Seam 3 configuration, and
  its header records exactly why `resolve.conditions` and the `$lib` alias are spelled where they
  are. `packages/ui` needs the same, and the header explains what will fail without it.
- `apps/editor/src/routes/layout.css` — the `--layer-kind-ink-*` custom properties near the top.
- `scripts/check-viewer-deps.mjs` — reads the workspace globs out of `pnpm-workspace.yaml`, so it
  will walk the new package automatically. Confirm that rather than assume it.
- `CONTRIBUTING.md` — the Layout section and the five toolchain rules both need the new package.

## Contract

**The package.**

```
packages/ui
  package.json     name @ballastella/ui, private, type module, no build script
                   svelte as a PEER dependency, not a dependency
                   exports source paths, as core does
  src/…            .svelte and .ts source, compiled by each app's bundler
```

**One shared stylesheet**, imported by both apps' `layout.css`. It carries the
`--layer-kind-ink-map` and `--layer-kind-ink-annotation` `color-mix` declarations, which live in the
editor's copy alone today and are the reason a published Layer card has no tint to lose.

⚠ **The `.pane-overlay-point-*` rules stay in the editor's stylesheet.** They style Control Points
and Resource Mask handles, which the published viewer draws none of — a grep for
`pane-overlay-point` under `apps/viewer` returns nothing. Moving them would put rules for a screen no
Reader can reach into every Published Site, which is the leanness ADR-0019 makes a dependency-graph
property rather than a hope.

**The Seam 3 seam gains a home here.** `packages/ui` gets a vitest project rendering its components
against props, in Node against happy-dom. A shared component tested from the app it used to live in
is tested through a consumer, and the second consumer is then untested or duplicated.

**Two fences, both in `pnpm lint`:**

1. **Nothing in `packages/ui` may import from `apps/*`.** A shared package that reaches back into a
   consumer is not shared. Follow the house pattern for a check: fail when it finds nothing to
   guard, so it cannot pass unconditionally.
2. `scripts/check-viewer-deps.mjs` keeps working and now walks the new manifest too. Assert this by
   temporarily adding a forbidden name to `packages/ui`'s manifest and watching the check fail.

**Record the viewer's bundle size before and after**, in the ticket's completion note. This ticket
should move it by approximately nothing; the number matters because ticket 05 will move it.

### User Stories

57, 59, 61, 62, 63, 64

## Out of scope

- **Move exactly one component.** The Layer card, the navigation bar, the Annotation surface and the
  Project card list are tickets 03, 04, 06 and 09. Resist moving a second "while you are there".
- **Do not move `theme.svelte.ts`.** The two modules are deliberately different and the viewer's own
  header argues why; a future contributor must meet that argument rather than a merged module. Add a
  pointer to it from the shared package's README or entry module so the divergence is discoverable.
- **Do not move the overlay-point CSS**, for the reason above.
- **Do not change any component's rendered output.** Both apps must look exactly as they do now.
- **Do not add a `readOnly` or `mode` prop to anything.** Ever, in this epic.

## Acceptance criteria

- [x] `packages/ui` exists, is picked up by the workspace, declares `svelte` as a peer dependency,
      and has no `build` script.
- [x] Both apps import the Base Map switcher from `@ballastella/ui`; neither app has a local copy.
- [x] The shared stylesheet is imported by both apps and carries the kind-ink custom properties; the
      editor's stylesheet no longer declares them and still declares the overlay-point rules.
- [x] `packages/ui` has a component test that mounts the switcher against a catalog and asserts the
      options it renders.
- [x] A new lint check fails when a module under `packages/ui` imports from `apps/`.
- [x] `scripts/check-viewer-deps.mjs` walks `packages/ui`'s manifest, demonstrated by making it fail
      on purpose and then reverting.
- [x] Both apps build, and the editor's staged viewer bundle still builds with them.
- [x] The viewer's built bundle size is recorded before and after.

```bash
pnpm install
pnpm lint
pnpm check
pnpm test
pnpm --filter @ballastella/ui test
pnpm -r build

# The fence must be shown to bite, not merely to pass:
node scripts/check-viewer-deps.mjs          # passes now
# add "terra-draw": "1.0.0" to packages/ui/package.json dependencies, then:
node scripts/check-viewer-deps.mjs          # MUST fail and name packages/ui
# revert that edit

# Bundle size, before and after this ticket:
pnpm --filter @ballastella/viewer run build && du -sb apps/viewer/build

pnpm test:e2e editor-base-map
pnpm test:e2e viewer
```

Success: every command exits 0 except the deliberate failure, which must exit non-zero and name
`packages/ui`. `pnpm test:e2e editor-base-map` and `viewer` pass unchanged — this ticket changes
where a component lives, not what it does.

## Blocked by

None — can start immediately.

## Completion note

**The viewer's bundle, `du -sb apps/viewer/build`:**

| | bytes |
| --- | --- |
| before | 2 802 211 |
| after | 2 802 727 |
| difference | **+516** (0.018%) |

Approximately nothing, as expected: the same component, compiled from one file instead of two, plus
the two kind-ink custom properties the viewer's stylesheet did not carry before. Ticket 05 is the one
that will move this number, and this is the figure it moves from.

The new ADR is
[ADR-0034](../../../docs/adr/0034-a-shared-ui-package-for-the-components-both-apps-render.md), and
ADR-0019 carries an amendment banner pointing at it.

**⚠ The two copies differed by more than their catalog**, which "Where to start" above says they did
not. Reconciling them without changing either app's appearance — which "Out of scope" requires —
needed one decision the ticket does not make, and it is recorded here rather than left in the diff:

- The viewer's copy wrapped the label and select in `<div class="flex flex-col">`; the editor's did
  not, and on the Project screen that wrapper would have moved the label from beside the select to
  above it. **The wrapper stayed with the viewer's page**, where it is layout rather than a fact
  about the switcher.
- The select's width differed (`max-w-xs` against `sm:w-56`). **It is now a `class` prop the caller
  passes**, on top of the `select-bordered select w-full` the component owns. No `mode` prop and no
  `readOnly` prop: the caller states its own width, which is the same shape as the viewer removing a
  control by not passing it.
- The viewer's copy carried `data-testid="base-map-switcher"` and `data-needs-network` on each
  option; the editor's carried neither. **Both are emitted unconditionally now.** They are test
  seams, invisible on screen, and no editor spec asserted their absence — the editor's own specs
  address the control by role (`getByRole('combobox', { name: 'Base Map' })`).

Both apps' rendered markup is otherwise byte-for-byte what it was.

**The mutation check.** Seven mutations of the component were each run against the new component
test, and each turned the test that claims that behaviour red and no other: reversing the option
order, dropping the needs-network marking from the option text, dropping `value={entryId}`, dropping
the callback, unlinking the label from the select, ignoring the caller's width, and ignoring
`labelSrOnly`.

**`@source '.'` in the shared stylesheet is measured and not currently load-bearing** — both apps
build identical stylesheets without it, because Tailwind's automatic source detection crawls the
repository rather than the importing app. It is written down anyway, with that measurement beside it,
because the failure it forecloses is silent: narrow that base and every utility written in this
package is simply absent from both builds, with nothing erroring.

**No Seam 2 test was added or removed.** `check-seam-2-size` reports 630 against a ceiling of 630,
unchanged.

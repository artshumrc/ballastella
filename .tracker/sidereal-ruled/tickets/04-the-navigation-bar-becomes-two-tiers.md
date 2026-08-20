# 04 — The navigation bar becomes two tiers

## What to build

`AppBar` learns a two-tier arrangement, and the editor uses it.

The **upper tier is the masthead: the tier that never changes with the route.** App name, the
Workspace switcher, the save state, the theme control. The **lower tier is the document and its
actions**: breadcrumbs with their edit action, Undo, Publish.

Nothing the bar carries today is dropped. What changes is that identity stops being the first item in
a flat row and the bar stops re-laying-out as a scholar moves between the Workspace Home, a Project
and the align screen.

## Where to start

- `packages/ui/src/AppBar.svelte` — 208 lines. The root is a single
  `<header class="flex flex-wrap items-center gap-4 border-b border-base-300 bg-base-200 px-4 py-2">`
  and the render order is `start`, the page-chrome slot, a `grow` spacer, then either a folded
  `MenuPopover` or the inline theme button followed by `end`. Read the header comments: the reason it
  is a `<header>` and not a `<nav>`, and the rule that each foldable affordance is rendered exactly
  once and never duplicated behind `display: none`.
- `packages/ui/src/page-chrome.svelte.ts` — the `pageChrome` singleton and the `Breadcrumb` shape,
  including the optional `action`. The lower tier is where this renders.
- `apps/editor/src/lib/components/NavigationBar.svelte` — the `start` and `end` snippets, and the
  `<AppBar>` call. After ticket 03 the `start` snippet no longer holds `remote-identity`.
- `apps/viewer/src/lib/SiteBar.svelte` — 63 lines, passes `start`, `end` **and `menu`**, so it folds.
  The editor passes no `menu` and therefore cannot fold, which is ADR-0014's first fence in code.
- `e2e/editor-project-screen.e2e.ts:283-315` — the `describe('the navigation bar')` block. It asserts
  count **1** for `navigation-bar`, `workspace-identity`, `theme-toggle`, `undo-slot` and
  `save-slot`, on the hub, a Project and align; no Base Map combobox in the bar; and no `page-chrome`
  on the Workspace Home.
- `e2e/viewer-reader.e2e.ts:3915-3955` — the folded-bar test at 375px: `bar-menu` visible, the theme
  toggle and `all-projects` reachable only inside the menu, and no horizontal scroll.
- `e2e/editor-undo.e2e.ts:359` — Undo is reached by the accessible name
  `Undo move of Control Point 1`.
- `e2e/editor-base-map.e2e.ts:228` — the bar's bounding box, and `editor-align-route.e2e.ts:106-220`
  measures `project-screen`'s top against the bar's bottom.

## Contract

**Both tiers live inside `AppBar`'s existing `<header>`.** Not a second `<header>`, not a sibling
element. Every "exactly one of these in the bar" assertion must still count one, and
`navigation-bar` must still be one element whose bounding box is the whole bar — specs measure
`project-screen`'s top against the bar's bottom.

**The upper tier carries:** the app name, the Workspace switcher, the save indicator with its
conditional warnings, and the theme control. **The lower tier carries:** the page-chrome slot
(breadcrumbs or heading-and-back) and the `end` cluster — the undo slot and Publish.

**The save indicator moves to the upper tier and this is deliberate.** Whether a Workspace is saved is
a fact about the Workspace, not about the route, so it belongs with identity. Its conditional
children — `save-error`, `protection-warning`, `deletion-warning`, `unprotected-browser` — move with
it and keep their testids and their live-region behaviour.

**Undo keeps its descriptive accessible name.** `Undo move of Control Point 1` is asserted by name; if
the visible label is shortened for space, the full sentence stays as the accessible name and never
moves to a `title` — ADR-0016 is explicit that a tooltip is not an information channel.

**The viewer's bar keeps folding, and its arrangement is unchanged.** `SiteBar` passes `menu`; the
folding branch in `AppBar` must behave exactly as it does today at 375px. If the two-tier arrangement
is expressed as a new prop, the viewer does not pass it and gets today's single row.

**The theme control stays in the bar, in the editor.** One rejected option folded it into the
workspace menu; that contradicts the `theme-toggle` count assertion and would need `AppBar` to learn
a third arrangement. Do not.

## User Stories

- **23.** As an author, I want the part of the bar that says who I am and where my work is kept to stay
  still as I move between the Workspace Home, a Project and the align screen.
- **24.** As an author, I want the part of the bar that changes — where I am and what I can do here —
  to be visibly the part that changes.
- **25.** As an author, I want my save state beside the app's identity rather than beside the route's
  actions, because whether my work is saved is a fact about my Workspace and not about this screen.
- **26.** As an author, I want every item the bar carries today to still be in it: Workspace, save
  state, theme, breadcrumbs, the Project-name edit action, Undo with its descriptive label, and
  Publish.
- **27.** As an author, I want Undo to keep naming what it will undo, so that pressing it is never a
  gamble.
- **28.** As a maintainer, I want the two tiers to live inside `AppBar`'s existing `<header>`, so that
  every "exactly one of these in the bar" assertion still counts one.
- **29.** As a Reader, I want the viewer's bar to keep folding into a menu on a narrow screen,
  unchanged.

## Out of scope

- **Making the editor's bar fold.** ADR-0014 fences authoring to the desktop and the editor passes no
  `menu` snippet. Do not add one.
- **Moving the theme control into the workspace menu.** Rejected above.
- **The Remote pair.** Ticket 03 removed it. Do not restore it to give the upper tier more content.
- **`pageChrome`'s shape.** Breadcrumbs, the heading-and-back form, and the optional crumb action all
  stay as they are; this ticket decides where that slot renders, not what it renders.
- **The viewer's `SiteBar` contents.** `site-name`, `all-projects` and the return link are unchanged.

## Acceptance criteria

- [ ] The bar renders two tiers inside one `<header>` with `data-testid="navigation-bar"`.
- [ ] On the Workspace Home, a Project and the align route, each of `navigation-bar`,
      `workspace-identity`, `theme-toggle`, `undo-slot` and `save-slot` resolves to exactly one
      element.
- [ ] The upper tier holds the app name, the Workspace switcher, the save slot and the theme control;
      the lower tier holds the page-chrome slot and the undo and Publish cluster.
- [ ] The upper tier's contents are identical on all three routes.
- [ ] Undo's accessible name still reads `Undo move of Control Point 1` after a Control Point move.
- [ ] `project-screen`'s top is still within 1px of the bar's bottom.
- [ ] At 375px the viewer's bar still folds: `bar-menu` visible, theme toggle and `all-projects` only
      inside the menu, no horizontal scroll.
- [ ] `pnpm precommit` passes with `SEAM_2_CEILING` unchanged at `646`.

```bash
pnpm test:e2e editor-project-screen
pnpm test:e2e editor-align-route
pnpm test:e2e editor-base-map
pnpm test:e2e editor-undo
pnpm test:e2e viewer-reader

pnpm --filter @ballastella/ui test

# The editor must still pass no `menu` snippet.
grep -n "menu=" apps/editor/src/lib/components/NavigationBar.svelte
# expect: no output

pnpm precommit
```

Success is the `describe('the navigation bar')` block green unchanged, the viewer's folded-bar test
green unchanged, and the upper tier visibly identical across all three editor routes.

## Blocked by

- 01
- 03

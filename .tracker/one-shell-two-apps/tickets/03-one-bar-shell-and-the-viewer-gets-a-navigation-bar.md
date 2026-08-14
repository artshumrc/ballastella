# One bar shell, and the viewer gets a navigation bar

## Parent

[SPEC.md](../SPEC.md)

## What to build

A Reader on a published site currently has no navigation bar at all — the only way back to the list
of Projects is a text link above the heading, and it is in a different place on every screen.

Build a shared **bar shell** in `packages/ui`: the landmark, the layout, the wrapping behaviour, the
page-chrome slot, and the theme control. The editor's existing `NavigationBar` becomes a consumer
that fills it with the items it already has. The viewer gains a consumer of its own, carrying the
site's name, All Projects, the current Project, and the return links to Ballastella.

## Where to start

- `apps/editor/src/lib/components/NavigationBar.svelte` — read it before deciding anything. It is
  ~700 lines and holds the Workspace switcher, folder-Workspace handling, remote settings, the
  install offer, the save indicator and undo.
- `apps/editor/src/lib/components/page-chrome.svelte.ts` — the `PageChrome` singleton, one generic
  slot a route fills. Its `clear()` comparison is load-bearing and its header says why.
- `apps/editor/src/routes/+layout.svelte` — where the bar is mounted, outside `children()` and
  before it, and why.
- `apps/viewer/src/routes/+layout.svelte` — nine lines today. This is where the viewer's bar goes.
- `apps/viewer/src/routes/+page.svelte` — the Front Page, the Project branch and the unwarped branch
  all currently render their own ad-hoc headings, theme buttons and "All Projects" links. Those come
  out and become bar items.
- `apps/editor/src/lib/components/MenuPopover.svelte`, `ModalDialog.svelte` — small, used by both
  once the viewer has a menu at narrow widths.

## Contract

⚠ **The bar does not move wholesale, and this is the decision the ticket exists to carry.** The
editor's items are heavy and editor-specific: the Workspace switcher reaches
`workspace-storage.svelte.ts`, the remote settings reach the GitHub broker, the install offer reaches
the PWA machinery. Moving `NavigationBar` into `packages/ui` would put all of that in the viewer's
reachable graph — exactly the silent growth ADR-0019 exists to prevent.

**So what is shared is the shell.** It owns the `<header>` landmark, the horizontal layout and its
wrapping, the page-chrome heading and way-back slot, and the theme toggle. It takes snippets for what
goes in it. Each app supplies its own items.

```
AppBar props (shape, not a literal API):
  start?    Snippet   identity — the Workspace switcher, or the site's name
  middle?   Snippet   where you are — filled from the page-chrome slot by default
  end?      Snippet   the app's own controls
  onToggleTheme  ()   the one control both apps share outright
```

**`page-chrome.svelte.ts` moves to `packages/ui` as-is.** Both apps need "which screen am I on and
where does the way off it go", and the `clear()` comparison must survive unchanged — Svelte runs the
arriving route's effects before the leaving route's teardown, and an unconditional clear empties the
bar after the next screen has filled it.

**The viewer's bar carries:** the site's name linking to the Front Page; All Projects; the Project's
name as the current place; the theme toggle; and the return links (`Open in Ballastella` on the
Front Page, `Review this Project in Ballastella` on a Project). Those two links are the **only**
absolute URLs the viewer renders and they keep their existing `eslint-disable` for
`svelte/no-navigation-without-resolve` and the comment that explains it.

**At 380 px the bar keeps the Project's name and the way home**; everything else folds into a menu.
Nothing that folds may become unreachable.

**`ReviewBanner`, `UpdatePrompt`, `RecoveredEdits` and `InstallOffer` stay in the editor.**

### User Stories

3, 4, 5, 6, 7, 9

## Out of scope

- **Do not move the Workspace switcher, remote settings, the save indicator, undo, or the install
  offer.** They stay editor-side items passed into the shell.
- **Do not change the editor's bar contents or behaviour.** Its items must render and behave exactly
  as they do now; only their container changes.
- **Do not touch the Layer stack, the Annotation surface, or the Hub/Front Page card list.**
- **Do not add a Base Map switcher to the bar.** It belongs to the Project (ADR-0020) and stays on
  the Project screen.
- **Do not add a bar to the alignment route's layout by hand** — it already inherits the editor's
  root layout. Ticket 10 covers what `/align` renders into the page-chrome slot.

## Acceptance criteria

- [ ] A shared bar shell exists in `packages/ui`; both apps render it.
- [ ] `packages/ui` does not import from `apps/`, and the viewer's manifest still reaches no
      forbidden dependency.
- [ ] The editor's bar renders the same items with the same test ids as before this ticket.
- [ ] Every screen of the viewer — Front Page, a Project, and the unwarped document view — carries
      the bar.
- [ ] The viewer's bar carries the site name linking to the Front Page, All Projects, the current
      Project's name, the theme toggle, and the return link when the site records one.
- [ ] At 380 px the bar shows the Project's name and the way home, and folds the rest into a menu
      whose items are reachable by keyboard.
- [ ] A site that records no editor URL renders no return link and no broken one.
- [ ] The viewer's build does not reach the Workspace switcher, remote settings or PWA modules.

```bash
pnpm lint
pnpm check
pnpm test
pnpm --filter @ballastella/ui test

pnpm test:e2e editor-workspace
pnpm test:e2e editor-project-screen
pnpm test:e2e viewer
pnpm test:e2e viewer-reader

pnpm -r build
# The viewer's bundle must not have gained the editor's world:
grep -rl "workspace-storage\|github-broker\|InstallOffer" apps/viewer/build/_app/ || echo "clean"
```

Success: everything exits 0 and the grep prints `clean`. `editor-workspace` proves the editor's bar
items are untouched; `viewer` and `viewer-reader` prove the Reader now has one.

**Mutation check:** remove the `clear()` comparison in the page-chrome module and show a test goes
red — a screen's heading surviving into the next screen is the defect that comparison prevents, and
it only appears once a second route adopts the slot.

## Blocked by

- 02 — a shared UI package, proved by the Base Map switcher

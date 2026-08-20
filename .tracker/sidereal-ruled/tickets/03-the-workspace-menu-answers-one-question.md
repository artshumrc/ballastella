# 03 — The workspace menu answers one question

## What to build

The workspace switcher becomes a header block over a roster, and stops being half a settings panel.

The header states what the current Workspace *is*: its name, where its bytes live, and where it
publishes. Under it, the roster of the other Workspaces, then `New Workspace…`, then
`Workspace settings…`. The `Folder on this computer` group and `Remote repository…` leave for
Workspace settings, which ticket 02 has already made their proper home.

Because that removes the menu's only rescue path for a folder whose permission has lapsed, **an
unreachable Workspace is marked on its own row** in the roster.

This ticket also takes the Remote and the credential *out of the navigation bar*, since the header
block is now where those two facts live. The bar's own re-charter is ticket 04.

## Where to start

- `apps/editor/src/lib/components/NavigationBar.svelte:237-404` — the `MenuPopover` with
  `testid="workspace-switcher"`. The current items in document order: a `Switch to` title; one
  `switch-workspace` button per Workspace with `(review copy)` and `(open)` suffixes and
  `aria-current` on the open one; a non-interactive folder row when the backing is a folder; the
  `new-workspace` button; a `Folder on this computer` group title with four mutually exclusive
  controls (`locate-workspace-folder`, `use-browser-storage`, `reopen-workspace-folder`,
  `choose-workspace-folder`); `open-remote-settings`; `open-workspace-settings`.
- The same file, `215-471` — the `start` snippet, which holds `workspace-identity` and
  `remote-identity`. `remote-identity` and its `remote-name` / `remote-credential` children are what
  this ticket removes from the bar.
- `packages/ui/src/MenuPopover.svelte` — the Popover API implementation ADR-0016 mandates. **Do not
  switch mechanism.** `<details>` and CSS-focus dropdowns are banned, and top-layer rendering is what
  keeps the menu clear of the MapLibre canvas.
- `e2e/support/workspace.ts:11-30` — `workspaceButton` and the helper that opens
  `workspace-switcher-menu`.
- `e2e/editor-named-workspaces.e2e.ts:260-280` — the menu's open/close assertions.
- `e2e/editor-base-map.e2e.ts:391` — focus must return to `workspace-switcher` after the menu closes.
- ADR-0016's table — the Popover mandate, and the rule that a glyph is never alone with meaning.

## Contract

**The menu contains exactly these, in this order:** the header block; a `Switch to` group title; one
row per other Workspace; `New Workspace…`; a rule; `Workspace settings…`. Nothing else.

**The header block states three facts and is not interactive** beyond being the menu's heading: the
current Workspace's name, its backing in words ("A folder on this computer" / "Kept in this browser"),
and where it publishes. When there is no Remote, it says so rather than omitting the line — a missing
line reads as a rendering fault, and "no Remote yet" is the state a first-time author is in.

**An unreachable Workspace is marked on its row**, in `warning`, with words and not with a glyph
alone. This is the story-43 replacement for the `locate-workspace-folder` button that used to live
here, and it is the reason this ticket cannot ship without it: removing the button and the signal
together would leave a scholar whose folder permission lapsed with no visible way back.

**`aria-current` stays on the open Workspace**, and `(review copy)` still marks a review copy.

**The bar loses `remote-identity` entirely** — the label, `remote-name` and `remote-credential`. Its
`workspace-identity` block stays, and so does the inline new-Workspace form and the
`workspace-announcement` live region.

**`open-workspace-settings` keeps its testid.** `open-remote-settings` disappears from the menu; if
ticket 02 kept `RemoteSettings` as its own dialog, the control that opens it now lives in Workspace
settings and the testid moves there rather than being deleted.

**Focus still returns to the `workspace-switcher` button** when the menu closes.

## User Stories

- **40.** As an author, I want the menu to answer one question — which Workspace am I in, and can I go
  to another — and to stop offering me storage decisions.
- **41.** As an author, I want the current Workspace's name, where its bytes live and where it
  publishes stated together in one place, because that is the only place they appear together.
- **42.** As an author, I want a review copy marked as one in the roster, and the open Workspace marked
  as open.
- **43.** As an author whose folder permission has lapsed, I want that Workspace marked as unreachable
  **on its row**, so that removing the recovery button from this menu does not remove my way back to
  my work.
- **44.** As an author, I want *New Workspace…* and *Workspace settings…* to be the only actions here,
  under one rule.
- **45.** As an author, I want the folder controls and the Remote binding to be in settings only, so
  that the same decision is not offered to me in two places that could disagree.

## Out of scope

- **Changing `MenuPopover`'s mechanism.** Popover API, per ADR-0016.
- **The bar's two tiers.** Ticket 04. This ticket removes `remote-identity` and leaves the bar's
  arrangement otherwise alone, which is a valid intermediate state: the upper row simply has less in
  it.
- **Switching, creating or deleting a Workspace.** Behaviour is unchanged; only what is offered where.
- **The viewer.** It has no workspace menu.
- **Adding a "follow my system" theme position.** `theme.svelte.ts` explains at length why the third
  state has no control, and it is right.

## Acceptance criteria

- [ ] The menu renders the header block, a `Switch to` roster, `New Workspace…` and
      `Workspace settings…`, and nothing else.
- [ ] No folder control and no Remote control renders inside the menu in any reachable state.
- [ ] The header states the Workspace's name, its backing in words, and its Remote — including an
      explicit sentence when there is no Remote.
- [ ] A Workspace whose folder is unreachable is marked as such on its own row, in words.
- [ ] `aria-current` is on the open Workspace's row; a review copy is still marked `(review copy)`.
- [ ] `remote-identity`, `remote-name` and `remote-credential` no longer render in the navigation bar.
- [ ] Closing the menu returns focus to `workspace-switcher`.
- [ ] Every folder control and the Remote binding are reachable from Workspace settings.
- [ ] `pnpm precommit` passes with `SEAM_2_CEILING` unchanged at `646`.

```bash
pnpm test:e2e editor-named-workspaces
pnpm test:e2e editor-folder-workspace
pnpm test:e2e editor-remote-binding
pnpm test:e2e editor-base-map
pnpm test:e2e editor-project-screen

# The bar must no longer carry the Remote pair.
grep -n "remote-identity\|remote-credential" apps/editor/src/lib/components/NavigationBar.svelte
# expect: no output

pnpm precommit
```

Success is a menu a scholar can read in one glance, with the folder decision offered in exactly one
place in the app, and `editor-folder-workspace` green — that spec is the one that will notice if the
rescue path is gone.

## Blocked by

- 01
- 02

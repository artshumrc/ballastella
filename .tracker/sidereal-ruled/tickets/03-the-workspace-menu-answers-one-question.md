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

## Answer

**`open-remote-settings` is the surviving testid, and `settings-open-remote` is gone.** The Contract
says the testid *moves* to Workspace settings rather than being deleted, and that is the reading
taken: `WorkspaceSettings.svelte`'s button is now `open-remote-settings`, and the five specs that
reach for it — `editor-remote-binding`, `editor-github-signin`, `editor-clone-remote`,
`editor-remote-conflict`, `editor-review-remote` — keep the name they always used and change only the
route in front of it. Keeping ticket 02's temporary name instead would have renamed a control in five
specs to record a collision that no longer exists.

**The four identical local `openRemoteSettings` helpers are now one, in `e2e/support/workspace.ts`,
and it is paired.** `openRemoteSettings` goes through `openWorkspaceSettings`; `closeRemoteSettings`
closes **both** dialogs. That second half is load-bearing rather than tidy: Remote settings is a
`<dialog>` stacked on Workspace settings, and a `showModal()` dialog makes the page behind it *inert*
rather than merely obscured — so eleven bare `close-remote-settings` clicks in `editor-clone-remote`
and `editor-github-signin` left a modal over everything the test went on to touch, which is exactly
how two of them failed on the first run. They all go through the helper now.

**The `remoteAsked` latch is deleted and the mount is unconditional.** `NavigationBar` no longer
mounts `RemoteSettings` at all — it no longer imports it — so there is one copy of every `remote-*`
control in the document and nothing to gate.

**The three facts the header states, and the testids they are read by.** `workspace-header` carries
the name, `workspace-backing` the backing in words (`A folder on this computer` / `Kept in this
browser`), and `workspace-publishes` where it publishes — with `workspace-remote` and
`workspace-credential` inside it when there is a binding, and the sentence *"No Remote yet, so
nothing is published from this Workspace"* when there is not. It is a `li.menu-title`, which daisyUI
excludes from its own item styling, so nothing in it hovers, focuses or takes a pointer.

**Every line of the header states its own ink, and that is a contrast requirement rather than a
preference.** daisyUI paints `.menu-title`'s contents at
`color-mix(in oklab, base-content 40%, transparent)`, which against Sidereal's `base-100` is 2.52:1
in light and 3.25:1 in dark — below AA at any size, and the Remote's name is one of the lines it
would have taken. So the name is full `text-base-content` (17.05:1 light, 13.03:1 dark), the backing
and publishing lines are `text-base-content opacity-70` (6.45:1 and 7.05:1), and `text-warning` is
used only at full opacity — 4.78:1 and 7.43:1, against 2.79:1 in light if it were dimmed the same
way, which is why no marking sits inside a dimmed span.

**The bar's `remote-identity` pair had 23 assertions across three specs, and they are rewritten
rather than relaxed** (SPEC story 77). The facts moved, so the assertions follow them:
`expectRemoteNamed`, `expectCredential` and `expectNoRemote` in `e2e/support/workspace.ts` open the
menu, assert one sentence in the header, and close it again. `expectNoRemote` asserts three things —
that the header says "No Remote yet", that `workspace-remote` is absent, and that
`workspace-credential` is absent — because "publishes nowhere" and "names a repository" must not both
be true, and because the sealed credential store is what a Review Workspace is for (ADR-0033): a
header naming a signed-in identity in one would be reporting a token it must not be able to read.
That third claim is what the `remote-credential` count it replaced was about, and it is pinned rather
than left to markup nesting. Two test titles changed with them: they said "on the bar", and the bar is
no longer where it is.

**Three states are marked, on the row that is the open Workspace in each, and every marking names a
recovery.** `status` is a property of the *open* `EditorSession` (`editor-session.svelte.ts:139`), so
what it reports is a fact about the Workspace on screen and about no other — the named Workspaces in
the roster are not open and have no status to read. That decides *which row* carries a marking, not
whether one exists:

- **A folder that cannot be reached** — moved, renamed, deleted. The open Workspace is the folder
  row, so that is where `workspace-unreachable` lands, in `text-warning`, reading *"Unreachable.
  Workspace settings can locate it again."*
- **Browser storage refusing** — OPFS itself, which a second tab deleting the directory produces and
  which `editor-named-workspaces.e2e.ts` drives at the `navigator.storage.getDirectory` boundary.
  There is no folder row in this backing, so the same `workspace-unreachable` treatment goes on the
  open Workspace's own `switch-workspace` row, reading *"Unreachable. The notice on this screen can
  locate it again."* It names a different way back because a different one is true: nothing in
  Workspace settings locates a browser Workspace, and `WorkspaceRecovery`'s alert — on every route —
  does.
- **A folder remembered but not open yet** — `storage.awaitingFolder`, which is `backing === 'browser'`
  with a `reopenable` name (`workspace-storage.svelte.ts:1545`). This is the state every
  folder-backed scholar returns in, because reopening needs a gesture (ADR-0012), and "Kept in this
  browser" is false of it. So the backing line itself becomes the marking:
  `workspace-awaiting-folder`, in `text-warning`, reading *"Your work is in the folder “…”, which is
  not open yet. Workspace settings can reopen it."*

Words in all three, no glyph, and each names where the recovery is rather than carrying it: the
rescue paths are `WorkspaceRecovery` and `settings-reopen-folder`, and a folder control in this menu
is what story 45 forbids.

**Two assertions were added to existing tests rather than as new ones**, so the Seam 2 count is
unchanged at 643 against a ceiling of 646. `editor-folder-workspace`'s "reports a folder that has
been deleted as unreachable" now also reads the marking off the roster, in the one state that
produces it. `editor-named-workspaces`' "asks nothing about where work is stored on a first visit"
now also opens the menu, reads all three header facts, and asserts that none of
`locate-workspace-folder`, `use-browser-storage`, `reopen-workspace-folder`,
`choose-workspace-folder` or `open-remote-settings` is on screen inside it.

**The roster still lists every Workspace, including the open one.** The Contract's "one row per other
Workspace" is read against its own next clause — `aria-current` stays *on the open Workspace* — and
against the acceptance criterion that asks for it on the open Workspace's row. A row cannot carry
`aria-current` if it is not rendered, so the open one keeps its row and its `(open)` suffix, and the
header states the same name above it. `(review copy)` is untouched.

**What went with the folder controls.** `changeBacking`, `chooseFolder`, `reopenFolder` and
`useBrowserStorage` had no caller left once the four buttons went, and with them went the two
`Your Workspace is now…` announcements — nothing asserted them, and `WorkspaceSettings` is where that
act happens now. `workspace-announcement` itself stays: it still carries the switch and the creation,
which are what `editor-named-workspaces.e2e.ts:204` reads. The `Cloud`, `FolderOpen` and
`FolderSearch` glyphs went with their buttons.

**One thing worth a later look.** Nothing in `WorkspaceSettings` announces a backing change now that
the bar's live region has stopped narrating it — the dialog's own `transfer-outcome` and
`workspace-delete-outcome` regions do not cover `chooseFolder`. It was silent before this ticket too
whenever the act was started from settings rather than from the menu, so this is not a regression, but
it is now the only path.

## Blocked by

- 01
- 02

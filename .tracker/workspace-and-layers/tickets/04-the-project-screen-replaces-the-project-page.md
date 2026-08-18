# The Project screen replaces the Project page

## What to build

Entering a Project puts the user on a Base Map with a Layer sidebar, and that is the Project. The separate `/layers/` route and the `ProjectView` page both disappear into it, along with `/base-map/`.

Demonstrable end to end: from the hub, open a Project; land on a full-height map with the Layer stack beside it; rename the Project from a menu; toggle the theme once from a bar that is present on every screen; click Align on a Map Image and come back.

## Where to start

- `apps/editor/src/routes/layers/+page.svelte` — 806 lines, and **the content that survives.** Its script is the state layer for the whole screen: document loading with the `documentKey` guard, `drawn`, `outcomes`, the annotation editing functions, `annotationPoints`. Extract it into a component so it can be mounted from `/?p=`; do not rewrite it.
- `apps/editor/src/routes/+page.svelte` — 50 lines, currently branching between `ProjectHub` and `ProjectView` on `?p=`. The branch stays; what it renders on the Project side changes.
- `apps/editor/src/lib/components/ProjectView.svelte` — 495 lines, deleted. Its parts are redistributed; see the Contract.
- `apps/editor/src/routes/base-map/+page.svelte` — deleted. Read its header comment first: it records the ticket-12 bug where a route resolved its own store and wrote to the wrong Workspace.
- `apps/editor/src/routes/+layout.svelte` — where the navigation bar goes, beside the existing `UpdatePrompt`. Note the comment on why `UpdatePrompt` sits outside `children()`.
- `apps/editor/src/lib/theme.svelte.ts` — `ThemeSignal`, already ADR-0016's single source of truth for the interface *and* the Base Map flavour. Its comment says persistence "is not in this slice." It is now.
- `apps/editor/src/lib/components/SaveIndicator.svelte`, `apps/editor/src/lib/undo/UndoControl.svelte` — both move into the bar.
- `apps/editor/src/lib/components/ModalDialog.svelte` — the `<dialog>` + `showModal()` wrapper ADR-0016 mandates. The Project settings dialog uses it.

## Contract

**Routes after this slice:**

| Route | Purpose |
| --- | --- |
| `/` | Hub |
| `/?p=<dir>` | The Project: Base Map with Layer sidebar |
| `/align/?p=&layer=` | Alignment (ticket 03) |
| `/image-pane/` | **Retained, unlinked** |

`/layers/` and `/base-map/` are deleted. **`/image-pane/` is kept and must stay unlinked from any user-facing navigation** — it is the only coverage that exercises the synthetic projection independently of the storage layer, and deleting it deletes that.

**The navigation bar lives in the root layout and carries exactly four things** — Workspace identity, the theme toggle, the save indicator, and the undo control. Those are the four things true on every screen. **Project-specific controls stay out of it**: the Project name, the Base Map switcher, and the settings menu belong to the Project screen. Workspace identity in this slice is a label; ticket 12 makes it a switcher.

**One theme toggle, in the bar, and nowhere else.** Remove the per-route toggles. `ThemeSignal` gains `localStorage` persistence and three internal states:

- explicit `light` — chosen, and kept across visits
- explicit `dark` — chosen, and kept across visits
- **unset — follows the operating system live**, by listening to the `prefers-color-scheme` media query's change event, not by reading it once at construction as it does today

The visible control is a **two-state toggle**: the first click writes an explicit preference and stops following the OS. `startTheme()` moves out of the routes and into the root layout so the theme is applied once for the whole app.

**Project settings is a `<dialog>` opened from a menu on the Project screen**, holding the Project name (editable), the folder, and the last-saved time (read-only). ADR-0016 requires `<dialog>` with `showModal()`, working Escape, and focus restoration. The name field keeps ADR-0017's rules exactly as `ProjectView` had them: `oninput` coalesces, `onchange` and `onblur` commit, and **committing is a no-op unless a write is pending** — tabbing through the field must not rewrite `project.json`, because that stamps a fresh `updatedAt` and ADR-0010 forbids merely looking at a Project modifying it.

**Where `ProjectView`'s parts go:**

| Was | Goes to |
| --- | --- |
| Project name, folder, last saved | Project settings dialog |
| Add from file, ingest progress and cancel | Layer sidebar (ticket 06 makes it the full flow; here, keep it working wherever it fits) |
| `AddRemoteMap` | Same |
| Referenced Map Images section | **Deleted.** Its information becomes Layer-card state (tickets 05, 07) |
| Offline copies section | **Deleted.** Same |
| `MirrorMap` per-map action | Layer card (ticket 11 owns its final form; keep it reachable) |
| Undo, save indicator | Navigation bar |
| Align button | Layer card |

**The map gets the larger share of the screen.** The sidebar is a fixed column; the map fills the rest and is full height.

## Out of scope

- **Do not rewrite the layers page's state layer.** Extract and mount it. Its `documentKey` guard exists because a rename once re-read every Alignment and one opacity drag cost twenty reads per Layer; breaking that is a performance regression no test will name.
- **Do not build progressive disclosure in the sidebar.** Ticket 05. Here the sidebar is what `/layers/` has today: `LayerList`, add-annotation-layer, `AnnotationPanel`.
- **Do not change the annotation editing behaviour.** Moving it is enough.
- **Do not delete `/image-pane/`.**
- **Do not add a second Base Map switcher.** One, on the Project screen.
- **Do not demote the storage choice yet** — ticket 12 owns Workspace settings. Leave `StorageChoice` on the hub.

## Acceptance criteria

- [x] `/?p=<dir>` renders a Base Map with the Layer stack beside it; the map is taller than the sidebar is wide.
- [x] `/layers/` and `/base-map/` return no page, and no link anywhere in the app points at either.
- [x] `/image-pane/` still renders the fixture pane, and no user-facing navigation links to it.
- [x] The navigation bar is present on the hub, the Project screen, and the alignment route, with exactly the four controls named above.
- [x] Exactly one theme toggle exists in the app; toggling it changes both the interface and the Base Map flavour in one action.
- [x] A chosen theme survives a reload. With no theme ever chosen, changing the OS preference while the page is open changes the theme without a reload.
- [x] Project settings opens as a `<dialog>` via `showModal()`, closes on Escape, and returns focus to the control that opened it.
- [x] Focusing the Project name field and tabbing away without typing causes no write and leaves `updatedAt` unchanged.
- [x] Typing a Project name coalesces into one write, committed when the edit ends.
- [x] Align on a Map Image Layer navigates to `/align/`, and returning lands on `/?p=` with the same Project open.
- [x] Every control on the Project screen is reachable by keyboard.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check && pnpm test:e2e
```

All green. `e2e/editor-layers.e2e.ts`, `e2e/editor-annotations.e2e.ts`, and `e2e/editor-base-map.e2e.ts` all navigate to routes that are moving or gone: **rewire them, do not delete them.** A route that no longer exists is not a licence to drop the behaviour it covered. For the OS-preference criterion, Playwright's `colorScheme` emulation can be changed on a live page — asserting it only at page load would pass while the live listener is missing.

## Blocked by

- Ticket 03

## Implementation notes

**What moved where.** `routes/layers/+page.svelte` became `lib/project/ProjectScreen.svelte` — the
same script, extracted rather than rewritten, so the `documentKey` guard and the once-only opening
fit are the ones that were already there. `ProjectView.svelte`, `routes/layers/` and
`routes/base-map/` are deleted. `routes/+page.svelte` renders the hub or the Project screen off
`?p=`; `/align/` and `/image-pane/` are untouched routes.

**The navigation bar** is `lib/components/NavigationBar.svelte`, mounted in the root layout before
`children()` so it is first in the tab order. It carries the four: Workspace identity (a label —
ticket 12 makes it a switcher), the theme toggle, the undo slot, the save slot. The align route's
own copies of the last three are gone.

**`ThemeSignal`** gains `localStorage` persistence and a live `prefers-color-scheme` listener behind
a two-state toggle. `startTheme()` moved out of the three routes into the layout and returns its own
teardown.

**Where `ProjectView`'s Referenced and Offline-copies sections went.** Onto the Layer, as the
contract says, via a `mapActions` snippet `LayerList` renders inside a map Layer's row: Align, the
serving host, "View unwarped", `MirrorMap`, and a mirrored copy's source URI. Tickets 05 and 07 own
their final form. The Project page's list of the Workspace's Map Images is gone with the
sections, so `data-image-id` on a Layer row is where a test reads an image id now.

**Two consequences worth naming for the reviewer.**

- The save indicator is on every screen now, so the hub has a `role="status"` it did not have.
  `ProjectHub`'s transfer announcement became `aria-live="polite"`, which is this repo's settled
  convention wherever the two meet.
- A Map Image the Workspace holds but **this Project does not draw** has no place on the
  Project screen any more (ADR-0023). `ProjectView`'s `align-unavailable` alert is therefore gone;
  the sentence that covers the case is the sidebar's empty state.

**Not done here, deliberately:** no progressive disclosure (ticket 05), no Alignment written from
this screen at all — the Align affordance is an `<a href>` and cannot write one — and `/image-pane/`
is kept and unlinked.

## Review remediation

**Fixed.**

- **The offline Base Map notice was a second `role="status"`.** `SaveIndicator` owns that role and
  ticket 04 put it on every screen, which is what made this newly wrong — the same reason
  `ProjectHub`'s transfer announcement was changed in the first pass, and the same miss. It is
  `role="alert"` rather than `aria-live="polite"`, because the element is *inserted* at the moment
  its text first exists, which a polite region does not reliably announce; every conditionally
  inserted explanation in that block, `referenced-offline` beside it, is an alert for the same
  reason. Covered by a new test that asserts one `status` on the hub, the Project, the Project
  offline, and the alignment route.
- **The save error was not announced at all.** `role="alert"` and a `save-error` test id.
  Inherited from the align route's header, where it was already wrong; it renders on every screen
  now, which is what made it this ticket's.
- **The `/base-map/` deletion test checked a spelling that would 404 anyway.** `trailingSlash:
  'never'` emits `base-map.html`, so `./base-map/index.html` proves nothing. `./base-map` — the
  canonical path, what `prerendered` carries and what a bookmark holds — is now tested too.
- **Escape closing the Project menu abandoned a part-drawn shape.** A popover light-dismisses *and*
  keeps the keypress propagating, exactly the case `settingsOpen` already guarded. The window
  handler now asks `MenuPopover.isOpen()`, which reads `:popover-open` off the element.
  **Deliberately not a reactive flag**, and the first attempt was one: `toggle` lands and Svelte
  flushes on their own schedule, so the *next* Escape found a mirror that still said "open" and was
  declined too — swallowing the cancel the user actually meant. Caught by a full-suite run rather
  than in isolation, and the test now presses Escape twice for that reason. Both directions are
  mutation-covered: drop the guard (the shape dies with the menu) and widen it to always decline
  (the cancel never lands).
- **The menu became `lib/components/MenuPopover.svelte`**, beside `ModalDialog` and for its stated
  reason: ADR-0016 mandates a method per surface so the decision is made once, and ticket 12 and the
  transfer tickets are already scheduled to add items here. It carries a `$props.id()` id — the
  hardcoded one could not survive a second instance — `aria-expanded` off the same signal, and its
  own anchor positioning, which removes the `:global([data-testid=…])` styling hook.
- **The theme key's justification was false.** The viewer persists no theme and ADR-0020 keys the
  Reader's Base Map choice by origin and path, so there was no collision to namespace against. The
  key is `ballastella.theme`, which is the house pattern.
- **The Align href now reads `session.openDirectory`**, the same source the opening-fit effect
  compares against, so the `?p=`/`?layer=` pair cannot come from two clocks.
- **Stale comments** naming `/base-map`, `/layers`, `routes/layers/+page.svelte` and `ProjectView`
  as live things: `service-worker.ts`, `+layout.svelte`, `TransformationPicker.svelte`,
  `editor-session.svelte.ts`, `apps/viewer/src/routes/+page.svelte`, two e2e suites.
- **e2e duplication.** The new suite takes `PROJECT_NAME`, `PROJECT_DIRECTORY`, `emptyWorkspace`,
  `createProject` and `readProjectFile` from `support/annotations.ts` instead of redeclaring them;
  `seedMapLayer` moved to `support/project-screen.ts`, which is where a helper about Layers belongs;
  the describe names a behaviour rather than a ticket and has the `routeBaseMapArchive` its siblings
  have.

**Recorded elsewhere, deliberately not widened into this ticket.**

- A Map Image whose starter Alignment failed leaves a pyramid with no Layer, and after a reload
  nothing on screen connects it to "This Project has no Map Images yet" — `ingestError` is
  cleared by `open()`. Written into ticket 06's Contract, which owns the sidebar's add flow and its
  empty states.
- `mirror` vocabulary moved into `lib/project/ProjectScreen.svelte` and a new e2e suite. Added to
  ticket 16's known-sites list, whose grep is written against paths that no longer exist.
- The viewer's `theme.svelte.ts` said the two modules were the same four lines. They are not any
  more; its comment now records the divergence and why reading `matchMedia` once is right *there*.

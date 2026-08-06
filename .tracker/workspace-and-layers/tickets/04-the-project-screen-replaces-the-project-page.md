# The Project screen replaces the Project page

## What to build

Entering a Project puts the user on a Base Map with a Layer sidebar, and that is the Project. The separate `/layers/` route and the `ProjectView` page both disappear into it, along with `/base-map/`.

Demonstrable end to end: from the hub, open a Project; land on a full-height map with the Layer stack beside it; rename the Project from a menu; toggle the theme once from a bar that is present on every screen; click Align on a Historical Map and come back.

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
| Referenced Historical Maps section | **Deleted.** Its information becomes Layer-card state (tickets 05, 07) |
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

- [ ] `/?p=<dir>` renders a Base Map with the Layer stack beside it; the map is taller than the sidebar is wide.
- [ ] `/layers/` and `/base-map/` return no page, and no link anywhere in the app points at either.
- [ ] `/image-pane/` still renders the fixture pane, and no user-facing navigation links to it.
- [ ] The navigation bar is present on the hub, the Project screen, and the alignment route, with exactly the four controls named above.
- [ ] Exactly one theme toggle exists in the app; toggling it changes both the interface and the Base Map flavour in one action.
- [ ] A chosen theme survives a reload. With no theme ever chosen, changing the OS preference while the page is open changes the theme without a reload.
- [ ] Project settings opens as a `<dialog>` via `showModal()`, closes on Escape, and returns focus to the control that opened it.
- [ ] Focusing the Project name field and tabbing away without typing causes no write and leaves `updatedAt` unchanged.
- [ ] Typing a Project name coalesces into one write, committed when the edit ends.
- [ ] Align on a Historical Map Layer navigates to `/align/`, and returning lands on `/?p=` with the same Project open.
- [ ] Every control on the Project screen is reachable by keyboard.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check && pnpm test:e2e
```

All green. `e2e/editor-layers.e2e.ts`, `e2e/editor-annotations.e2e.ts`, and `e2e/editor-base-map.e2e.ts` all navigate to routes that are moving or gone: **rewire them, do not delete them.** A route that no longer exists is not a licence to drop the behaviour it covered. For the OS-preference criterion, Playwright's `colorScheme` emulation can be changed on a live page — asserting it only at page load would pass while the live listener is missing.

## Blocked by

- Ticket 03

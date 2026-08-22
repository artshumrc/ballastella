# 20 - Make Project Import accessible

## What to build

Complete the accessibility contract across every Project Import entry path: Workspace Home Bundle
Import, Published Project Import-or-Review, and Import of the current reviewed state. Every action must
be reachable and operable from the keyboard, long-running work and outcomes must be announced
politely, refusals must be inserted as domain-language errors, and focus must land on a meaningful
result or return control after dialogs and Workspace switches.

This is a verification and focused repair slice over the completed flows, not a redesign of Import.

## Where to start

- Ticket 13's Workspace Home Import dialog, ticket 18's Published Project offer, and ticket 19's
  Review banner Import action.
- `apps/editor/src/lib/components/ModalDialog.svelte`: native `<dialog>`, `showModal()`, Escape,
  `restoreFocusTo`, and the existing protection against restoring focus twice after a switch.
- `apps/editor/src/lib/components/ProjectHub.svelte`: transfer live region, Import action row,
  progress, refusal alert, result focus target, and busy-button `aria-disabled` handling.
- `apps/editor/src/lib/components/ReturnLinkOffer.svelte`: non-modal arrival offer, progress, refusal,
  decline, and focus after either Project choice.
- `apps/editor/src/lib/components/ReviewBanner.svelte`: persistent landmark, announcement outside the
  conditional banner, confirmation, and focus across the return to an ordinary Workspace.
- `apps/editor/src/routes/+page.svelte`: Workspace and `?p=` switches can remove the invoking control;
  provide an explicit destination rather than allowing focus to fall to `<body>`.
- `CONTRIBUTING.md`: mandated native modal and polite status patterns.
- Existing browser specs `e2e/editor-transfer.e2e.ts` and
  `e2e/editor-review-remote.e2e.ts`. Poll live-region and focus outcomes until settled; do not sample
  during dialog transitions or Workspace adoption.

## Contract

All Import, Review, and New Project entry actions and all controls inside their offers or dialogs are
reachable in a predictable Tab order and operable without pointer events. Native buttons remain in the
tab order while a transfer runs: use `aria-disabled` for an action that was pressed and is temporarily
unavailable so focus does not fall to the document body. Escape and Cancel before an operation begins
close safely and restore focus to the control that opened the surface.

Use existing page-wide live-region conventions:

- progress and successful outcomes use persistent `aria-live="polite"` regions;
- a long transfer emits useful settled file/byte updates without flooding duplicate announcements;
- newly inserted refusals use `role="alert"` and domain language such as Project, Map Image,
  Alignment, Annotation, Workspace, and Review Workspace;
- do not communicate state only by color, icon, disabled styling, or a changing button label;
- do not add a second ambiguous `role="status"` where the save indicator already owns that role.

Focus outcomes are explicit:

- cancel or preflight refusal keeps or restores focus within the still-relevant Import surface;
- successful direct Import moves focus to the imported Project heading or another named result on the
  Project screen;
- successful Review Import moves focus to the imported result after the recorded ordinary Workspace
  is adopted;
- successful Review choice moves focus into the Review result without relying on an invoking control
  that was unmounted;
- declining a Published Project offer returns focus to a meaningful editor landmark or action;
- no path leaves `document.body` as `activeElement` after transitions settle.

Prefer component or shared orchestration fixes. Do not add Playwright-only focus shims, arbitrary
timeouts, DOM-adoption workarounds, or duplicate announcements to make assertions pass.

## User Stories

- **92.** As a keyboard user, I want every Import, Review, and New Project action operable without a pointer, so that all entry paths are available to me.
- **93.** As a screen-reader user, I want Import progress and outcomes announced politely, so that a long transfer is not silent.
- **94.** As a screen-reader user, I want Import refusals announced as errors and expressed in domain language, so that failures are perceivable and understandable.
- **95.** As a keyboard user, I want focus restored or moved to the imported result after dialogs and Workspace switches, so that Import does not strand focus on the document body.

## Out of scope

- Do not redesign Workspace Home, the Published Site navbar, Review lifecycle, or synchronization UI.
- Do not add new Import sources or change transaction, remapping, provenance, or allocation behavior.
- Do not add an accessibility abstraction layer or component test seam solely for this epic.
- Do not use color or tooltip content as the only acceptance signal.
- Do not raise the Seam 2 ceiling for claims that can be proved in existing component or core tests;
  consolidate journeys first.

## Acceptance criteria

- [ ] Keyboard-only journeys open, cancel, refuse, and complete Workspace Home Import, Published
      Import-or-Review, Review banner Import, and New Project without pointer input.
- [ ] Busy controls retain focus and remain in the tab order; after every settled transition
      `document.activeElement` is a meaningful visible target, never `<body>`.
- [ ] Cancel and Escape restore focus to the opener when it still exists; Workspace-switching success
      moves focus to the imported or reviewed result.
- [ ] Persistent polite regions announce multiple settled progress updates and exactly one final
      outcome for a large fixture.
- [ ] Every newly inserted refusal is exposed as an alert, names the relevant domain object and safe
      outcome, and leaves focus where the user can retry or leave.
- [ ] Text and accessible names distinguish Import, Review, New Project, and their consequences without
      relying on color or iconography.
- [ ] Tests poll until modal transitions, live announcements, Workspace adoption, and focus movement
      settle.
- [ ] The Seam 2 count is at or below 646, or `scripts/check-seam-2-size.mjs` contains a dated new
      ceiling row with a specific argument for each behavior unreachable at a lower seam and the suite
      has been profiled.

```bash
node scripts/check-seam-2-size.mjs
pnpm test:e2e editor-transfer
pnpm test:e2e editor-review-remote
pnpm test:e2e editor-workspace
pnpm test:e2e --profile
pnpm precommit
```

Success: all six commands pass; keyboard journeys never strand focus, live-region polling observes
progress and final outcomes, refusals are alerts in domain language, and any Seam 2 growth is both
profiled and recorded under the repository's ceiling rule.

## Blocked by

- 13
- 18
- 19

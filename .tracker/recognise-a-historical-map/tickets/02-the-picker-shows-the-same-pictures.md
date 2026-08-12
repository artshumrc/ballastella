# The picker for a map you already have shows the same pictures

## What to build

The "Already in this Workspace" section of the Add-a-Historical-Map dialog shows each candidate map's
picture, exactly as the hub does. This is the surface where recognising a sheet matters most: a scholar
is choosing which of several scans to add to the Project they have open, and the only thing
distinguishing them today is a label that may be a random folder name.

This is a small slice deliberately. Ticket 01 built the component; this ticket uses it in a second
place and proves it there.

## Where to start

- `apps/editor/src/lib/historical-maps/AddHistoricalMap.svelte` — the "Already in this Workspace"
  section and its candidate rows. The `available` derivation filters the same
  `session.historicalMaps` records the hub renders, so **the data is already present and no new
  plumbing is needed.**
- The `MapThumbnail` component ticket 01 added, in the same directory.
- Whatever ticket 01's hub markup ended up as — match it rather than inventing a second treatment.
- `e2e/support/historical-maps.ts` — `ensureAddHistoricalMapOpen`, `settle`, and the busy-state helpers.
  **Read the ⚠ comments.** The dialog stays open for a while after an add has visibly succeeded, and
  that window is what made this suite flake; a test that asks about the dialog without settling first
  will be intermittently wrong rather than wrong.

## Contract

**No new data and no new resolution.** The picker's rows already hold `WorkspaceHistoricalMap` records
carrying `thumbnail` and `tiles`. If this ticket finds itself adding a field, a fetch, or a call into the
domain layer, something has gone wrong — stop and re-read ticket 01's contract.

**The same component, the same box, the same glyph.** The rows are laid out more tightly than the hub's
cards, so the box may need to be smaller; if it is, it is smaller by a prop on the existing component,
not by a second component or a copied block of markup.

**Each row's picture still carries `alt=""` and is still not interactive.** The row already has its own
action, and a picture that takes focus would put a stop between a scholar and the button they are
reaching for.

### User Stories

Covers SPEC story **3**.

## Out of scope

- **Redesigning the picker.** The dialog's layout, its sections, its one-at-a-time add guard, and its
  busy states are all untouched.
- **Changing what the picker offers.** The `available` filter — the Workspace's maps minus the ones this
  Project already has a Layer for — is not this ticket's business.
- **The remote-add flow or the from-a-file flow** in the same dialog. Only the "Already in this
  Workspace" section gains pictures.
- **Referenced maps' pictures.** Ticket 03. A referenced candidate shows the glyph here until then, and
  it will start showing a picture with no change to this ticket's code.
- **Adding a second `MapThumbnail`.** One component, two call sites.

## Acceptance criteria

- [ ] In the Add-a-Historical-Map dialog, a Workspace-held candidate map shows a picture that has
      actually decoded: `naturalWidth > 0`.
- [ ] A candidate whose `thumbnail` is `null` shows the glyph and no broken image.
- [ ] Adding a candidate to the Project still works, and the dialog still closes — the existing
      behaviour of this dialog is unchanged.
- [ ] No new field, fetch, or domain-layer call was added for this ticket.
- [ ] `pnpm precommit` passes.
- [ ] A mutation record is written into this ticket.

```sh
# Add to the spec ticket 01 created, or to the dialog's own spec — whichever holds the
# already-in-this-Workspace flow. `test` must come from e2e/support/network-fence.ts.
pnpm test:e2e editor-add-historical-map.e2e.ts
pnpm test:e2e editor-historical-map-thumbnails.e2e.ts

pnpm precommit
```

Success is exit code 0 from each. Read exit codes directly; no `grep`, and no `--reporter=…`.

### The mutation record

| Criterion | Mutation | Result |
| --- | --- | --- |
| the picker's picture actually decoded | point the component at a URL that was never written | expect red — green means the assertion is `toBeVisible`, not `naturalWidth` |
| the dialog still behaves | — | the pre-existing dialog assertions must pass untouched |

⚠ The same two traps as ticket 01 apply here: `toBeVisible()` passes for a broken image, and asserting
`src` against a computed string compares the computation with itself.

⚠ **A picker assertion that does not settle the dialog first will flake, not fail.** Use
`ensureAddHistoricalMapOpen` / `settle` from the support module rather than waiting on appearance.

## Blocked by

- 01 — the component and the `thumbnail` field do not exist before it.

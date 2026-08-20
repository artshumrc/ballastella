# 02 — Workspace settings becomes three groups, and gains the Remote

## What to build

`WorkspaceSettings.svelte`'s six flat concerns become three headed groups in one scroll, and the
dialog takes over the Remote binding so that ticket 03 can remove it from the workspace menu.

The three groups:

- **Where your work lives** — the storage backing, its per-visit permission note, its problem
  warning, **the Remote and the GitHub credential**, and browser persistence.
- **Keeping it safe** — backup, restore, and the orphaned-edits warning.
- **This browser and your Workspaces** — the install offer, the Workspace list, and deletion.

Every state the dialog can be in today survives. Nothing is removed except duplication: the nested
folder conditional collapses to at most two controls, and the third "Choose a folder again" button
inside the storage warning becomes that warning's own action rather than a fourth spelling of the
same thing.

## Where to start

- `apps/editor/src/lib/components/WorkspaceSettings.svelte` — 483 lines, and the whole subject. Read
  it end to end before editing. The current order is: storage (159–227, including the three-level
  nested button conditional at 175–207), persistence (237–257), orphaned journals (280–327, with a
  ~30-line outcome-composing handler inlined in an `onclick`), the install offer (334–337), backup
  and restore (344–413), your Workspaces (415–445), the Close action (448–452), and a second
  stacked `ModalDialog` for delete confirmation (460–483).
- `apps/editor/src/lib/components/RemoteSettings.svelte` — 555 lines, currently its own dialog
  opened from the workspace menu by `open-remote-settings`. **Decide and record** whether its body
  becomes a section inside this dialog or stays its own dialog reached by a control in the *Where your
  work lives* group. Either satisfies story 45; the second is much the smaller change and is the
  recommendation.
- `apps/editor/src/lib/components/ModalDialog.svelte` — the `wide` prop. This dialog already passes
  it.
- `e2e/support/workspace.ts:39-59` — `getByRole('dialog', { name: 'Workspace settings' })` and
  `close-workspace-settings`. Every spec that touches this dialog arrives through here, so **the
  accessible name is load-bearing across the suite**.
- `docs/adr/0036-…` — the marking rules. The orphaned-edits and storage-problem notices are notices:
  hairline on all four sides over a wash of their own colour, glyph beside the words, **no left
  border**.

## Contract

**Every `data-testid` in the file keeps its meaning.** `settings-folder-name`,
`settings-workspace-name`, `settings-choose-folder`, `settings-reopen-folder`, the three
`persistence-*`, `orphaned-journals`, `discard-orphaned-journal`, `install-offer`,
`back-up-workspace`, `restore-workspace`, `restore-file`, `transfer-progress`, `transfer-outcome`,
`transfer-problem`, `no-backup-in-review`, `no-other-workspaces`, `delete-workspace`,
`delete-workspace-size`, `confirm-delete-workspace`, `workspace-delete-outcome` and
`close-workspace-settings` all still exist and still identify the same control or region. Regrouping
moves them; it does not rename them.

**Exactly one of the three `persistence-*` testids renders at a time**, as
`editor-named-workspaces.e2e.ts:396-404` asserts.

**At most two folder controls.** The current three-level conditional yields up to three buttons, two
of which say nearly the same thing. Collapse to: the recovery control when the backing is unreachable,
and the switch-backing control. The warning alert's own button is the recovery control, not a third
copy.

**Pull the orphaned-journal outcome composition out of the markup.** The ~30-line inline `onclick` at
280–327 becomes a script function beside `backUp`, `restore` and `confirmDelete`, which is where the
file's other three actions already live. This is prefactoring, and it is why this ticket is early: the
regrouping is much easier once that handler is not inside a `{#each}` inside an `{#if}`.

**Three announcement channels stay three.** `transfer-outcome`, `workspace-delete-outcome` and the
orphaned-journals region are separate live regions today. Do not merge them; a single shared region
would make one action's outcome overwrite another's mid-announcement.

**The delete confirmation stays a sibling `ModalDialog`** in the top layer, with its own
`confirming`/`confirmOpen` pair. Nesting it or replacing it with an inline confirm is out of scope.

## User Stories

- **55.** As an author, I want this dialog to be three groups rather than six, so that I can find the
  one I came for.
- **56.** As an author, I want the sentence about whether this browser will keep my work to be visible
  without opening anything, because it is the one line here that can save my work.
- **57.** As an author, I want at most two "choose a folder" controls, not three saying nearly the
  same thing.
- **58.** As an author, I want the recovery action for a storage problem to be part of the warning
  that tells me about it.
- **59.** As an author, I want backup, restore, my other Workspaces and the install offer all still
  here, with every state they have today including a review copy's refusal to back up.
- **60.** As an author, I want deleting a Workspace still to name what it holds and still to ask.
- **61.** As a maintainer, I want the dialog's accessible name to stay "Workspace settings", because
  every spec that touches it arrives through that name.

## Out of scope

- **Splitting incidents out of *Keeping it safe*.** Backup-and-restore is a deliberate act and an
  orphaned-edit warning is an incident report, and they share a heading only because both concern not
  losing work. This is named in the spec's Out of Scope as known and unresolved. Leave it.
- **A backup timestamp.** "Last backup: never" is a fact nothing records. Do not add storage for it.
- **Tabs.** ADR-0016 would mandate radio inputs with `role="tablist"`, and the persistence warning is
  exactly the sentence that must not go behind a tab.
- **The workspace menu.** Removing the folder controls from it is ticket 03. This ticket only makes
  their destination good.
- **`WorkspaceStorage`, persistence probing, backup or restore behaviour.** Presentation only. If a
  behaviour looks wrong, record it; do not fix it here.

## Acceptance criteria

- [ ] The dialog renders exactly three headed groups, in the order given above.
- [ ] The dialog's accessible name is still "Workspace settings" and `close-workspace-settings` still
      closes it.
- [ ] Every testid listed in the Contract resolves to the same control or region it did before.
- [ ] At most two folder controls render in any reachable state, and the storage-problem warning's
      recovery action is inside the warning.
- [ ] The Remote and the GitHub credential are reachable from this dialog, in the *Where your work
      lives* group.
- [ ] The orphaned-journal outcome sentence is composed by a named function in the component's script,
      not by an inline handler in the markup.
- [ ] No notice in the file uses a left border for emphasis.
- [ ] `pnpm precommit` passes with `SEAM_2_CEILING` unchanged at `646`.

```bash
# The specs that pin this dialog, by name.
pnpm test:e2e editor-named-workspaces
pnpm test:e2e editor-backup
pnpm test:e2e editor-transfer
pnpm test:e2e editor-remote-binding
pnpm test:e2e editor-pwa

# No left border for emphasis anywhere in the file.
grep -n "border-l\b\|border-l-" apps/editor/src/lib/components/WorkspaceSettings.svelte
# expect: no output

pnpm precommit
```

Success is every one of those specs green without its assertions being relaxed, and the dialog
readable top to bottom as three concerns rather than six.

## Blocked by

- 01

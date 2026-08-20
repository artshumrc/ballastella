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

## Answer

**`RemoteSettings` stays its own dialog, reached from a control in *Where your work lives*.** The
recommendation is taken, and reading the two files makes it more than a size argument.

- The component's own docstring is an argument for the split, and it is a good one: Workspace settings
  answers *where your work is kept and what may be done to it*, a question about this machine, and the
  Remote answers *where your work goes when you publish it*, a question about the web. Inlining 555
  lines of repository field, token field, sign-in, clone, unbind and Pages into a dialog whose whole
  point this ticket is to *reduce* from six concerns to three would have made a seventh concern out of
  the largest one.
- Story 38 is load-bearing and the split is what keeps it: nothing about GitHub renders anywhere until
  the user opens that dialog. A section would have put a sign-in field in front of every scholar who
  opened settings to read one sentence about browser persistence.
- The group therefore carries a state line — the bound repository and whether GitHub is signed in, or
  "No repository yet" — and one `settings-open-remote` button behind it. Story 45 is satisfied because
  the binding is reachable from settings; ticket 03 is unblocked because it can delete the menu item
  without deleting the only route to it.

**Two consequences ticket 03 inherits, both deliberate.**

1. **The testid is `settings-open-remote`, not `open-remote-settings`.** `NavigationBar` still carries
   `open-remote-settings`, and this ticket may not edit that file — two elements with one testid is a
   Playwright strict-mode failure in every spec that reaches for it, which is `editor-remote-binding`,
   `editor-github-signin`, `editor-clone-remote`, `editor-remote-conflict` and `editor-review-remote`.
   When ticket 03 removes the menu's copy it may rename this one to `open-remote-settings` and point
   those specs' `openRemoteSettings` helpers at Workspace settings, which they need anyway once the
   menu item is gone.
2. **The `RemoteSettings` mount here is behind a first-ask latch** (`remoteAsked`), for the same
   reason: `NavigationBar` mounts one unconditionally, and `ModalDialog` renders its children whether
   the dialog is open or not, so a second unconditional mount would double every `remote-*` control in
   the document. Mounted on first ask and then left mounted — rather than mounted while open — because
   an unmount on close skips `ModalDialog`'s own `close()` and focus restoration, and the focus a
   keyboard user gets back is `<body>`. Ticket 03 should make it an unconditional mount when the bar's
   copy goes, and delete the latch.

**The folder controls collapse through one derived flag, `pickableHere`.** Every `chooseFolder()`
control in the file is the same act under three labels, so a standing `storage.problem` moves the
offer into the warning that names the folder and suppresses the row's copy. At most two controls
render in every reachable state, including the two that used to produce three: browser backing with a
remembered folder and a problem (`Reopen “X”` plus the warning's own button), and folder backing that
is unreachable with a problem (`Use browser storage instead` plus the warning's own button).

**The orphaned-journal outcome still lands in `workspace-delete-outcome`, and that is not an
oversight.** `discardOrphanedJournal` is now a named function beside `backUp`, `restore` and
`confirmDelete`, but it writes the same shared `outcome` state the delete does, because
`editor-named-workspaces.e2e.ts:526` and `:559` assert the sentence in that region. Giving the discard
its own state would be a behaviour change and is not in this ticket's Contract — it is worth a later
look, since the sentence is now announced two groups away from the button that produced it.

**Two things noticed and left alone, recorded because this ticket is presentation only.**

- **The storage-problem warning's "Choose a folder again" button is not gated on
  `storage.canChooseFolder`.** Pre-existing, but it matters more now that `pickableHere` suppresses the
  row's copy, because in that state it can be the only folder control on screen. Gating it was rejected:
  it would produce a state with a standing problem and no recovery control at all, which is worse than
  a button that may fail. `editor-folder-workspace.e2e.ts:889` only looks at `settings-choose-folder`,
  so no spec would catch it either way.
- **The new *Where this Workspace publishes* summary reads `storage.signedIn` and `storage.identity`
  cold**, with no `ensureCredentialFresh()`, so an expired token still reads as signed in. That is
  behaviour, not presentation, and outside this ticket's scope.

## Blocked by

- 01

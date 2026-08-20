# 06 — Publish becomes a receipt

## What to build

`PublishDialog` takes `wide` and becomes a receipt read top to bottom: the total first at display
size, the breakdown as a ruled ledger, the front-page choices in the middle, and the destination as a
strip at the foot immediately above the button that acts on it.

Every piece of information and every state the dialog has today survives. The five-way destination
branch stops being a stack of alerts in a 32rem box and becomes a designed footer that can refuse.

## Where to start

- `apps/editor/src/lib/publish/PublishDialog.svelte` — 927 lines. Read all of the markup, 596–925,
  before editing. In order today: the always-present `publish-status` live region (596–603), the
  `publish-stale` notice (605–613), the standing `publish-failure` refusal (622–630); then inside the
  dialog an in-dialog failure alert (633–637), the `publish-project-selection` section (639–673), the
  planning line (675–676), the `publish-breakdown` (678–703), the `Publish destination` section
  (712–879) with its five-way chain, the plan warnings (881–889), the `publish-progress` region
  (897–899), and the actions (905–925).
- The same file, 712–879 — **the five arms, which are the hard part**: no Remote (`publish-unbound`);
  an upload problem; still asking GitHub; nothing to do (`publish-nothing-to-do`); and the full case
  with its conflict alert (`publish-conflict`, `publish-replace`), the destination bullets, and the
  three-row budget list carrying `data-budget="files|bytes|requests"`. The not-signed-in arm is a
  `<form>` with `publish-token-field` and `publish-sign-in`.
- `apps/editor/src/lib/components/ModalDialog.svelte:147-153` — the shell.
  `max-w-3xl` applies **only** when `wide` is passed, and this dialog does not pass it today.
- `e2e/editor-publish.e2e.ts` — heavy and specific. `publish-breakdown`; `publish-budget` with all
  three `data-budget` values including a byte-limit string and a clock time; `on-front-page-boston-1775`;
  the description text "All Projects stay published." at `:454`; "Contents: Read and write" at `:1222`;
  "Remote repository…" inside `publish-unbound` at `:1185`; `publish-progress` empty when idle at
  `:564` and `:1028`; `publish-status` reading "Published:", "Sent to …", "1 Project";
  "an older version of the viewer" at `:666`. It also asserts
  `getByRole('button', { name: 'Publish', exact: true })` has count **0** when unbound or not signed
  in (`:1187`, `:1199`), and relies on `getByRole('status')` being unique (`:770-773`).
- `e2e/editor-remote-conflict.e2e.ts:130-330` — `publish-conflict`, `publish-replace`, the
  `Publish anyway, replacing it` name, and `aria-disabled` on the exact-name Publish button.
- ADR-0032 and ADR-0033 — what Publish means, and why a conflict is refused rather than merged.
- `docs/adr/0036-…` — the marking rules. Notices are bordered on all four sides; **no left border**.

## Contract

**`wide` is passed, and the receipt is capped at about 40rem inside it.** Not two columns. The extra
width goes to two things: distance between a breakdown row's label and its figure, so the block reads
as a ledger rather than a cramped list; and enough room for the destination strip to fit
`owner/repository`, the credential and the rate-limit clock **on one line without wrapping**, which is
what made the current dialog feel starved.

**Every testid keeps its meaning**: `publish-status`, `publish-stale`, `publish-failure`,
`publish-project-selection`, `on-front-page-{directory}`, `publish-breakdown`, `publish-unbound`,
`publish-upload-problem`, `publish-no-push`, `publish-sign-in-needed`, `publish-token-field`,
`publish-sign-in`, `publish-nothing-to-do`, `publish-conflict`, `publish-replace`, `publish-budget`
with its three `data-budget` values, `publish-progress`, and the `data-warning` / `data-remote-warning`
attributes.

**The exact-name `Publish` button still does not exist when unbound or not signed in.** Two
assertions count it at zero. A disabled button is not the same thing and would break them.

**One `role="status"` in the dialog.** `editor-publish.e2e.ts:770-773` depends on
`getByRole('status')` resolving uniquely. The always-present `publish-status` region is that one; do
not add a second status role, and keep `publish-progress` empty when idle.

**The five arms are designed, not stacked.** Each of unbound, not-signed-in, asking, nothing-to-do,
and the full case is a deliberate footer layout. The **unbound arm is the one to get right first**: it
is what a first-time author meets, and a footer holding one sentence looks broken unless it is drawn
to hold one sentence. It must still name *Remote repository…* as the way forward — and note that
ticket 03 moved that control into Workspace settings, so the sentence's wording may need to change
while the `publish-unbound` testid and the reference to a named control do not.

**Replacing another machine's site stays armed deliberately.** `publish-replace` arms it,
`publish-anyway` naming stays, and `aria-disabled` behaviour while publishing is unchanged. ADR-0033
refuses a merge; the dialog says so.

**The staleness notice and the standing refusal stay outside the dialog.** They outlive it on purpose:
`publish-stale` renders when `!open`, and `publish-failure` is a refusal that survives closing.

**The unbound gate must not swallow a bound Workspace's plan.** `editor-transfer.e2e.ts:753`
("publishing while a review copy exists publishes only the user's own Workspace") is **red on the
branch before this ticket starts**, and it is this dialog's fault: commits `6855ec1` and `9442815`
added a `publish-unbound` arm rendered whenever `remote === null`, and that spec reaches the dialog
without binding a Remote, so it reads "Connect this Workspace to a GitHub repository before
publishing" where it expects "will carry" and "1 Project". Verified pre-existing by reverting ticket
08's two source files and re-running: it still fails. Redrawing the five-way branch is exactly the
work that decides which arm that spec lands in, so the fix belongs here rather than in a ticket of its
own. Either the arm's condition is wrong or the spec's setup no longer reaches a bound Workspace —
**diagnose which before changing either**, and say which in the Answer. Do not make the spec pass by
relaxing its two assertions.

## User Stories

- **46.** As an author, I want the size of what I am about to publish stated first and largest, because
  it is the fact I opened this dialog to learn.
- **47.** As an author, I want the breakdown to read as a ledger — label left, figure right, ruled
  between — rather than as a cramped list.
- **48.** As an author, I want the destination stated immediately above the button that sends my work
  there, so that *Publish* is never pressed without its target in view.
- **49.** As an author, I want `owner/repository`, my credential and the requests I have left on one
  line that does not wrap.
- **50.** As an author, I want to choose which Projects Readers see first, and to be told plainly that
  all Projects stay published either way.
- **51.** As an author, I want every state this dialog can refuse in to be designed rather than merely
  handled: no Remote bound, not signed in, no push permission, an upload problem, a conflict with
  another machine, and nothing to do.
- **52.** As a first-time author with no Remote bound, I want the dialog to explain what is missing and
  where to fix it, rather than to look broken.
- **53.** As an author whose site was last published from another machine, I want to be told that
  publishing replaces rather than merges, and to have to arm that action deliberately.
- **54.** As an author using a screen reader, I want the outcome, the progress and the standing refusal
  each announced once and in the right way.

## Out of scope

- **Two columns.** Considered and rejected: the receipt's worst state is the footer, and a second
  column makes the unbound arm look like a rendering fault.
- **Publish behaviour.** The plan, the budgets, the conflict detection, the sign-in exchange and the
  upload are unchanged. This is presentation. If a number looks wrong, record it.
- **The front-page selection's semantics.** Which Projects are on the Front Page is ADR-0032's; the
  toggle's disabled state for a Project with a problem stays.
- **Removing the `publish-unbound` arm's pointer to a named control.** It must still say where to go,
  even though ticket 03 changed where that is.
- **`ModalDialog`'s API beyond passing `wide`.** Do not add a second width prop.

## Acceptance criteria

- [ ] The dialog passes `wide`, and its content is capped at roughly 40rem rather than filling
      `max-w-3xl`.
- [ ] The total size renders above the breakdown, at a larger type size than any other figure in the
      dialog.
- [ ] The breakdown renders as label-left / figure-right rows with rules between them.
- [ ] The destination strip renders immediately above the confirm button, and at 1280px its
      repository, credential and rate-limit line does not wrap.
- [ ] All five destination arms render a deliberate footer layout; the unbound arm reads as a
      designed state and names the control that fixes it.
- [ ] `getByRole('button', { name: 'Publish', exact: true })` still has count 0 when unbound and when
      not signed in.
- [ ] `getByRole('status')` still resolves uniquely inside the dialog, and `publish-progress` is empty
      when idle.
- [ ] Every testid and `data-*` attribute listed in the Contract still resolves.
- [ ] No notice in the dialog uses a left border for emphasis.
- [ ] `editor-transfer.e2e.ts:753` is green, with both `will carry` and `1 Project` still asserted.
- [ ] `pnpm precommit` passes; if `SEAM_2_CEILING` is raised, the table records the count and reason.

```bash
pnpm test:e2e editor-publish
pnpm test:e2e editor-remote-conflict
pnpm test:e2e editor-transfer

grep -n "border-l\b\|border-l-" apps/editor/src/lib/publish/PublishDialog.svelte
# expect: no output

pnpm precommit
```

Success is `editor-publish`, `editor-remote-conflict` and `editor-transfer` green with no assertion
relaxed, and the unbound arm — the one a first-time author meets — looking like a state somebody drew.

## Blocked by

- 01

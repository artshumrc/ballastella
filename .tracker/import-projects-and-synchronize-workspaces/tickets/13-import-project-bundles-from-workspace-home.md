# 13 - Import Project Bundles from Workspace Home

## What to build

Add **Import a Project** to Workspace Home as a first-class action beside **Review a Project** and
**New Project**. In this slice, Import accepts a Project Bundle, names the ordinary Workspace that will
receive it, runs the shared Import engine against that currently open Workspace, reports progress, and
opens the resulting ordinary editable Project without creating or switching to another ordinary
Workspace.

Keep Review as the isolated throwaway path. A user must be able to tell before choosing a file whether
they are copying work into their Workspace, examining it in a Review Workspace, or creating new work.

## Where to start

- The source, transaction, recovery, remapping, allocation, and provenance behavior delivered by
  tickets 03 through 08.
- `apps/editor/src/lib/components/ProjectHub.svelte`: the Workspace Home action row, existing
  Project Bundle Review dialog, GitHub Review dialog, transfer live region, refusal alerts, and focus
  restoration.
- `apps/editor/src/lib/workspace-storage.svelte.ts`: `openBundle`, `reviewFrom`, `transfer`, `name`,
  `session`, and the adoption/recovery gate. Add an Import operation beside the existing Review
  operations; do not repurpose `openBundle` so Review semantics become ambiguous.
- `apps/editor/src/routes/+page.svelte`: Workspace Home versus Project selection through `?p=`.
- `apps/editor/src/lib/editor-session.svelte.ts`: refresh/open behavior after a committed external
  change to the current Workspace.
- `packages/core/src/transfer/open-project-bundle.ts`: keep the Review destination path working while
  routing shared source extraction through ticket 03.
- `e2e/editor-transfer.e2e.ts`: extend the existing Project Bundle workflow instead of creating a new
  browser spec. Reuse its complete Workspace snapshots, bundle fixtures, keyboard helpers, and focus
  assertions.

## Contract

Workspace Home presents three distinct top-level actions using exactly the domain operations they
perform:

- **Import a Project** copies outside work into the current ordinary Workspace.
- **Review a Project** opens outside work in an isolated Review Workspace.
- **New Project** creates empty local work.

Import's first source choice is **Project Bundle**. The offer must visibly say
`Import into “<current Workspace name>”` before the file is installed. Resolve the destination at the
moment the Import offer is opened and keep that specific open ordinary Workspace as the transaction
target; do not create another Workspace, route through Restore, or silently follow a Workspace switch.
If the target is no longer the open/reachable ordinary Workspace before commit starts, refuse and make
the user begin again.

The operation order is:

1. The user opens the offer and chooses a Project Bundle.
2. Cancel or Escape before confirmation closes the offer, downloads nothing, writes nothing, and
   restores focus to the Import action.
3. Confirmation extracts and validates the read-only source, plans the detached closure, preflights
   quota and collisions, then begins the atomic transaction.
4. While copying, retain keyboard focus on a real enabled or `aria-disabled` control and announce
   honest file/byte progress without inventing a percentage for a tar stream.
5. After durable commit, refresh the current session, navigate to or otherwise visibly identify the
   imported Project, and report the allocated display name and current Workspace.

The Project is ordinary editable work after success. It has no source relationship and behaves like
any other Project in authoring, backup, and later Workspace Publish. Review and New Project retain
their current semantics and separate dialogs.

## User Stories

- **1.** As an author, I want Import a Project, Review a Project, and New Project presented as distinct actions, so that I understand whether I am copying, examining, or creating work.
- **2.** As an author, I want Import a Project available from the Workspace Home, so that I can add outside work to the Workspace already open.
- **3.** As an author, I want to choose a Project Bundle as an Import source, so that I can keep a Project someone sent me.
- **7.** As an author, I want an Import offer to name its destination Workspace, so that I know where the Project will be added.
- **8.** As an author, I want Import to add work without creating or switching to another ordinary Workspace, so that Import means adding a Project to my current Workspace.
- **9.** As an author, I want an imported Project to become ordinary editable work, so that I can continue developing it with the normal authoring tools.
- **10.** As an author, I want an imported Project detached from its source, so that later changes never travel automatically in either direction.
- **11.** As an author, I want the interface to distinguish Import from Review, Update from GitHub, Restore, and Open a Workspace from GitHub, so that each operation has one predictable meaning.
- **12.** As an author, I want New Project kept separate from Import, so that copied work is not mistaken for newly created work.
- **13.** As an author, I want progress while a large Project is imported, so that copying a Map Image pyramid is not a silent wait.
- **14.** As an author, I want canceling before Import begins to leave my Workspace unchanged, so that inspecting the offer is harmless.

## Out of scope

- Do not add Published GitHub Project Import; ticket 18 owns that source and offer.
- Do not add Import from the current reviewed state; ticket 19 owns Review lifecycle handling.
- Do not implement own-Remote policy or Remote inventory fetching; ticket 17 integrates those rules.
- Do not rename Restore, combine Import with Update, or add a generic transfer wizard.
- Do not remove Project Bundle Review or turn Review into an Import preview step.
- Do not add a bulk/multi-Project Import.

## Acceptance criteria

- [ ] Workspace Home renders distinct, keyboard-reachable Import, Review, and New Project actions in
      an ordinary Workspace.
- [ ] The Import offer names the current Workspace and offers Project Bundle as a source.
- [ ] Cancel and Escape before confirmation restore focus and leave every destination path byte-identical.
- [ ] Confirming a valid bundle leaves the same ordinary Workspace open, adds one complete detached
      Project, and navigates to or focuses its allocated result.
- [ ] The imported Project can be edited with normal authoring controls and the source bundle remains
      unchanged.
- [ ] A large fixture emits more than one settled polite progress announcement and success is not
      announced before the closure is durable.
- [ ] A malformed, too-new, quota-refused, or collision-refused bundle leaves the Project and Map
      Image lists and every Workspace byte unchanged.
- [ ] Existing Project Bundle Review behavior remains isolated and green.
- [ ] Browser assertions are consolidated into `editor-transfer`; a Seam 2 ceiling increase has the
      required dated row and lower-seam argument.

```bash
pnpm --filter @ballastella/core test -- project-import-source
pnpm --filter @ballastella/core test -- project-import-transaction
node scripts/check-seam-2-size.mjs
pnpm test:e2e editor-transfer
pnpm precommit
```

Success: all five commands pass; the browser workflow distinguishes all three actions, proves the
same Workspace before and after Import, opens an editable imported Project, and compares complete
Workspace snapshots for cancelation and refusal.

## Blocked by

- 03
- 04
- 05
- 06
- 07
- 08
- 10

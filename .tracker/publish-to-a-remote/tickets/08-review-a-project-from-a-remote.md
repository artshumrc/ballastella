# Review a Project from a Remote

## What to build

Naming a public GitHub repository **and one Project inside it** downloads that Project — with the Historical
Maps, Alignments, and Annotations its Layers reference — into a **Review Workspace**: throwaway, unbound,
unpublishable, carrying the persistent banner that says so.

This is the existing Project Bundle path with a different source of bytes. It is deliberately *not* an import
into the user's own Workspace, and that refusal is the point of the ticket as much as the download is.

## Where to start

- `docs/adr/0024-backup-and-handoff-are-different-artefacts.md`, the "Why handoff cannot merge" section.
  Read it in full before writing anything. Its argument — that an Alignment is Workspace-shared, one per
  Historical Map (ADR-0023), so importing a colleague's Project would either overwrite an Alignment two of
  your own Projects depend on or be refused — is unchanged by a new transport.
- `packages/core/src/transfer/open-project-bundle.ts` and `project-bundle.ts` — what a self-contained
  Project consists of, and how a Review Workspace is populated from one. The gathering logic (which
  Historical Maps and Alignments a Project's Layers reference) already exists here; reuse it against a
  remote file list rather than a tar.
- `apps/editor/src/lib/workspace-storage.svelte.ts`'s `openBundle`, and `packages/core/src/project/review-workspace.ts`
  for `REVIEW_MARK_PATH` and the mark's shape.
- `apps/editor/src/lib/components/ReviewBanner.svelte` — the persistent banner and its two exits. ADR-0024:
  *"Review is an action, not a mode you toggle."*
- Ticket 07's tree-and-raw read path. This ticket is that path with a filter over it.
- `apps/editor/src/lib/components/ProjectHub.svelte`'s `data-testid="open-bundle"` flow, for where the entry
  point sits and how a refusal is presented mid-open.

## Contract

**The unit is one Project plus what it references**, not the whole repository. From the Remote's tree, take
`<dir>/project.json`, its `annotations/`, and — by reading the Project's Layers — the `images/<id>/**` and
`alignments/<id>.json` at the Workspace root that those Layers name. Nothing else. A Workspace-shared
Historical Map that no Layer of this Project references does not travel.

**The result is a Review Workspace: unbound, and unpublishable.** `remote.json` is not written. Ticket 03's
two hard refusals apply and must be asserted here specifically, because this is the route that creates the
Workspace they protect against: binding is refused, and no credential is read or written while it is open.

**Several may exist at once**, named after what was opened, so a teacher marking thirty submissions can move
between them and two students' conflicting Alignments of the same sheet never meet. This is existing
behaviour; do not regress it.

**No promotion. No "keep this".** A reviewed Project cannot be moved into the user's own Workspace by any
route. If the user wants a colleague's map in their own research, they add the map themselves.

**No credential needed**, same as ticket 07. Public repositories only.

**Refuse a truncated tree** and check quota before starting, both for ticket 07's reasons.

### User Stories

50 (its editor half), and it is the enforcement site for 39 and 40.

## Out of scope

- **No promotion of a reviewed Project into the user's own Workspace**, by any affordance, in any dialog,
  under any wording. ADR-0024 is explicit and this is the most likely place for it to be helpfully
  reintroduced.
- **No binding, no publishing, no credential.** Assert the refusals rather than relying on absent UI.
- **No whole-Workspace download here.** That is ticket 07.
- **No Front Page link and no `?review=` URL parameter.** Ticket 09.
- **Do not change `openBundle`'s tar behaviour** or the Project Bundle format. Add beside.
- **Do not change how Review Workspaces are named, listed, or discarded.**

## Acceptance criteria

- [ ] Naming a public repository and a Project directory inside it creates a Review Workspace holding that
      one Project, and switches to it.
- [ ] The Review banner is shown and carries its two exits.
- [ ] The Project opens and renders, with its Historical Maps and Alignments present.
- [ ] A Workspace-shared Historical Map that no Layer of the chosen Project references is **not** downloaded.
- [ ] The resulting Workspace has no `remote.json`.
- [ ] Attempting to bind it is refused, asserted by calling the domain refusal directly.
- [ ] With it open, the credential store neither reads nor writes.
- [ ] No affordance anywhere offers to move the Project into the user's own Workspace.
- [ ] Two Review Workspaces opened from two repositories coexist, and the user's own Workspace is unchanged.
- [ ] Reviewing with no credential present succeeds.
- [ ] A truncated tree, and insufficient quota, are each refused before any byte is written.

```
pnpm --filter @ballastella/core test
pnpm test:e2e editor-review-remote
pnpm test:e2e editor-transfer
pnpm check
pnpm lint
```

Success: the new spec passes and the existing bundle-opening specs still do.

## Blocked by

- Ticket 07

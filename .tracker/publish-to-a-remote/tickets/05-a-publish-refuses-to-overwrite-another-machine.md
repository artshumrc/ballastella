# A publish refuses to overwrite another machine

## What to build

The second purpose of the publish manifest. Before a publish uploads anything, it compares the Remote's
current blob SHAs against what the manifest last saw. If the Remote holds a change this Workspace has never
seen, the publish is **refused** and the files are named, with two remedies offered: clone the Remote into a
new Workspace to see what is there, or publish anyway and replace it.

And the same instinct at bind time: binding is refused when the Remote already carries a
`ballastella-site.json` listing Projects this Workspace does not have.

This is the ticket that stops a scholar's laptop silently deleting their desktop's afternoon.

## Where to start

- ADR-0033's "The publish manifest, and the two refusals" section is this ticket's specification. Read it
  before anything else.
- The manifest that ticket 04 persists, and the tree listing ticket 02's engine already performs. Both
  exist; this slice adds a comparison between them and a refusal, not new I/O.
- `apps/editor/src/lib/workspace-storage.svelte.ts`'s bind path from ticket 03, for where the bind-time
  check goes.
- `packages/core/src/publish/publish.ts`'s `publishedSiteStaleness` — prior art for "compare a published
  record against the current Workspace and return a sentence." The bind-time check is the same shape
  pointed the other way.
- `apps/editor/src/lib/components/ProjectHub.svelte`'s `deleting` confirmation and
  `apps/editor/src/lib/components/WorkspaceSettings.svelte` — the house pattern for a two-step destructive
  confirmation where the second step names what is at stake.

## Contract

**The publish-time check.** For each path in the owned namespace, using the Remote tree the engine already
fetched:

| Remote's SHA equals | Meaning |
| --- | --- |
| the SHA we are about to write | already up to date, skip |
| the SHA the manifest last saw | ours, safe to replace |
| neither | **somebody else wrote it — refuse** |

**Compare per file, never by commit SHA.** A bare commit-SHA comparison refuses whenever *anything* moved,
including the user editing their own `README.md` on github.com — and a check that cries wolf trains people
to force. ADR-0033 states this as a rejected alternative; do not reintroduce it.

**"Publish anyway, replacing it" is safe to offer**, and it is worth understanding why before writing the
copy: ticket 02's owned namespace preserves everything outside itself, so the only thing a replace can
destroy is other Ballastella work. That is what lets the refusal be specific rather than a generic "the
remote has moved."

**With no manifest** — a first publish from this Workspace, or a manifest lost with browser storage — fall
back to the bind-time subset check and **say plainly that we cannot tell** whether the Remote holds newer
work. Refuse if the Remote's owned namespace is non-empty. Do not guess, and do not silently proceed.

**The bind-time check.** On binding, read the Remote's `ballastella-site.json`. If it lists Projects this
Workspace does not have, refuse the binding and name them; the remedy offered is Clone (ticket 07). This is
ADR-0024's *"restoring a backup creates a new named Workspace and switches to it — it never overwrites and
never merges"* applied to a repository.

**No merging, ever.** Three-way merge of `project.json`, GeoJSON, or an Alignment is out — it is the
collision ADR-0024 already refuses to answer, and there is no honest resolution for two Alignments of one
sheet. SPEC "Out of scope" item 14.

### User Stories

20, 21, 22, 23, 24.

## Out of scope

- **No pull, no fetch-and-merge, no rebase.** The remedy for a foreign change is Clone or replace.
- **No automatic conflict resolution and no per-file choosing.** Not "keep mine for this file, theirs for
  that one." One refusal, two remedies.
- **No diff UI.** Naming the paths is the whole of the reporting. SPEC "Out of scope" item 3.
- **No change to the owned-namespace rules.** Ticket 02 owns them; this ticket reads them.
- **Do not move the manifest into the store.** It is local-only, keyed by Workspace and backing. Putting it
  in the Workspace would publish it, and a manifest inside the tree it describes is circular.

## Acceptance criteria

- [ ] Two Workspaces bound to one fake Remote: A publishes, B publishes an older copy of the same Project,
      and B is refused with the changed path named.
- [ ] The refusal offers both remedies, and "publish anyway" completes and replaces.
- [ ] A file changed on the Remote *outside* the owned namespace — a `README.md` — does **not** trigger the
      refusal.
- [ ] A path whose Remote SHA equals what the manifest last saw is replaced without a refusal.
- [ ] With the manifest cleared and a non-empty owned namespace on the Remote, publishing is refused with a
      message saying we cannot tell.
- [ ] With the manifest cleared and an empty Remote, publishing proceeds.
- [ ] Binding to a Remote whose `ballastella-site.json` lists a Project this Workspace lacks is refused,
      names that Project, and points at Clone.
- [ ] Binding to a Remote whose Projects are a subset of this Workspace's succeeds.

```
pnpm --filter @ballastella/core test
pnpm test:e2e editor-remote-conflict
pnpm check
pnpm lint
```

The two-Workspace case is cheapest as a core test driving two stores against one fake; the refusal's
presentation is the e2e half. Success: both pass.

## Blocked by

- Ticket 04

# 07 - Allocate Import names without collisions

## What to build

Add deterministic Project display-name and directory allocation to the shared Import planner. Each
Import creates a distinct detached Project and fresh Map Images, respects reserved Workspace names,
and reserves every final path before the transaction can write.

Directory allocation must consider local, current Remote, and Synchronization Baseline Project
directories as separate evidence sources, while display-name allocation is based on visible local
Project names.

## Where to start

- Ticket 06's remapped closure and ticket 04's complete final-path reservation.
- `packages/core/src/project/workspace.ts`: `RESERVED_DIRECTORY_NAMES`,
  `isReservedDirectoryName`, `toDirectoryName`, `foldName`, `#takenNames`, and `#unusedDirectory`.
  Extract or deepen this existing allocation rule rather than creating a second filesystem-folding
  implementation.
- `packages/core/src/remote/publish-to-remote.ts`: `remoteProjectDirectories` recognizes a Project
  from a tree's top-level `project.json`.
- The Baseline path inventory supplied by synchronization tickets 01 and 02. Consume recognized
  Project directories, not arbitrary top-level names presented as Projects.
- `packages/core/src/store/project-store.ts`: path listing and no-overwrite behavior.
- Add the allocation matrix in
  `packages/core/src/transfer/project-import-allocation.test.ts`.

## Contract

Allocate the visible display name independently from the Project directory.

For display names, keep the incoming name when it does not collide with a local Project display name.
Otherwise choose the first available exact variant in this sequence:

```text
Name (imported)
Name (imported 2)
Name (imported 3)
...
```

Use the final display name only as the input to the existing slug rule. Allocate a collision-free
Project directory against the folded union of:

- reserved Workspace directory names;
- every top-level local path, including non-Project material;
- every Project directory recognized in the current Remote inventory;
- every Project directory recognized by the valid Synchronization Baseline.

Suffix directory slugs with the existing numeric convention until one is free. A directory may differ
from the display-name suffix; do not force the two namespaces to match. Case and Unicode composition
that alias on common folder filesystems count as collisions everywhere.

Reserve the entire destination closure, not just `project.json`: Project files, every fresh Map Image
path, every Alignment path, and every Annotation path must all be absent before the marker is written.
Any conflict refuses the Import without writing. Never use replace semantics for an imported path.

Running the same valid source twice repeats allocation from current state and produces another Project
directory and another set of fresh Map Image identities. It never recognizes the first Import as the
same source.

Ticket 17 wires current Remote inventory acquisition and own-Remote policy into this allocator. Keep
the allocator itself pure over explicit local, Remote, and Baseline inventories.

## User Stories

- **40.** As an author, I want imported Project names to respect reserved Workspace names, so that a Project cannot occupy `images`, `alignments`, or `base-map`.
- **41.** As an author, I want a display-name collision resolved with the suffix “(imported)”, so that both Projects remain visibly distinguishable.
- **42.** As an author, I want further collisions resolved as “Name (imported 2)” and later available variants, so that repeated detached copies can coexist.
- **43.** As an author, I want the imported Project assigned a collision-free directory independently of its display name, so that existing files are never overwritten.
- **44.** As an author, I want Import never to overwrite an existing Project, so that outside work cannot destroy my work.
- **45.** As an author, I want Import never to overwrite an existing Map Image, so that Map Images already used by my Projects remain unchanged.
- **46.** As an author, I want Import never to overwrite an existing Alignment, so that somebody else's interpretation cannot move my maps.
- **47.** As an author, I want Import never to overwrite an existing Annotation, so that my scholarly content remains intact.
- **68.** As an author, I want repeated imports of the same source to create distinct Projects and Map Images, so that detached copies never acquire hidden coupling.

## Out of scope

- Do not fetch a Remote or decide own-Remote policy in this pure allocator.
- Do not infer equivalence from provenance or content and do not offer reuse.
- Do not rename existing Projects, Map Images, Alignments, or Annotations to make room.
- Do not alter the normal New Project naming behavior except by extracting a genuinely shared folding
  or slugging primitive.
- Do not overwrite first and attempt rollback later; collision refusal precedes the transaction marker.

## Acceptance criteria

- [ ] The table covers no collision, first and later display-name collisions, reserved names,
      independent slug collisions, and case/Unicode aliases.
- [ ] Local, Remote-only, and Baseline-only recognized Project directories each reserve a candidate.
- [ ] A conflicting Project, Map Image, Alignment, or Annotation path refuses before the marker or any
      destination byte is written.
- [ ] Two imports of one fixture have different Project directories and disjoint fresh Map Image,
      Alignment, and Annotation destination paths.
- [ ] Existing destination bytes are snapshot-identical after every refusal.

```bash
pnpm --filter @ballastella/core test -- project-import-allocation
pnpm --filter @ballastella/core test -- workspace
pnpm precommit lint check test
```

Success: all three commands pass; the allocation table names the exact chosen display name and
directory for every local/Remote/Baseline collision, and before/after snapshots prove no overwrite.

## Blocked by

- 06

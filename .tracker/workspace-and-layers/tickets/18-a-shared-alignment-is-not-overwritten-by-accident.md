# A shared Alignment is not overwritten by accident

## What to build

One writer for `alignments/<image-id>.json`, and a fence that keeps it the only one.

ADR-0023 made an Alignment belong to the Workspace and be **shared by every Project that uses that map**. Nothing in the code was changed to reflect what that means for a *write*. Before, an Alignment belonged to one Project and clobbering it could only cost you the work in front of you; now it can cost somebody else's afternoon in a Project you are not looking at.

**Three separate tickets in this epic independently wrote a blind overwrite of that file**, none of them noticing, each caught only by review:

- **02** — `addReferencedMap` commits a chosen community Alignment with no existence check. Add a Library map to a second Project, accept the community offer, and the Control Points placed in the first Project are gone.
- **03** — `ensureMapLayerFor` routes through `writeAlignment` whenever the current Project lacks a Layer. Pressing **Align** on a map already aligned in another Project rewrites the shared file. `serialiseAlignment` regenerates from the model, so any field a third-party Georeference Annotation carries that `Alignment` does not model is silently dropped — against story 60, "an alignment I make [should be] usable by other IIIF tools" — and in a git or Dropbox Workspace, merely opening a view becomes a sync event.
- **02 again**, on the starter path — `#writeStarterAlignment` *does* guard, correctly, two lines from the unguarded community write. The guard existing right beside the hole is the clearest evidence that this is a missing invariant rather than three careless authors.

Ticket 01's fence for Project-rooted paths exists because "the failure mode is not an error". This is the same shape: an overwrite does not throw, does not log, and shows up as a colleague's Control Points quietly gone.

## Where to start

- `packages/core/src/alignment/alignment.ts` — `alignmentPath`, and whatever `serialiseAlignment` / `serialiseReferencedAlignment` do today.
- `apps/editor/src/lib/editor-session.svelte.ts` — `writeAlignment`, `#writeStarterAlignment`, `#hasAlignment`, `addReferencedMap`, and (if it still exists after ticket 03's reconciliation) `ensureMapLayerFor`.
- `scripts/check-workspace-rooted-paths.mjs` — the house pattern for a fence, including its positive control and its inline opt-out. Read it before writing a new one.
- `docs/adr/0023-*` and CONTEXT.md's **Align / Alignment** entry: "There is exactly one alignment per map image, belonging to the workspace and shared by every project that uses that map."

## Contract

**Exactly one function writes `alignments/<id>.json`.** Every other caller goes through it. Its signature must make the caller state which of three things they mean:

1. **Create** — write only if absent; refuse otherwise. This is the starter Alignment and the community offer.
2. **Update** — write the result of a user's edit to an Alignment they are looking at. This is Control Point placement.
3. **Replace** — deliberately discard an existing Alignment for a new one, only ever as the result of a user saying so, in words that name what is being lost.

A caller that cannot say which one it means is a caller that has not decided.

**Reading an Alignment must never write one.** Opening a view, resolving a Layer, computing an opening view, or listing the Workspace are all reads. If a read path needs an Alignment to exist, that is a bug in whatever was supposed to create it, not a licence to create it lazily.

**A round trip must not lose fields.** Story 60 requires an Alignment to stay usable by other IIIF tools. Whatever the single writer does, a Georeference Annotation carrying fields this build does not model must survive being read and written back. Preserve the unmodelled fields, or refuse to rewrite a document you did not author — pick one and test it with a fixture carrying an unknown field.

**A fence keeps it true.** No module outside the one owning module may build a write to an Alignment path. Follow the house pattern: a positive control, so the fence fails if it finds nothing to guard, and a narrow inline opt-out requiring a written reason. Test and e2e files are not exempt.

## Out of scope

- The Alignment *format*. This ticket is about who may write the file.
- Merging two Alignments, or any notion of conflict resolution between Projects. Refusing is enough.
- The `alignments/` location. Ticket 01 settled that.

## Acceptance criteria

1. Aligning a Map Image in Project A, placing Control Points, then adding the same map to Project B and accepting a community Alignment **does not destroy A's Control Points**. Whatever happens instead is visible to the user.
2. Opening the Align route for a map already aligned in another Project **writes nothing at all** — asserted by counting writes, not by byte-identity, which cannot tell an idempotent rewrite from no write.
3. A Georeference Annotation carrying a field this build does not model survives a read-and-write cycle, or the write is refused with a message saying why.
4. `grep` finds exactly one module building a path under `alignments/`; the fence reports the count and the exemptions on success.
5. The fence exits 1 on a planted violation and 0 once removed, and its positive control fails when its patterns are broken.
6. Every existing Alignment write in the app names which of create / update / replace it is.
7. `pnpm -r build && pnpm -r test && pnpm lint && pnpm check` and `pnpm test:e2e` pass.

Mutation check, mandatory: for criteria 1, 2 and 3, break the guard and confirm the test goes red. Criterion 5 is itself a mutation check — a fence that cannot fail is the defect ticket 01 shipped.

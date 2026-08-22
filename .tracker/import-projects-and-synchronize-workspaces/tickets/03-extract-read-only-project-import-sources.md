# 03 - Extract read-only Project Import sources

## What to build

Extract a read-only source boundary that can gather and validate one Project closure from a Project
Bundle, a Published GitHub Project, or an existing Review Workspace without giving any source reader
the ability to write into an ordinary Workspace. Preserve the existing Review flows while making the
validated closure available to the shared Import engine built by later tickets.

This slice stops at a validated source description and byte readers. It does not allocate destination
names or identities and does not install anything.

## Where to start

- `packages/core/src/transfer/open-project-bundle.ts`: `layerReferences`,
  `assertReferencesPresent`, tar path validation, future-format refusal, and the current coupling of
  bundle reading to a `ReviewDestination`.
- `packages/core/src/remote/review-from-remote.ts`: `gather`, `readReviewTree`, blob-SHA validation,
  quota calculation, and the current GitHub closure reader.
- `packages/core/src/transfer/export-project-bundle.ts`: `sharedEntries` and `isViewerFile`, which
  define the Project-relative bundle closure and generated-file exclusion from the writing side.
- `packages/core/src/project/project-file.ts`: `parseProjectFile` and
  `ProjectFormatTooNewError`. Parsing must retain the current forward-compatible field behavior.
- `packages/core/src/store/project-store.ts`: `ReadOnlyProjectStore`. The Review Workspace adapter
  should expose this capability, not `ProjectStore`.
- `packages/core/src/project/review-workspace.ts`: the existing Review mark and structural fence.
- Existing tests in `packages/core/src/transfer/project-bundle.test.ts` and
  `packages/core/src/remote/review-from-remote.test.ts`; add the shared source contract in
  `packages/core/src/transfer/project-import-source.test.ts` rather than repeating it per adapter.

## Contract

Define one source-facing representation for a validated Project closure. It must provide the parsed
Project, the source paths belonging to the closure, bounded access to each file's bytes, and only
directly observed source evidence needed by later provenance work. It must not contain an ordinary
writable destination, a Remote binding to adopt, Workspace settings, credentials, or generated
Published Site output.

The closure is exactly:

- root `project.json` in a Project Bundle, or `<directory>/project.json` in a Workspace-shaped source;
- every Annotation path referenced by the Project's Layers;
- each distinct referenced Map Image directory and its optional Alignment;
- image metadata and either the stored pyramid or the referenced-image record needed to read it.

Exclude unrelated Projects, unused Workspace Map Images, Base Map files, Workspace settings,
`remote.json` as a Workspace binding, and files classified by `isViewerFile`. A Map Image's own
referenced-image `remote.json` remains part of that Map Image.

Validation happens before a source is offered for installation. Refuse unsafe paths, malformed or
unsupported `project.json`, duplicate authoritative entries, incomplete image descriptions, missing
Annotations, missing Map Images, and missing Alignments when the Project actually references one.
Validate the closure as a graph so every retained Project reference resolves. Keep the existing rule
that an unaligned Map Image legitimately has no Alignment.

The source side is read-only by construction:

- Project Bundle and GitHub adapters may read external bytes and may still populate a newly created
  Review Workspace through the existing Review orchestration, but their reusable source capability
  cannot accept an ordinary `ProjectStore` destination.
- A Review Workspace source is typed as `ReadOnlyProjectStore` plus its source metadata.
- Only the later Import engine may combine a validated closure with a writable ordinary Workspace.

Replace stale no-promotion module contracts, test names, and user-facing source descriptions only
where needed to state this new boundary accurately. Review remains isolated; this ticket does not add
an Import route.

## User Stories

- **15.** As an author, I want malformed or incomplete Import sources refused before installation, so that invalid work is not added to my Workspace.
- **16.** As an author, I want a Project format newer than the application understands refused plainly, so that an older Ballastella does not damage unfamiliar work.
- **20.** As an author, I want Import to leave the source Project and source Workspace untouched, so that receiving work never modifies its origin.
- **25.** As an author, I want Import limited to the selected Project and its referenced closure, so that unrelated Projects and unused assets are not copied.
- **26.** As an author, I want generated Published Site files excluded from Project Import, so that a Project does not carry stale viewer output into my Workspace.
- **38.** As an author, I want the prospective imported closure validated as a graph, so that every committed reference resolves.
- **39.** As an author, I want an Import with a missing Map Image, Alignment, or Annotation refused, so that no dangling Layer is installed.
- **164.** As a maintainer, I want Review source readers to remain unable to write into an ordinary Workspace, so that only the Import engine can cross the structural boundary from outside work into owned work.

## Out of scope

- Do not write any source byte into an ordinary Workspace.
- Do not allocate Project names, Project directories, or fresh Map Image identities.
- Do not implement transaction markers, quota preflight for destination installation, or recovery.
- Do not add Import controls or change the shipped invitation URL parameters.
- Do not loosen Review Workspace publish, bind, backup, or credential fences.
- Do not parse and reserialize Annotation content merely to validate it; validate references and retain
  the bytes.

## Acceptance criteria

- [ ] One shared source contract accepts valid Bundle, GitHub, and Review Workspace fixtures and
      reports the same logical closure for each.
- [ ] The closure contains only the selected Project, referenced Annotations, distinct referenced Map
      Images, their image metadata or pyramids, and their present Alignments.
- [ ] Generated viewer files, Base Map files, unrelated Projects, unused Map Images, Workspace
      settings, and Workspace Remote binding files are absent.
- [ ] Malformed paths, malformed or too-new Project files, duplicate authoritative entries, and every
      missing-reference class are refused before any destination write is possible.
- [ ] The source capability's public type has no `write`, `delete`, ordinary destination, or credential.
- [ ] Existing Project Bundle Review and GitHub Review behavior remains green.

```bash
pnpm --filter @ballastella/core test -- project-import-source
pnpm --filter @ballastella/core test -- project-bundle
pnpm --filter @ballastella/core test -- review-from-remote
pnpm precommit lint check test
```

Success: all four commands pass; the new source-contract spec proves identical closure membership and
pre-install refusal across all three adapters, and TypeScript rejects attempts to pass an ordinary
writable destination to a source reader.

## Blocked by

None - can start immediately

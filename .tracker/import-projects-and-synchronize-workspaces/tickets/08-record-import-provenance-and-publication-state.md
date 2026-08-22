# 08 - Record Import Provenance and publication state

## What to build

Extend Project metadata with optional, read-only Import Provenance and apply the publication reset that
makes every imported Project a detached local copy. Each transfer preserves earlier entries as
inherited evidence, appends one entry containing only facts Ballastella directly observed, clears the
source publication address, and keeps the imported Project off the Front Page.

Show this history with the imported Project without presenting it as editable authorship metadata.

## Where to start

- `packages/core/src/project/project-file.ts`: `ProjectFile`, `parseProjectFile`,
  `serialiseProjectFile`, `canonicalUrl`, `onFrontPage`, and `unknownFields` round trips.
- Ticket 03's source-specific observed evidence and ticket 06's remapped Project model.
- `packages/core/src/transfer/export-project-bundle.ts`: Project metadata already travels in
  `project.json`; no second provenance file is needed.
- `packages/core/src/remote/review-from-remote.ts` and
  `packages/core/src/transfer/open-project-bundle.ts`: observed repository/commit/address and
  filename/embedded-name evidence.
- `apps/editor/src/lib/project/ProjectScreen.svelte`: the imported Project's working surface and the
  preferred place for read-only Project facts.
- `apps/editor/src/lib/components/ProjectHub.svelte`: Project summaries and Front Page language; do
  not imply that absence from the Front Page is access control.
- Add the metadata matrix in
  `packages/core/src/transfer/project-import-provenance.test.ts` and fold the visible browser assertion
  into `e2e/editor-transfer.e2e.ts`.

## Contract

Add optional Import Provenance to `ProjectFile`. The conceptual entry union is:

```ts
type ImportProvenanceEntry =
	| {
			kind: 'github';
			repository: string;
			projectAddress: string;
			commit: string;
			observedAt: string;
			evidence: 'observed' | 'inherited';
	  }
	| {
			kind: 'project-bundle';
			filename: string;
			projectName: string;
			observedAt: string;
			evidence: 'observed' | 'inherited';
	  }
	| {
			kind: 'review';
			projectName: string;
			observedAt: string;
			evidence: 'observed' | 'inherited';
	  };
```

The concrete GitHub shape may normalize owner, repository, and branch, but it must retain repository,
Project address, and commit evidence. It must not contain credentials, an active Remote, a claim of
authorship, or a claim about ownership of scholarship.

On each transfer, preserve existing entries in order but change their evidence to `inherited`; append
one `observed` entry for the current adapter using only directly observed facts. A filename is a
filename, not an account or author. A carried source claim is inherited, not independently verified.
Ordinary Project edits and export must preserve the optional array unchanged. Export followed by
Import must inherit the carried entries and append the new transfer.

For every imported Project, regardless of source:

- set `onFrontPage` to `false`;
- set `canonicalUrl` to `null` and omit it on serialization;
- retain the observed source publication address only in the current provenance entry when one was
  actually observed;
- leave `updatedAt` unchanged merely for the fact of transfer.

Render provenance as read-only text associated with the Project. Clearly distinguish observed from
inherited entries and transfer history from scholarly attribution. When the Project is later
published, its absence from the Front Page must still be described as a listing choice, not privacy.

Projects with no provenance remain valid and byte-compatible except when another edit writes them.

## User Stories

- **52.** As an author, I want an imported Project initially kept off the Front Page, so that copying work does not feature it automatically.
- **53.** As an author, I want the source Project's Front Page choice ignored, so that another publisher's editorial choice does not become mine.
- **54.** As an author, I want Front Page absence still described as public after Publish, so that I do not mistake it for access control.
- **55.** As an author, I want the source publication address removed from the imported Project's publication identity, so that the copy does not claim the source address as its own.
- **56.** As an author, I want the source publication address retained in Import Provenance, so that the historical route remains inspectable.
- **57.** As an author, I want Import Provenance visible with the imported Project, so that I can see how the copy reached my Workspace.
- **58.** As an author, I want Import Provenance read-only, so that observed transfer history is not presented as ordinary editable metadata.
- **59.** As an author, I want a GitHub provenance entry to record the observed repository, Project address, and commit, so that the copied state is identifiable.
- **60.** As an author, I want a Project Bundle provenance entry to record the observed filename and embedded Project name, so that the handoff artifact is identifiable.
- **61.** As an author, I want provenance limited to facts Ballastella observed, so that it never turns a filename or account into an unsupported claim.
- **62.** As a scholar, I want Import Provenance to avoid authorship claims, so that transfer history is not mistaken for scholarly attribution.
- **63.** As an author, I want inherited provenance preserved when a Project is transferred again, so that earlier handoffs are not erased.
- **64.** As an author, I want inherited provenance identified as inherited rather than independently verified, so that its evidentiary status is honest.
- **65.** As an author, I want each transfer to append provenance instead of replacing it, so that the Project retains a transfer history.
- **66.** As an author, I want ordinary edits to preserve Import Provenance, so that developing the Project does not erase its history.
- **67.** As an author, I want exporting and re-importing a Project to preserve and extend provenance, so that a chain of handoffs remains visible.

## Out of scope

- Do not verify authorship, sign bundles, add cryptographic provenance, or infer attribution.
- Do not make provenance editable or use it as a synchronization relationship.
- Do not add Project-level Remotes or preserve the source publication address as active identity.
- Do not make Front Page absence private, hidden, or unpublished.
- Do not stamp `updatedAt` solely because an Import occurred.
- Do not add browser tests for metadata permutations that the core model seam can prove.

## Acceptance criteria

- [ ] `ProjectFile` parses and serializes absent, observed, and inherited provenance without dropping
      supported unknown fields.
- [ ] Bundle, GitHub, and Review transfers append the exact source-specific observed facts and convert
      carried entries to inherited without inventing an author or credential.
- [ ] Every imported Project serializes with no `canonicalUrl`, with `onFrontPage: false`, and with its
      source address retained only in provenance when observed.
- [ ] Ordinary edits and bundle export/re-import preserve and extend the ordered history while leaving
      the source `updatedAt` unchanged at import time.
- [ ] The editor visibly labels provenance as read-only transfer history and distinguishes observed
      from inherited evidence.
- [ ] The Front Page control continues to state that omission is not access control.
- [ ] Any new Seam 2 assertion is folded into `editor-transfer`; a ceiling increase requires the dated
      justification row mandated by `scripts/check-seam-2-size.mjs`.

```bash
pnpm --filter @ballastella/core test -- project-import-provenance
pnpm --filter @ballastella/core test -- project-file
node scripts/check-seam-2-size.mjs
pnpm test:e2e editor-transfer
pnpm precommit
```

Success: all five commands pass; core round trips prove the full inheritance chain and publication
reset, the running editor shows non-editable transfer history, and the Seam 2 count is within its
recorded ceiling or has the required dated justification.

## Blocked by

- 03
- 06

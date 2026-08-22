# 02 - Separate synchronization source from Published Site output

## What to build

Create one shared classifier for repository and Workspace paths that separates synchronization source content, Publish-owned generated output, and repository files Ballastella does not own. Use it consistently for inventories, Project-directory recognition, status inputs, Update filtering, and Publish preservation. Extend generated Published Site metadata with the repository return-link coordinates needed by Readers, while keeping those published coordinates incapable of binding an editor installation.

## Where to start

- `packages/core/src/remote/publish-to-remote.ts` currently defines `remoteProjectDirectories` and `isOwnedPath`; these mix authored source, viewer output, `remote.json`, and repository preservation in one Publish-era predicate.
- `packages/core/src/transfer/viewer-files.ts` records generated viewer paths through `VIEWER_FILE_PATHS`, `isViewerFile`, and `claimedByPublishing`.
- `packages/core/src/publish/publish.ts` defines and writes `PublishedSite`, `ballastella-site.json`, Base Map output, and existing editor return-link metadata.
- `packages/core/src/base-map/tile-cache.ts` and `packages/core/src/base-map/offline-cache.ts` distinguish `base-map/tiles/**` from generated Base Map assets.
- `packages/core/src/project/project-file.ts`, `packages/core/src/project/image-files.ts`, and `packages/core/src/alignment/alignment.ts` name the authored Project, Map Image, Annotation, and Alignment paths.
- `packages/core/src/remote/return-link.ts` is the shared builder/parser for the shipped `clone` and `review` parameters.
- Existing tests are `packages/core/src/remote/publish-to-remote.test.ts`, `packages/core/src/remote/return-link.test.ts`, `packages/core/src/publish/publish.test.ts`, `e2e/editor-publish.e2e.ts`, and `e2e/viewer-reader.e2e.ts`.

## Contract

- Expose one pure path-classification API used by synchronization and Publish. It must classify at least `source`, `published-output`, and `outside-ballastella`; callers must not restate path-prefix rules.
- Source content includes every recognized Project directory and its files, Workspace Map Images, Alignments, Annotations, Offline Copies, and `base-map/tiles/**`.
- A Project directory is recognized from the union of local inventory, current Remote inventory, and Baseline inventory whenever that directory has or had a top-level `project.json`. Keep the directory source-owned until synchronization establishes complete deletion.
- Published output includes `_app/**`, `index.html`, `.nojekyll`, `robots.txt`, `ballastella-site.json`, and generated Base Map fonts, sprites, and extracts. Different editor versions may make this output stale, but it cannot create source drift or Conflict and Update never downloads it.
- Files outside Ballastella's namespace remain outside ownership and are preserved by Publish. This includes README, LICENSE, CNAME, workflows, submodules, and unrelated repository directories.
- `remote.json` is compatibility/published-site evidence, not synchronized source and not an installation binding. Do not let the classifier reintroduce it as authored local state.
- Published Site metadata may carry normalized repository coordinates and editor address solely to construct return links. Its parser remains tolerant of older sites. Opening, importing, restoring, or updating must never promote those fields into installation-local metadata.
- Preserve the existing `?clone=owner/repository` and `?review=owner/repository&p=directory` URL shapes and the one cleanup path in `withoutReturnLink`.
- Preserve exact-mirror behavior inside Ballastella's publish-owned namespace while keeping outside files untouched.

## User Stories

- 119. As an author, I want synchronization status computed across authored Workspace files and Offline Copies, so that Projects, Map Images, Alignments, Annotations, and offline Base Map data remain one Workspace state.
- 120. As an author, I want generated-viewer differences described separately as a Published Site needing republishing, so that Publish-owned output is not mistaken for changed scholarship or an inbound Update.
- 143. As an author, I want Project directories recognized from the local Workspace, current Remote inventory, and Baseline, so that Import allocation, additions, and deletions cannot manufacture a collision with unseen Remote work.
- 145. As an author, I want Offline Copies synchronized with authored data while generated Published Site files remain Publish-owned output, so that another editor version cannot create perpetual inbound viewer churn.
- 146. As a publisher, I want repository return-link metadata generated during Publish rather than synchronized as a local binding, so that the Published Site can point back without controlling my Workspace.
- 166. As an author, I want Update to ignore Publish-owned viewer output while synchronizing Offline Copies and authored files, so that different editor versions do not exchange obsolete `_app` bundles.

## Out of scope

- Do not compute the six Remote Status states or operation plans; ticket 09 consumes this classifier.
- Do not implement Update transfer or its atomic transaction; tickets 14 and 15 own those operations.
- Do not change Open vocabulary or URL parameter names; ticket 11 changes the visible language while preserving the parser.
- Do not implement Project Import allocation, even though its later allocator will consume the recognized directory union.
- Do not broaden Ballastella ownership to convenience files such as README or workflow configuration.

## Acceptance criteria

- [ ] A table-driven core spec classifies authored Projects/Annotations, images, Alignments, Offline Copies, and `base-map/tiles/**` as source; viewer and generated Base Map assets as published output; and representative repository files/submodules as outside.
- [ ] Tests prove Project directories discovered only locally, only remotely, and only in the Baseline remain source-owned, including all paths below the directory until complete deletion.
- [ ] Existing Publish tests prove outside files survive exact-tree commits while obsolete Publish-owned output can be replaced or removed.
- [ ] Planner-facing inventories exclude published output from source comparisons but expose a separate Published Site staleness result.
- [ ] Published Site and return-link tests prove new repository metadata produces the existing invitation URL shapes, old metadata remains readable, and no published field can create an installation-local binding.
- [ ] Update-facing classifier tests prove `_app/**` and other generated output are excluded while Offline Copies and cached Base Map tiles are included.

Run these commands from the repository root:

```bash
pnpm --filter @ballastella/core test -- src/remote/synchronization-paths.test.ts src/remote/publish-to-remote.test.ts src/remote/return-link.test.ts src/publish/publish.test.ts
pnpm -r build
pnpm test:e2e editor-publish viewer-reader
pnpm precommit lint check test
```

Success is all commands exiting zero; the classifier matrix has one result for every listed path class, the Remote tree still preserves non-owned files, and the browser specs produce working return links without creating a local Remote from published metadata.

## Blocked by

- 01-establish-installation-local-sync-evidence.md

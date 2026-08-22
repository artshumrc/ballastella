# 06 - Remap imported Project closures

## What to build

Add the pure planning phase that turns a validated incoming closure into a detached destination
closure. Allocate one fresh Map Image identity per distinct incoming Map Image, rewrite every
identity-bearing path and reference through its owning domain parser and serializer, and preserve the
Project's scholarly content.

The output is a complete graph ready for ticket 04's atomic writer. It must not retain hidden sharing
with either the source or an existing destination Map Image.

## Where to start

- Ticket 03's validated closure and ticket 04's planned final-path input.
- `packages/core/src/project/project-file.ts`: `parseProjectFile`, `serialiseProjectFile`, and
  `unknownFields` preservation.
- `packages/core/src/project/layer.ts`: `parseLayers` and `serialiseLayers`; do not rewrite Layer JSON
  with ad-hoc object surgery.
- `packages/core/src/alignment/georeference-annotation.ts`: `parseAlignment`,
  `serialiseAlignment`, `AlignmentAddress`, unknown-member preservation, Resource Mask, Control Point,
  and transformation handling.
- `packages/core/src/alignment/alignment-file.ts`: the sole Alignment write boundary.
- `packages/core/src/project/image-files.ts` and `packages/core/src/tiler/pyramid.ts`:
  `imageServiceId` is the local `https://unset.invalid/<fresh-id>` placeholder.
- `packages/core/src/remote-iiif/referenced-image.ts`: `parseReferencedImage` and
  `serialiseReferencedImage`; genuine Library service, rights, attribution, Manifest, and Canvas
  evidence live here and must survive.
- `packages/core/src/remote-iiif/offline-copy.ts`: both a stored pyramid and a referenced-image record
  may be present for an Offline Copy.
- Add the exhaustive matrix in
  `packages/core/src/transfer/project-import-remapping.test.ts` over `MemoryProjectStore` fixtures.

## Contract

Create one old-to-new Map Image identity map for one Import. Generate a fresh destination identity for
every distinct source Map Image without comparing service URI, bytes, title, provenance, or Alignment
content. Repeated Layers naming one source identity map to one fresh identity; different source
identities always map to different fresh identities.

Rewrite all paths under `images/<old-id>/` to `images/<new-id>/`, each present Alignment path to
`alignments/<new-id>.json`, and every Map Layer's `imageId` to the same fresh identity. Copy the Project
file and every referenced Annotation into the new Project directory; preserve Layer ordering,
Annotation bytes, and supported unknown Project and Layer fields.

For each Alignment, parse it with the source path identity, set the model's image identity to the fresh
identity, and serialize it through the Alignment model. Preserve Control Points, Resource Mask,
transformation type, dimensions, and preservable unknown members. Never patch `resource.id` directly.

Address handling has two explicit branches:

- A local pyramid, including an Offline Copy, gets `info.json.id` reset to
  `imageServiceId(freshIdentity)`. Its Alignment's local resource identifier is regenerated through
  `serialiseAlignment` with no Library address.
- A genuine referenced Library Map Image keeps the canonical Library service in its referenced-image
  metadata and passes that service as the Alignment address. Preserve label, rights, attribution,
  Manifest, Canvas, dimensions, tile size, and all other supported evidence. If an Offline Copy also
  has that record, preserve the record while still resetting the stored pyramid's publication stamp.

Clear no Project-level publication or Front Page fields here; ticket 08 owns publication reset and
provenance in one place. Validate the remapped graph again before handing it to the transaction.

## User Stories

- **21.** As an author, I want Import to copy the Project file, so that the Layer stack and Project settings are preserved.
- **22.** As an author, I want Import to copy every referenced Annotation, so that the imported scholarly content is complete.
- **23.** As an author, I want Import to copy every referenced Map Image, so that every imported map Layer can render.
- **24.** As an author, I want Import to copy every referenced Alignment, so that each Map Image retains its incoming placement on the earth.
- **27.** As an author, I want every incoming Map Image assigned a fresh identity, so that an imported Alignment cannot alter an existing Map Image.
- **28.** As an author, I want a fresh identity even when the incoming Map Image appears identical to one I already have, so that Import never creates hidden sharing.
- **29.** As an author, I want repeated references to one incoming Map Image mapped to one fresh identity, so that Layers within the imported Project continue sharing that Map Image.
- **30.** As an author, I want distinct incoming Map Images kept distinct, so that Import does not collapse separate scholarly objects.
- **31.** As an author, I want every imported map Layer rewritten to its fresh Map Image identity, so that no Layer points back to the source Workspace.
- **32.** As an author, I want a stored pyramid's stamped source publication identifier reset to Ballastella's local placeholder for its fresh identity, so that the imported copy neither claims the source Published Site nor breaks local tile resolution.
- **33.** As an author, I want each imported Alignment stored under its fresh Map Image identity, so that one Alignment still belongs to one Map Image.
- **34.** As an author, I want a local Alignment resource identifier rewritten through the Alignment model, so that its content and its stored Map Image agree.
- **35.** As an author, I want an imported Alignment's Control Points, Resource Mask, and transformation type preserved, so that Import does not change the scholarly interpretation.
- **36.** As an author, I want a genuine Library IIIF service, rights, attribution, Manifest, and Canvas metadata preserved separately from a stored pyramid's publication stamp, so that an imported referenced or Offline Copy remains citable without retaining the source Workspace's IIIF identity.
- **37.** As an author, I want Layer, Annotation, and unknown forward-compatible Project fields preserved, so that Import does not discard supported source content.

## Out of scope

- Do not deduplicate Map Images or reuse a destination identity under any heuristic.
- Do not merge Alignment, Annotation, or Project content.
- Do not rewrite Alignment JSON or `info.json` identifiers with ad-hoc nested-object mutation when a
  domain parser or serializer owns the field.
- Do not allocate the destination Project display name or directory.
- Do not set Front Page membership, publication identity, or Import Provenance.
- Do not add a source-specific remapping implementation; all adapters use this one planner.

## Acceptance criteria

- [ ] A fixture with repeated and distinct Map Image references produces the exact expected one-to-one
      old-to-new identity map and no reused destination identity.
- [ ] Every Map Layer, image path, Alignment path, Alignment resource identity, and local `info.json`
      stamp agrees on the fresh identity.
- [ ] Control Points, Resource Mask, transformation type, Project settings, Layer fields, Annotation
      bytes, and supported unknown fields survive the remap.
- [ ] Referenced and Offline Copy fixtures preserve genuine Library service and citation metadata while
      stored pyramids use the local placeholder.
- [ ] The remapped closure passes the graph validator and a deliberately broken rewrite is caught by a
      mutation check.

```bash
pnpm --filter @ballastella/core test -- project-import-remapping
pnpm --filter @ballastella/core test -- georeference-annotation
pnpm --filter @ballastella/core test -- referenced-image
pnpm precommit lint check test
```

Success: all four commands pass; byte and parsed-model assertions prove every identity rewrite and
preservation branch, and removing any Layer, Alignment, or pyramid rewrite makes the new spec fail.

## Blocked by

- 03
- 04

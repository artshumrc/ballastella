// Where a Historical Map's tiles live **in the Workspace**: three path joins and nothing else
// (ADR-0023).
//
// **These are store paths, not Project-relative fragments.** That is the whole of ADR-0023 as far as
// this module is concerned: a Historical Map's pyramid is shared by every Project in the Workspace, so
// `images/<image-id>/info.json` is the path, complete, and nothing prefixes a Project directory onto
// it. `scripts/check-workspace-rooted-paths.mjs` is what keeps it that way — the failure mode of
// getting it wrong is a pane showing somebody else's map rather than an error.
//
// **Here rather than in `tiler/pyramid.ts`, where they used to be, because the Layer model needs the
// image directory too.** `layer.ts` reaching into the tiler for it made the Layer model import a
// module that value-imports `@allmaps/iiif-parser`. That is the half of ADR-0019 no script checks:
// `apps/viewer` reads the Layer stack, must never depend on the tiler, and its leanness is enforced by
// the dependency graph rather than by tree-shaking — which is not a boundary. So the Workspace's own
// layout (ADR-0023) lives beside the Project's model, and the tiler imports it rather than the other
// way round.
//
// The names are the ones the writer and every reader must agree on, so there is exactly one of each.

import type { StorePath } from '../store/project-store.js';

/** Where the Workspace keeps every Historical Map's pyramid (ADR-0023). */
export const IMAGE_DIRECTORY = 'images';

/** Where one Historical Map's pyramid lives in the Workspace. A store path. */
export const imageDirectory = (imageId: string): StorePath => `${IMAGE_DIRECTORY}/${imageId}`;

/** The path of a Historical Map's `info.json` in the Workspace. A store path. */
export const imageInfoPath = (imageId: string): StorePath => `${imageDirectory(imageId)}/info.json`;

/** The path of a Historical Map's IIIF Presentation manifest in the Workspace. A store path. */
export const imageManifestPath = (imageId: string): StorePath =>
	`${imageDirectory(imageId)}/manifest.json`;

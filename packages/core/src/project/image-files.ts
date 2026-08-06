// Where a Historical Map's tiles live inside a Project directory: three path joins and nothing else.
//
// **Here rather than in `tiler/pyramid.ts`, where they used to be, because a Layer needs them.**
// `mapLayerImageInfoPath` is how a map Layer names the `info.json` that makes its pyramid readable —
// the Layer → Alignment → image link ticket 13's importer follows — and `layer.ts` reaching into the
// tiler for it made the Layer model import a module that value-imports `@allmaps/iiif-parser`. That is
// the half of ADR-0019 no script checks: `apps/viewer` reads the Layer stack, must never depend on the
// tiler, and its leanness is enforced by the dependency graph rather than by tree-shaking — which is
// not a boundary. So the Project's own layout (ADR-0006, ADR-0008) lives beside the Project's model,
// and the tiler imports it rather than the other way round.
//
// The names are the ones the writer and every reader must agree on, so there is exactly one of each.

import type { StorePath } from '../store/project-store.js';

/** Where a Project keeps its Historical Maps' pyramids, relative to the Project (ADR-0006). */
export const IMAGE_DIRECTORY = 'images';

/** Where one image's pyramid lives inside a Project directory. */
export const imageDirectory = (imageId: string): StorePath => `${IMAGE_DIRECTORY}/${imageId}`;

/** The path of an image's `info.json`, relative to the Project directory. */
export const imageInfoPath = (imageId: string): StorePath => `${imageDirectory(imageId)}/info.json`;

/** The path of an image's IIIF Presentation manifest, relative to the Project directory. */
export const imageManifestPath = (imageId: string): StorePath =>
	`${imageDirectory(imageId)}/manifest.json`;

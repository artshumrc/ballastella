import { generateRandomId } from '@allmaps/id';

import { alignmentPath } from '../alignment/alignment.js';
import {
	parseAlignment,
	serialiseAlignment,
	type AlignmentAddress
} from '../alignment/georeference-annotation.js';
import { IMAGE_DIRECTORY, imageInfoPath } from '../project/image-files.js';
import {
	inheritImportProvenance,
	type ImportProvenanceEntry
} from '../project/import-provenance.js';
import type { Layer } from '../project/layer.js';
import { tileLocation } from '../project/map-images.js';
import {
	PROJECT_FILE_NAME,
	serialiseProjectFile,
	type ProjectFile
} from '../project/project-file.js';
import { hoistedImageId } from '../project/workspace.js';
import {
	parseReferencedImage,
	referencedAlignmentAddress,
	referencedImagePath,
	serialiseReferencedImage
} from '../remote-iiif/referenced-image.js';
import { jsonObjectOrNull, serialiseJson, type Bytes } from '../store/project-store.js';
import { imageServiceId } from '../tiler/pyramid.js';
import {
	gatherProjectClosure,
	type ClosureFile,
	type ClosurePath,
	type ProjectImportOrigin,
	type ProjectImportSource
} from './project-import-source.js';

type MintImageId = () => string | Promise<string>;

export async function remapProjectImport(
	source: ProjectImportSource,
	options: { readonly imageId?: MintImageId } = {}
): Promise<{
	readonly images: ReadonlyMap<string, string>;
	readonly closure: ProjectImportSource;
}> {
	const mint = options.imageId ?? generateRandomId;
	const images = await allocate(source.paths, mint);
	const project = {
		...source.project,
		layers: source.project.layers.map((layer) => remapLayer(layer, images))
	};
	const projectFileBytes = serialiseProjectFile(project);
	const paths = source.paths.map((path) => remapClosurePath(path, images));
	assertRemappedGraphResolves(project, paths);

	return {
		images,
		closure: {
			origin: source.origin,
			project,
			projectFileBytes,
			paths,
			totalBytes: source.totalBytes,
			files: () => remapFiles(source, images, projectFileBytes)
		}
	};
}

async function allocate(
	paths: readonly ClosurePath[],
	mint: MintImageId
): Promise<ReadonlyMap<string, string>> {
	const images = new Map<string, string>();
	const taken = new Set<string>();
	for (const path of paths) {
		const source = hoistedImageId(path);
		if (source === null || images.has(source)) continue;
		const fresh = await mint();
		if (fresh === '' || fresh.includes('/')) {
			throw new Error(`“${fresh}” is not usable as a Map Image identity.`);
		}
		if (taken.has(fresh)) {
			throw new Error(
				`“${fresh}” was allocated to two of this Import's Map Images, which would merge them.`
			);
		}
		taken.add(fresh);
		images.set(source, fresh);
	}
	return images;
}

function remapClosurePath(path: ClosurePath, images: ReadonlyMap<string, string>): ClosurePath {
	const source = hoistedImageId(path);
	if (source === null) return path;
	const fresh = images.get(source);
	if (fresh === undefined) return path;
	if (path === alignmentPath(source)) return alignmentPath(fresh);
	return `${IMAGE_DIRECTORY}/${fresh}/${path.slice(`${IMAGE_DIRECTORY}/${source}/`.length)}`;
}

const remapLayer = (layer: Layer, images: ReadonlyMap<string, string>): Layer =>
	layer.kind !== 'map' || layer.imageId === ''
		? layer
		: { ...layer, imageId: images.get(layer.imageId) ?? layer.imageId };

async function* remapFiles(
	source: ProjectImportSource,
	images: ReadonlyMap<string, string>,
	projectFileBytes: Bytes
): AsyncIterable<ClosureFile> {
	const alignments = new Map<string, Bytes>();
	const services = new Map<string, string>();
	const pyramids = new Set<string>();

	for await (const file of source.files()) {
		const image = hoistedImageId(file.path);
		if (image === null) {
			yield {
				path: file.path,
				bytes: file.path === PROJECT_FILE_NAME ? projectFileBytes : file.bytes
			};
			continue;
		}
		const fresh = images.get(image) as string;
		const path = remapClosurePath(file.path, images);

		if (file.path === alignmentPath(image)) {
			alignments.set(image, file.bytes);
			continue;
		}
		if (file.path === imageInfoPath(image)) {
			pyramids.add(image);
			yield { path, bytes: stampLocalPyramid(file.bytes, fresh) };
			continue;
		}
		if (file.path === referencedImagePath(image)) {
			const record = parseReferencedImage(file.bytes, { imageId: image });
			services.set(image, record.service);
			yield { path, bytes: serialiseReferencedImage({ ...record, imageId: fresh }) };
			continue;
		}
		yield { path, bytes: file.bytes };
	}

	for (const [image, bytes] of alignments) {
		const fresh = images.get(image) as string;
		yield {
			path: alignmentPath(fresh),
			bytes: serialiseAlignment(
				{ ...parseAlignment(bytes, { imageId: image }), imageId: fresh },
				addressOf(image, pyramids, services)
			)
		};
	}
}

function addressOf(
	image: string,
	pyramids: ReadonlySet<string>,
	services: ReadonlyMap<string, string>
): AlignmentAddress {
	const location = tileLocation({
		infoJson: pyramids.has(image),
		remoteJson: services.has(image)
	});
	if (location !== 'referenced') return {};
	return referencedAlignmentAddress(services.get(image) as string);
}

function stampLocalPyramid(bytes: Bytes, fresh: string): Bytes {
	const raw = jsonObjectOrNull(bytes);
	if (raw === null) return bytes;
	return serialiseJson({ ...raw, id: imageServiceId(fresh) });
}

function assertRemappedGraphResolves(project: ProjectFile, paths: readonly ClosurePath[]): void {
	const closure = gatherProjectClosure(
		project,
		paths.map((path) => ({ path, bytes: 0 }))
	);
	const unmet = closure.unmet[0];
	if (unmet !== undefined) {
		throw new Error(
			`The remapped Project still needs “${unmet.reference}”, which the Layer “${unmet.layer}” is ` +
				`drawn from, so an identity was not rewritten.`
		);
	}
	const planned = new Set(paths);
	const missing = closure.paths.find((path) => !planned.has(path));
	if (missing !== undefined || closure.paths.length !== planned.size) {
		throw new Error(
			`The remapped closure and the remapped Project do not describe the same files: ` +
				`${missing ?? 'a planned path is not referenced'}.`
		);
	}
}

function observedImportProvenance(
	origin: ProjectImportOrigin,
	observedAt: Date
): ImportProvenanceEntry {
	const common = { observedAt: observedAt.toISOString(), evidence: 'observed' as const };
	switch (origin.kind) {
		case 'github':
			return {
				kind: 'github',
				owner: origin.owner,
				repository: origin.repository,
				branch: origin.branch,
				directory: origin.directory,
				commit: origin.commit,
				...common
			};
		case 'review':
			return { kind: 'review', projectName: origin.projectName, ...common };
	}
}

export const detachImportedProject = (
	project: ProjectFile,
	origin: ProjectImportOrigin,
	observedAt: Date
): ProjectFile => ({
	...project,
	canonicalUrl: null,
	onFrontPage: false,
	importProvenance: [
		...inheritImportProvenance(project.importProvenance ?? []),
		observedImportProvenance(origin, observedAt)
	]
});

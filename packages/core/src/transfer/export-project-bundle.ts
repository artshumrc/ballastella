import { parseLayers, type Layer } from '../project/layer.js';
import { projectFilePath } from '../project/project-file.js';
import { PathNotFoundError, parseJsonBytes, type ProjectStore } from '../store/project-store.js';
import { bundleFileName, packTar, type PackedArchive } from './archive.js';
import { projectClosureFiles } from './project-import-source.js';
import type { TransferProgressListener } from './transfer.js';
import { isViewerFile } from './viewer-files.js';

interface ProjectBundle extends PackedArchive {
	readonly fileName: string;
}

export async function exportProjectBundle(
	store: ProjectStore,
	directory: string,
	options: { readonly onProgress?: TransferProgressListener } = {}
): Promise<ProjectBundle> {
	const prefix = `${directory}/`;
	const files = (await projectClosureFiles(store, directory, await readLayers(store, directory)))
		.map((path) => ({ name: path.startsWith(prefix) ? path.slice(prefix.length) : path, path }))
		.filter((file) => file.path === file.name || !isViewerFile(file.name));

	if (!files.some((file) => file.path === projectFilePath(directory))) {
		throw new PathNotFoundError(projectFilePath(directory));
	}

	return {
		fileName: bundleFileName(directory),
		...(await packTar(store, files, options.onProgress))
	};
}

async function readLayers(store: ProjectStore, directory: string): Promise<readonly Layer[]> {
	try {
		const raw = parseJsonBytes(await store.read(projectFilePath(directory)));
		return parseLayers((raw as { layers?: unknown } | null)?.layers);
	} catch {
		return [];
	}
}

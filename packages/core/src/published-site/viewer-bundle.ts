import { isRecord } from '../store/project-store.js';

export type ViewerBundleFile = {
	readonly path: string;
	readonly source: string;
	readonly bytes: number;
};

export type ViewerBundle = {
	readonly version: string;
	readonly files: readonly ViewerBundleFile[];
	readonly baseMap: readonly ViewerBundleFile[];
};

export class ViewerBundleUnreadableError extends Error {
	override readonly name = 'ViewerBundleUnreadableError';
	constructor(reason: string) {
		super(
			`The read-only viewer a site is written from could not be read: ${reason}. This build of ` +
				`the editor is incomplete — the viewer is staged into it by ` +
				`scripts/stage-viewer-bundle.mjs during the build.`
		);
	}
}

export function parseViewerBundle(raw: unknown): ViewerBundle {
	if (!isRecord(raw)) throw new ViewerBundleUnreadableError('its index is not a JSON object');
	const version = raw.version;
	if (typeof version !== 'string' || version === '') {
		throw new ViewerBundleUnreadableError('its index carries no version stamp');
	}
	const files = readFiles(raw.files, 'files');
	if (files.length === 0) throw new ViewerBundleUnreadableError('its index lists no files');
	if (!files.some((file) => file.path === 'index.html')) {
		throw new ViewerBundleUnreadableError('its index lists no index.html');
	}
	return { version, files, baseMap: readFiles(raw.baseMap ?? [], 'baseMap') };
}

function readFiles(value: unknown, field: string): ViewerBundleFile[] {
	if (!Array.isArray(value)) {
		throw new ViewerBundleUnreadableError(`its index's ${field} is not an array`);
	}
	return value.map((entry) => {
		const file = entry as Record<string, unknown> | null;
		const path = file?.path;
		const source = file?.source;
		const bytes = file?.bytes;
		if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.endsWith('/')) {
			throw new ViewerBundleUnreadableError(
				`its index's ${field} holds ${JSON.stringify(path)}, which is not a file path`
			);
		}
		if (typeof source !== 'string' || source === '') {
			throw new ViewerBundleUnreadableError(`its index does not say where ${path} is served from`);
		}
		if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
			throw new ViewerBundleUnreadableError(`its index gives no byte length for ${path}`);
		}
		return { path, source, bytes };
	});
}

export const bundleBytes = (files: readonly ViewerBundleFile[]): number =>
	files.reduce((sum, file) => sum + file.bytes, 0);

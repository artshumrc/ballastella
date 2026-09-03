// What the read-only viewer's built files are, and where each one goes in a Workspace.
//
// The bundle is produced at **build** time by `scripts/stage-viewer-bundle.mjs`, which copies
// `apps/viewer/build` into the editor's own static assets and writes an index beside it. This
// module is the reader of that index, so the build script and the app cannot disagree about the
// file set or about the version stamp.
//
// It deliberately holds no bytes and no `fetch`. The site write takes the bytes through a `readAsset`
// function the app supplies, for the same reason ADR-0011's injection layer exists: the editor
// serves those files from its own deployment over a **relative** path (ADR-0045), and core has no
// business knowing what a deployment looks like.

/** One file of the bundle, and where the site write puts it. */
export type ViewerBundleFile = {
	/**
	 * Where it goes, relative to the Workspace — `index.html`, `_app/immutable/…`. The shared bundle
	 * sits at the Workspace rather than inside each Project (ADR-0008).
	 */
	readonly path: string;
	/**
	 * Where the **editor's own deployment** serves this file from, relative to the editor's base.
	 *
	 * Recorded rather than derived, because the two layouts genuinely differ: the viewer is staged
	 * under a directory of its own so its `index.html` cannot collide with the editor's, while the
	 * Base Map's files are the ones the editor already serves for its own panes and are not copied a
	 * second time. Core never interprets this — it is handed straight back to the app's `readAsset`,
	 * whose business a deployment's shape is (ADR-0045).
	 */
	readonly source: string;
	/**
	 * Its byte length, recorded at build time.
	 *
	 * So that the site write can say what it is about to add **before** it adds it — ADR-0020 requires
	 * that of the Base Map extract, and ADR-0008's ~1 GB cliff needs it of everything. Reading
	 * every file to weigh it would mean fetching several megabytes in order to ask a question whose
	 * answer might be "do not do this".
	 */
	readonly bytes: number;
};

/** The viewer as built, ready to be written into a Workspace. */
export type ViewerBundle = {
	/**
	 * The version stamp (ADR-0045): a content hash over the file set below.
	 *
	 * A hash rather than a build timestamp, so that writing the site again with an unchanged viewer produces the
	 * same stamp and "is this Published Site's viewer out of date?" has an answer that does not
	 * drift on its own.
	 */
	readonly version: string;
	/** The viewer itself. Always written. */
	readonly files: readonly ViewerBundleFile[];
	/**
	 * The Base Map's glyphs and sprites, written with every Published Site so labels and symbols are
	 * available independently of the tile source (ADR-0020).
	 */
	readonly baseMap: readonly ViewerBundleFile[];
};

/** The staged bundle index could not be read, so there is no site to write. */
export class ViewerBundleUnreadableError extends Error {
	constructor(reason: string) {
		super(
			`The read-only viewer a site is written from could not be read: ${reason}. This build of ` +
				`the editor is incomplete — the viewer is staged into it by ` +
				`scripts/stage-viewer-bundle.mjs during the build.`
		);
		this.name = 'ViewerBundleUnreadableError';
	}
}

/**
 * Read the build-time index.
 *
 * Validated rather than trusted, even though it comes from our own deployment: the failure it
 * guards against is a *stale or partial* staging step, and the symptom of that without this check
 * is a Published Site missing whichever chunks the index forgot — a blank page with a 404 in the
 * console, which is precisely the failure ADR-0045's relative-path rule exists to keep rare.
 */
export function parseViewerBundle(value: unknown): ViewerBundle {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ViewerBundleUnreadableError('its index is not a JSON object');
	}
	const raw = value as Record<string, unknown>;
	const version = raw.version;
	if (typeof version !== 'string' || version === '') {
		throw new ViewerBundleUnreadableError('its index carries no version stamp');
	}
	const files = readFiles(raw.files, 'files');
	if (files.length === 0) {
		throw new ViewerBundleUnreadableError('its index lists no files');
	}
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

/** How many bytes a set of bundle files occupies. */
export const bundleBytes = (files: readonly ViewerBundleFile[]): number =>
	files.reduce((sum, file) => sum + file.bytes, 0);

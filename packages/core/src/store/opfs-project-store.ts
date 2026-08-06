import { PathNotFoundError, pathSegments, type Bytes, type StorePath } from './project-store.js';
import { TempFileWriteStore } from './temp-file-write-store.js';

/** Resolves the directory the workspace lives in. Called again after a failure. */
export type DirectoryResolver = () => Promise<FileSystemDirectoryHandle>;

/**
 * `FileSystemHandle.move` is in the File System Access specification but not yet in
 * TypeScript's DOM library, and not in every browser either — hence the feature test at the
 * one call site rather than a global declaration that would pretend it is always there.
 */
type MovableFileHandle = FileSystemFileHandle & {
	move?: (destination: FileSystemDirectoryHandle, name: string) => Promise<void>;
};

/**
 * The default backend: the Origin Private File System, which every modern browser supports
 * (ADR-0001). Built and shipped before the File System Access adapter so the interface could
 * not be shaped around a folder the user can see — a folder is the headline feature, but it
 * is Chromium-desktop only, and an abstraction shaped around it would have left the
 * cross-browser path to rot.
 *
 * The workspace is the OPFS root and Projects are directories inside it (ADR-0008), the same
 * layout a real folder gets, so a Project copied between backends by hand still opens.
 */
export class OpfsProjectStore extends TempFileWriteStore {
	readonly #resolveRoot: DirectoryResolver;
	#root: FileSystemDirectoryHandle | undefined;

	constructor(resolveRoot: DirectoryResolver) {
		super();
		this.#resolveRoot = resolveRoot;
	}

	/** The workspace at the OPFS root. What the app uses. */
	static open(): OpfsProjectStore {
		return new OpfsProjectStore(() => navigator.storage.getDirectory());
	}

	/** Whether this browser has OPFS at all. False only in a non-secure context. */
	static isSupported(): boolean {
		return (
			typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
		);
	}

	/**
	 * The root is resolved lazily and cached only once it succeeds, so a workspace that has
	 * become unreachable fails at the operation the user asked for — where there is a screen
	 * to say so and a locate-again affordance to offer (ADR-0008) — and recovers by itself if
	 * it comes back, rather than being latched broken by one bad moment at startup.
	 */
	async #rootDirectory(): Promise<FileSystemDirectoryHandle> {
		this.#root ??= await this.#resolveRoot();
		return this.#root;
	}

	protected async readBytes(path: StorePath): Promise<Bytes> {
		const file = await this.#file(path);
		if (!file) throw new PathNotFoundError(path);
		return new Uint8Array(await (await file.getFile()).arrayBuffer());
	}

	protected async writeBytes(path: StorePath, bytes: Bytes): Promise<void> {
		const segments = pathSegments(path);
		const name = segments.pop() as string;
		const directory = await this.#directory(segments, { create: true });
		const handle = await directory.getFileHandle(name, { create: true });
		const writable = await handle.createWritable();
		try {
			await writable.write(bytes);
			// `close` is inside the guard because `close` is where OPFS reports a full disk: the
			// implementation exchanges the swap file for the real one there, and that is the step
			// that needs the quota. Outside it, a quota failure left the stream open and its swap
			// file allocated, on top of leaving the temporary file behind.
			await writable.close();
		} catch (cause) {
			await writable.abort().catch(() => undefined);
			throw cause;
		}
	}

	protected async renameTempFile(from: StorePath, to: StorePath): Promise<void> {
		const source = await this.#file(from);
		if (!source) throw new PathNotFoundError(from);

		const segments = pathSegments(to);
		const name = segments.pop() as string;
		const destination = await this.#directory(segments, { create: true });

		const movable: MovableFileHandle = source;
		if (typeof movable.move === 'function') {
			await movable.move(destination, name);
			return;
		}
		// No `move` in this browser. `createWritable` is still atomic by specification — it
		// writes to a swap file the implementation only exchanges for the real one on `close`
		// — so the destination is never observably torn. Copying rather than renaming costs an
		// extra pass over the bytes, which is why it is the fallback and not the default.
		const bytes = new Uint8Array(await (await source.getFile()).arrayBuffer());
		const handle = await destination.getFileHandle(name, { create: true });
		const writable = await handle.createWritable();
		await writable.write(bytes);
		await writable.close();
		await this.deletePath(from);
	}

	protected async listPaths(prefix: string): Promise<StorePath[]> {
		// Descend to the deepest directory the prefix names before walking, so listing one
		// Project does not enumerate a sibling's pyramid.
		const segments = pathSegments(prefix);
		if (!prefix.endsWith('/') && segments.length > 0) segments.pop();

		const start = await this.#directory(segments, { create: false });
		if (!start) return [];
		const base = segments.length === 0 ? '' : `${segments.join('/')}/`;
		const found: StorePath[] = [];
		await collectFiles(start, base, found);
		return found;
	}

	protected async deletePath(path: StorePath): Promise<void> {
		const segments = pathSegments(path);
		const name = segments.pop() as string;
		const directory = await this.#directory(segments, { create: false });
		if (!directory) return;
		try {
			await directory.removeEntry(name);
		} catch (cause) {
			if (!isNotFound(cause)) throw cause;
			return;
		}
		// Prune directories the delete emptied. In a real folder (ticket 12) an abandoned tree
		// of empty directories is something the user sees and has to tidy up by hand.
		await this.#pruneEmpty(segments);
	}

	protected async byteLength(path: StorePath): Promise<number> {
		const file = await this.#file(path);
		if (!file) throw new PathNotFoundError(path);
		return (await file.getFile()).size;
	}

	async #file(path: StorePath): Promise<FileSystemFileHandle | undefined> {
		const segments = pathSegments(path);
		const name = segments.pop() as string;
		const directory = await this.#directory(segments, { create: false });
		if (!directory) return undefined;
		try {
			return await directory.getFileHandle(name);
		} catch (cause) {
			if (isNotFound(cause)) return undefined;
			throw cause;
		}
	}

	async #directory(
		segments: readonly string[],
		options: { create: true }
	): Promise<FileSystemDirectoryHandle>;
	async #directory(
		segments: readonly string[],
		options: { create: false }
	): Promise<FileSystemDirectoryHandle | undefined>;
	async #directory(
		segments: readonly string[],
		options: { create: boolean }
	): Promise<FileSystemDirectoryHandle | undefined> {
		let directory = await this.#rootDirectory();
		for (const segment of segments) {
			try {
				directory = await directory.getDirectoryHandle(segment, { create: options.create });
			} catch (cause) {
				if (!options.create && isNotFound(cause)) return undefined;
				throw cause;
			}
		}
		return directory;
	}

	async #pruneEmpty(segments: readonly string[]): Promise<void> {
		for (let depth = segments.length; depth > 0; depth -= 1) {
			const directory = await this.#directory(segments.slice(0, depth), { create: false });
			if (!directory || !(await isEmpty(directory))) return;
			const parent = await this.#directory(segments.slice(0, depth - 1), { create: false });
			if (!parent) return;
			await parent.removeEntry(segments[depth - 1] as string).catch(() => undefined);
		}
	}
}

async function collectFiles(
	directory: FileSystemDirectoryHandle,
	prefix: string,
	into: StorePath[]
): Promise<void> {
	for await (const [name, handle] of directory.entries()) {
		if (handle.kind === 'file') into.push(`${prefix}${name}`);
		else await collectFiles(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, into);
	}
}

async function isEmpty(directory: FileSystemDirectoryHandle): Promise<boolean> {
	return (await directory.keys().next()).done === true;
}

const isNotFound = (cause: unknown): boolean =>
	cause instanceof DOMException && cause.name === 'NotFoundError';

import { PathNotFoundError, pathSegments, type Bytes, type StorePath } from './project-store.js';
import { TempFileWriteStore } from './temp-file-write-store.js';

// `FileSystemHandle.move` is not in TypeScript's DOM library, nor in every browser.
type MovableFileHandle = FileSystemFileHandle & {
	move?: (destination: FileSystemDirectoryHandle, name: string) => Promise<void>;
};

class DirectoryHandleStore extends TempFileWriteStore {
	readonly #resolveRoot: () => Promise<FileSystemDirectoryHandle>;
	#root: FileSystemDirectoryHandle | undefined;

	constructor(resolveRoot: () => Promise<FileSystemDirectoryHandle>) {
		super();
		this.#resolveRoot = resolveRoot;
	}

	protected async readBytes(path: StorePath): Promise<Bytes> {
		return new Uint8Array(await (await this.#existingFile(path)).arrayBuffer());
	}

	protected async writeBytes(path: StorePath, bytes: Bytes): Promise<void> {
		const segments = pathSegments(path);
		const name = segments.pop() as string;
		const directory = await this.#directory(segments, { create: true });
		const handle = await directory.getFileHandle(name, { create: true });
		const writable = await handle.createWritable();
		try {
			await writable.write(bytes);
			await writable.close();
		} catch (cause) {
			await writable.abort().catch(() => undefined);
			throw describeWriteFailure(cause, path);
		}
	}

	protected async renameTempFile(from: StorePath, to: StorePath): Promise<void> {
		const source: MovableFileHandle | undefined = await this.#file(from);
		if (!source) throw new PathNotFoundError(from);

		if (typeof source.move === 'function') {
			const segments = pathSegments(to);
			const name = segments.pop() as string;
			await source.move(await this.#directory(segments, { create: true }), name);
			return;
		}
		await this.writeBytes(to, new Uint8Array(await (await source.getFile()).arrayBuffer()));
		await this.deletePath(from);
	}

	protected async listPaths(prefix: string): Promise<StorePath[]> {
		const segments = pathSegments(prefix);
		if (!prefix.endsWith('/') && segments.length > 0) segments.pop();
		const start = await this.#directory(segments, { create: false });
		if (!start) return [];
		const base = segments.length === 0 ? '' : `${segments.join('/')}/`;
		const found: StorePath[] = [];
		await collectFiles(start, base, found, segments.length > 0);
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
		await this.#pruneEmpty(segments);
	}

	protected async byteLength(path: StorePath): Promise<number> {
		return (await this.#existingFile(path)).size;
	}

	protected async modifiedAtOf(path: StorePath): Promise<number | null> {
		return (await this.#existingFile(path)).lastModified;
	}

	async #existingFile(path: StorePath): Promise<File> {
		const file = await this.#file(path);
		if (!file) throw new PathNotFoundError(path);
		return file.getFile();
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
		this.#root ??= await this.#resolveRoot();
		let directory = this.#root;
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
			if (!directory || !(await directory.keys().next()).done) return;
			const parent = await this.#directory(segments.slice(0, depth - 1), { create: false });
			if (!parent) return;
			await parent.removeEntry(segments[depth - 1] as string).catch(() => undefined);
		}
	}
}

export class OpfsProjectStore extends DirectoryHandleStore {
	static open(name: string): OpfsProjectStore {
		return new OpfsProjectStore(async () =>
			(await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true })
		);
	}

	static isSupported(): boolean {
		return (
			typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
		);
	}
}

export class FileSystemAccessProjectStore extends DirectoryHandleStore {
	constructor(readonly folder: FileSystemDirectoryHandle) {
		super(() => Promise.resolve(folder));
	}

	get folderName(): string {
		return this.folder.name;
	}
}

async function collectFiles(
	directory: FileSystemDirectoryHandle,
	prefix: string,
	into: StorePath[],
	forgiveAVanishedDirectory: boolean
): Promise<void> {
	for (const [name, handle] of await collectEntries(directory, forgiveAVanishedDirectory)) {
		if (handle.kind === 'file') into.push(`${prefix}${name}`);
		else await collectFiles(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, into, true);
	}
}

const DRAIN_ATTEMPTS = 5;

// A concurrent delete can make `entries()` throw mid-walk; the retry converges because the entry is gone by the next pass.
async function collectEntries(
	directory: FileSystemDirectoryHandle,
	forgiveAVanishedDirectory: boolean
): Promise<[string, FileSystemHandle][]> {
	let last: unknown;
	for (let attempt = 0; attempt < DRAIN_ATTEMPTS; attempt += 1) {
		const entries: [string, FileSystemHandle][] = [];
		try {
			for await (const entry of directory.entries()) entries.push(entry);
			return entries;
		} catch (cause) {
			if (!isNotFound(cause) || !forgiveAVanishedDirectory) throw cause;
			if (entries.length === 0) return [];
			last = cause;
		}
	}
	throw last;
}

const isNotFound = (cause: unknown): boolean =>
	cause instanceof DOMException && cause.name === 'NotFoundError';

function describeWriteFailure(cause: unknown, path: StorePath): unknown {
	if (!(cause instanceof DOMException) || cause.name !== 'NoModificationAllowedError') return cause;
	const error = new Error(
		`Something else on this computer is holding “${path}” open, so it could not be saved — ` +
			`usually a sync service such as Dropbox or iCloud, an editor with the file open, or ` +
			`antivirus scanning it. Your work has not been lost. This normally clears within a few ` +
			`seconds; make another change to try again.`,
		{ cause }
	);
	error.name = 'FileLockedError';
	return error;
}

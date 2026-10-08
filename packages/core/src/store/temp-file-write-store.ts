import {
	assertStorePath,
	isTempPath,
	TEMP_PATH_SUFFIX,
	type Bytes,
	type ProjectStore,
	type StorePath,
	type WritablePath
} from './project-store.js';

export abstract class TempFileWriteStore implements ProjectStore {
	async read(path: string): Promise<Bytes> {
		return this.readBytes(assertStorePath(path));
	}

	async write(path: WritablePath, bytes: Bytes): Promise<void> {
		const destination = assertStorePath(path);
		const cut = destination.lastIndexOf('/') + 1;
		const temp = `${destination.slice(0, cut)}.${destination.slice(cut)}.${crypto.randomUUID()}${TEMP_PATH_SUFFIX}`;
		try {
			await this.writeBytes(temp, bytes);
			await this.renameTempFile(temp, destination);
		} catch (cause) {
			await this.deletePath(temp).catch(() => undefined);
			throw cause;
		}
	}

	async list(prefix: string): Promise<StorePath[]> {
		const paths = await this.listPaths(prefix);
		return paths.filter((path) => !isTempPath(path) && path.startsWith(prefix)).sort();
	}

	async delete(path: string): Promise<void> {
		await this.deletePath(assertStorePath(path));
	}

	async size(path: string): Promise<number> {
		return this.byteLength(assertStorePath(path));
	}

	async modifiedAt(path: string): Promise<number | null> {
		return this.modifiedAtOf(assertStorePath(path));
	}

	// Only safe when no write is in flight under `prefix`: it deletes their temp files too.
	async reclaimAbandonedWrites(prefix: string): Promise<void> {
		for (const path of await this.listPaths(prefix)) {
			if (isTempPath(path) && path.startsWith(prefix)) await this.deletePath(path);
		}
	}

	protected abstract readBytes(path: StorePath): Promise<Bytes>;
	protected abstract writeBytes(path: StorePath, bytes: Bytes): Promise<void>;
	protected abstract renameTempFile(from: StorePath, to: StorePath): Promise<void>;
	protected abstract listPaths(prefix: string): Promise<StorePath[]>;
	protected abstract deletePath(path: StorePath): Promise<void>;
	protected abstract byteLength(path: StorePath): Promise<number>;

	protected async modifiedAtOf(path: StorePath): Promise<number | null> {
		void path;
		return null;
	}
}

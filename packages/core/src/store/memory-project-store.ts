import { PathNotFoundError, type Bytes, type StorePath } from './project-store.js';
import { TempFileWriteStore } from './temp-file-write-store.js';

export class MemoryProjectStore extends TempFileWriteStore {
	readonly #files = new Map<StorePath, Bytes>();
	readonly #writtenAt = new Map<StorePath, number>();
	#clock = 0;
	#unreachable: Error | undefined;
	#writes = 0;
	#failAt: { readonly at: number; readonly step: 'bytes' | 'rename' } | undefined;
	#failNextDelete = false;

	static unreachable(cause: Error = new Error('Workspace not reachable')): MemoryProjectStore {
		const store = new MemoryProjectStore();
		store.#unreachable = cause;
		return store;
	}

	snapshot(): ReadonlyMap<StorePath, Bytes> {
		return new Map([...this.#files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	}

	failNextWrite(step: 'bytes' | 'rename'): void {
		this.failWriteAt(1, step);
	}

	failWriteAt(nth: number, step: 'bytes' | 'rename'): void {
		this.#failAt = { at: this.#writes + nth, step };
	}

	failNextDelete(): void {
		this.#failNextDelete = true;
	}

	becomeUnreachable(cause: Error = new Error('Workspace not reachable')): void {
		this.#unreachable = cause;
	}

	plant(path: StorePath, bytes: Bytes): void {
		this.#files.set(path, bytes.slice());
		this.#writtenAt.set(path, this.#tick());
	}

	protected async readBytes(path: StorePath): Promise<Bytes> {
		return this.#held(path).slice();
	}

	protected async writeBytes(path: StorePath, bytes: Bytes): Promise<void> {
		this.#assertReachable();
		this.#writes += 1;
		this.#failIfArmed('bytes');
		this.#files.set(path, bytes.slice());
		this.#writtenAt.set(path, this.#tick());
	}

	protected async renameTempFile(from: StorePath, to: StorePath): Promise<void> {
		this.#assertReachable();
		this.#failIfArmed('rename');
		this.#files.set(to, this.#held(from));
		this.#files.delete(from);
		this.#writtenAt.set(to, this.#writtenAt.get(from) ?? this.#tick());
		this.#writtenAt.delete(from);
	}

	protected async listPaths(prefix: string): Promise<StorePath[]> {
		this.#assertReachable();
		return [...this.#files.keys()].filter((path) => path.startsWith(prefix));
	}

	protected async deletePath(path: StorePath): Promise<void> {
		this.#assertReachable();
		if (this.#failNextDelete) {
			this.#failNextDelete = false;
			throw new Error(`storage went away while ${path} was being deleted`);
		}
		this.#files.delete(path);
		this.#writtenAt.delete(path);
	}

	protected async byteLength(path: StorePath): Promise<number> {
		return this.#held(path).byteLength;
	}

	protected async modifiedAtOf(path: StorePath): Promise<number | null> {
		this.#assertReachable();
		const at = this.#writtenAt.get(path);
		if (at === undefined) throw new PathNotFoundError(path);
		return at;
	}

	#held(path: StorePath): Bytes {
		this.#assertReachable();
		const bytes = this.#files.get(path);
		if (!bytes) throw new PathNotFoundError(path);
		return bytes;
	}

	#tick(): number {
		this.#clock = Math.max(Date.now(), this.#clock + 1);
		return this.#clock;
	}

	#assertReachable(): void {
		if (this.#unreachable) throw this.#unreachable;
	}

	#failIfArmed(step: 'bytes' | 'rename'): void {
		const armed = this.#failAt;
		if (armed === undefined || armed.step !== step || armed.at !== this.#writes) return;
		this.#failAt = undefined;
		throw new Error(`storage went away while write ${armed.at} was at the ${step} step`);
	}
}

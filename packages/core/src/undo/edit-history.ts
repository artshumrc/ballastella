import { sameBytes, type Bytes, type StorePath } from '../store/project-store.js';
import { carryAcross } from './carry-text.js';

interface StepFile {
	readonly path: StorePath;
	readonly before: Bytes | null;
	readonly after: Bytes | null;
}

export interface Step {
	readonly label: string;
	readonly files: readonly StepFile[];
}

export interface HistoryFiles {
	flush(): Promise<void>;
	read(path: StorePath): Promise<Bytes | null>;
	writeBack(path: StorePath, bytes: Bytes | null): Promise<void>;
}

interface HistoryState {
	readonly undoable: Step | null;
	readonly redoable: Step | null;
}

const DEFAULT_DEPTH = 5;

export class EditHistory {
	readonly #files: HistoryFiles;
	readonly #depth: number;
	readonly #byteCeiling: number;
	readonly #listeners = new Set<(state: HistoryState) => void>();
	#steps: Step[] = [];
	#cursor = 0;
	#writing = false;

	constructor(
		files: HistoryFiles,
		options: { readonly depth?: number; readonly byteCeiling?: number } = {}
	) {
		this.#files = files;
		this.#depth = Math.max(1, options.depth ?? DEFAULT_DEPTH);
		this.#byteCeiling = options.byteCeiling ?? Number.POSITIVE_INFINITY;
	}

	get undoable(): Step | null {
		return this.#cursor > 0 ? (this.#steps[this.#cursor - 1] ?? null) : null;
	}

	get redoable(): Step | null {
		return this.#steps[this.#cursor] ?? null;
	}

	subscribe(listener: (state: HistoryState) => void): () => void {
		this.#listeners.add(listener);
		listener(this.#state());
		return () => this.#listeners.delete(listener);
	}

	async step<T>(label: string, paths: readonly StorePath[], gesture: () => Promise<T>): Promise<T> {
		await this.#files.flush();
		const before = await this.#readAll(paths);
		const answer = await gesture();
		await this.#files.flush();
		const after = await this.#readAll(paths);

		const files = paths.map((path, at) => ({
			path,
			before: before[at] ?? null,
			after: after[at] ?? null
		}));
		const unchanged = ({ before, after }: StepFile) =>
			before === null || after === null ? before === after : sameBytes(before, after);
		if (files.every(unchanged)) return answer;

		this.#push({ label, files });
		return answer;
	}

	undo(): Promise<boolean> {
		return this.#walk(-1);
	}

	redo(): Promise<boolean> {
		return this.#walk(1);
	}

	discard(): void {
		this.#steps = [];
		this.#cursor = 0;
		this.#announce();
	}

	async #walk(direction: -1 | 1): Promise<boolean> {
		if (this.#writing) return false;
		const step = direction === -1 ? this.undoable : this.redoable;
		if (step === null) return false;

		this.#writing = true;
		try {
			const landed = await this.#writeBack(step, direction === -1 ? 'before' : 'after');
			// The cursor moves only on success, so a failed undo can be retried.
			if (!landed) return false;
			this.#cursor += direction;
			this.#announce();
			return true;
		} finally {
			this.#writing = false;
		}
	}

	// Every file is attempted even after one fails, so a retry converges.
	async #writeBack(step: Step, side: 'before' | 'after'): Promise<boolean> {
		let landed = true;
		for (const file of step.files) {
			const image = side === 'before' ? file.before : file.after;
			try {
				const carried =
					image === null ? null : carryAcross(file.path, image, await this.#files.read(file.path));
				await this.#files.writeBack(file.path, carried);
			} catch {
				landed = false;
			}
		}
		return landed;
	}

	#readAll(paths: readonly StorePath[]): Promise<(Bytes | null)[]> {
		return Promise.all(paths.map((path) => this.#files.read(path)));
	}

	#push(step: Step): void {
		this.#steps.length = this.#cursor;
		this.#steps.push(step);
		this.#cursor = this.#steps.length;

		while (this.#steps.length > this.#depth) this.#evictOldest();
		while (this.#steps.length > 1 && this.#weight() > this.#byteCeiling) this.#evictOldest();

		this.#announce();
	}

	#evictOldest(): void {
		this.#steps.shift();
		this.#cursor = Math.max(0, this.#cursor - 1);
	}

	#weight(): number {
		let total = 0;
		for (const step of this.#steps) {
			for (const file of step.files) {
				total += (file.before?.byteLength ?? 0) + (file.after?.byteLength ?? 0);
			}
		}
		return total;
	}

	#state(): HistoryState {
		return { undoable: this.undoable, redoable: this.redoable };
	}

	#announce(): void {
		for (const listener of this.#listeners) listener(this.#state());
	}
}

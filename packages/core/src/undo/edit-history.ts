// The Edit History of one screen: the last few edits made on it, each reversible and repeatable
// (ADR-0039).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A STEP IS BYTES, AND THAT IS THE DECISION EVERYTHING ELSE FOLLOWS FROM
//
// A Step holds the *file images* a gesture wrote — what was there before it, and what is there after
// — rather than a command and its inverse. Making every mutation a command object shapes the whole
// state layer, and an inverse-operation registry has to be right for every gesture in the
// application; two byte images are right for all of them at once, including a gesture added later
// that nobody thought about here.
//
// Three constraints hold whatever a Step is made of, and each is load-bearing here:
//
//  1. **The images are held in memory, independent of write state.** With ADR-0017's sub-second
//     per-file debounce, "revert to the last saved state" is useless — by the time the scholar
//     reaches for undo, the destructive change *is* the last saved state.
//  2. **Reverting is an ordinary mutation.** Every write goes back out through the injected
//     {@link HistoryFiles}, which the session routes through the same `Autosave` as every other
//     edit. There is no bespoke save path, and this class never touches a store.
//  3. **Nothing persists across a reload.** Putting an unsaved change back at startup is the
//     write-ahead journal's business; an Edit History is memory only.
//
// This class knows nothing about Projects, Map Images, or which history is current. It holds files.

import type { Bytes, StorePath } from '../store/project-store.js';
import { carryAcross } from './carry-text.js';

/** One file a gesture wrote, as it was either side of that gesture. `null` = no such file. */
export interface StepFile {
	readonly path: StorePath;
	readonly before: Bytes | null;
	readonly after: Bytes | null;
}

/** One completed gesture. */
export interface Step {
	/** What the bar says. Verb, subject, the scholar's own words; never a value. */
	readonly label: string;
	readonly files: readonly StepFile[];
}

/**
 * How a history reads and writes the files it holds. Injected; the history never touches a store.
 *
 * `writeBack` exists as a port rather than a store call because exactly one module may write an
 * `alignments/<image-id>.json` and every caller of it must name its intent (ticket 18). The session's
 * implementation routes an Alignment through that module and everything else through `Autosave`.
 */
export interface HistoryFiles {
	/** Everything pending, landed, before an image is taken. */
	flush(): Promise<void>;
	read(path: StorePath): Promise<Bytes | null>;
	/** Put `bytes` at `path`, or delete it when `bytes` is `null`. */
	writeBack(path: StorePath, bytes: Bytes | null): Promise<void>;
}

export interface EditHistoryOptions {
	/** The whole span, cursor included. A sixth Step evicts the oldest (SPEC stories 10, 11). */
	readonly depth?: number;
	/** A backstop, not the rule. The most recent Step is never evicted for it (SPEC story 12). */
	readonly byteCeiling?: number;
}

/** What a subscriber is told: the two ends of the history, either of which may be empty. */
export interface HistoryState {
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
	/** How many Steps are behind the cursor: `#steps[#cursor - 1]` is what undo would reverse. */
	#cursor = 0;
	/** An undo or a redo is writing. A second press does nothing rather than running it twice. */
	#writing = false;

	constructor(files: HistoryFiles, options: EditHistoryOptions = {}) {
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

	/** Called on every change, and once immediately. Returns its own unsubscribe. */
	subscribe(listener: (state: HistoryState) => void): () => void {
		this.#listeners.add(listener);
		listener(this.#state());
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Wrap one user gesture: flush, read `paths`, run it, flush again, read them again, push a Step.
	 *
	 * **Both flushes are load-bearing.** A gesture's own write sits inside the per-file debounce, so
	 * an unflushed edit would put the wrong bytes in either image and undo would write back something
	 * the scholar never saw.
	 *
	 * `paths` is what the gesture *will* write, declared by the caller rather than inferred from the
	 * store — which is what keeps publish output, Update from GitHub and journal replay out of a
	 * history that never asked for them.
	 */
	async step<T>(label: string, paths: readonly StorePath[], gesture: () => Promise<T>): Promise<T> {
		await this.#files.flush();
		const before = await this.#readAll(paths);
		// A gesture that throws pushes nothing, and its error is the caller's unchanged: half an edit
		// is not a thing to offer undoing, and swallowing the failure here would hide it from the one
		// place that can report it.
		const answer = await gesture();
		await this.#files.flush();
		const after = await this.#readAll(paths);

		const files = paths.map((path, at) => ({
			path,
			before: before[at] ?? null,
			after: after[at] ?? null
		}));
		// A no-op is not a thing to undo, and offering one would spend a Step of a five-deep history.
		if (files.every((file) => sameBytes(file.before, file.after))) return answer;

		this.#push({ label, files });
		return answer;
	}

	/** Reverse the Step behind the cursor. Answers whether every write landed. */
	undo(): Promise<boolean> {
		return this.#walk(-1);
	}

	/** Repeat the Step ahead of the cursor. Answers whether every write landed. */
	redo(): Promise<boolean> {
		return this.#walk(1);
	}

	/**
	 * Empty the whole history, both directions.
	 *
	 * Something other than this history's own Steps has written its files, or its subject is gone. A
	 * disturbed history leaves whole rather than being trimmed: trimming would need to know which of
	 * its images are still true, and the honest answer is that it cannot.
	 */
	discard(): void {
		this.#steps = [];
		this.#cursor = 0;
		this.#publish();
	}

	async #walk(direction: -1 | 1): Promise<boolean> {
		if (this.#writing) return false;
		const step = direction === -1 ? this.undoable : this.redoable;
		if (step === null) return false;

		this.#writing = true;
		try {
			const landed = await this.#writeBack(step, direction === -1 ? 'before' : 'after');
			// **The cursor moves only on success.** A failure leaves it and the Step exactly where
			// they are, so the affordance stays on the bar rather than vanishing over a failure the
			// scholar can retry (SPEC story 50).
			if (!landed) return false;
			this.#cursor += direction;
			this.#publish();
			return true;
		} finally {
			this.#writing = false;
		}
	}

	/**
	 * Write one side of a Step's images back, answering whether every one of them landed.
	 *
	 * Every file is attempted even after one fails, so a partial failure leaves as little of the
	 * gesture standing as it can and a retry converges rather than compounding.
	 */
	async #writeBack(step: Step, side: 'before' | 'after'): Promise<boolean> {
		let landed = true;
		for (const file of step.files) {
			const image = side === 'before' ? file.before : file.after;
			try {
				// Read at this moment rather than remembered, because what the scholar typed since the
				// Step was taken is on disk and nowhere else.
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
		// A new Step contradicts whatever redo was offering, so there is one sequence and never a tree.
		this.#steps.length = this.#cursor;
		this.#steps.push(step);
		this.#cursor = this.#steps.length;

		while (this.#steps.length > this.#depth) this.#evictOldest();
		// The most recent Step is never evicted for size: undo covers the last thing done whatever it
		// touched.
		while (this.#steps.length > 1 && this.#weight() > this.#byteCeiling) this.#evictOldest();

		this.#publish();
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

	#publish(): void {
		// Read afresh for each listener rather than snapshotted before the loop: a listener that
		// discards, undoes, or resubscribes changes what the next one must be told.
		for (const listener of this.#listeners) listener(this.#state());
	}
}

function sameBytes(left: Bytes | null, right: Bytes | null): boolean {
	if (left === null || right === null) return left === right;
	if (left.byteLength !== right.byteLength) return false;
	for (let at = 0; at < left.byteLength; at += 1) if (left[at] !== right[at]) return false;
	return true;
}

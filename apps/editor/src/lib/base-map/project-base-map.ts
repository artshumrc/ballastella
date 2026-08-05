import { readBaseMapId, withBaseMapId } from '@ballastella/core';

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * SEAM WITH TICKET 02 — read this before extending anything in here.
 *
 * Ticket 02 owns `project.json`, the `ProjectStore` abstraction with its OPFS and in-memory
 * adapters, and all five autosave rules including the atomic temp-file-then-rename write. None
 * of that exists yet, and none of it is this ticket's to build.
 *
 * What this slice needs is one field: the author's default Base Map, recorded as a stable id
 * (ADR-0020). So the port below is exactly that field and nothing more — no listing, no
 * deleting, no debouncing, no save indicator. `OpfsProjectDefaultBaseMap` is the throwaway
 * half: when ticket 02 lands, delete the class, implement `ProjectDefaultBaseMap` against the
 * real `ProjectStore`, and leave the single caller in `+page.svelte` alone.
 *
 * The write is deliberately read-modify-write over the whole document rather than a targeted
 * patch, so that a Project already carrying `formatVersion`, `name`, and `layers` keeps them.
 * It is NOT atomic. That is ticket 02's rule to implement, and pretending to implement it here
 * would be worse than leaving it visibly absent.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ProjectDefaultBaseMap {
	/** The recorded id, or `null` when the author has not chosen. Never throws. */
	read(): Promise<string | null>;
	write(id: string): Promise<void>;
}

const PROJECT_FILE = 'project.json';

/** The document shape ticket 02 writes for a new Project. */
const newProjectDocument = (name: string) => ({
	formatVersion: 1,
	name,
	layers: [],
	baseMap: null
});

export class OpfsProjectDefaultBaseMap implements ProjectDefaultBaseMap {
	readonly #directory: string;

	/** @param directory the Project's directory name, which is its identity (ADR-0008). */
	constructor(directory: string) {
		this.#directory = directory;
	}

	async read(): Promise<string | null> {
		return readBaseMapId(await this.#readDocument());
	}

	async write(id: string): Promise<void> {
		const existing = await this.#readDocument();
		const document =
			typeof existing === 'object' && existing !== null
				? (existing as Record<string, unknown>)
				: newProjectDocument(this.#directory);

		const handle = await this.#file(true);
		const writable = await handle.createWritable();
		await writable.write(`${JSON.stringify(withBaseMapId(document, id), null, '\t')}\n`);
		await writable.close();
	}

	async #readDocument(): Promise<unknown> {
		try {
			const handle = await this.#file(false);
			const text = await (await handle.getFile()).text();
			return JSON.parse(text);
		} catch {
			// A Project that is not there yet, or a document that will not parse, both mean the same
			// thing to this slice: no Base Map has been chosen. `resolveBaseMap` takes it from here.
			return null;
		}
	}

	async #file(create: boolean): Promise<FileSystemFileHandle> {
		const root = await navigator.storage.getDirectory();
		const directory = await root.getDirectoryHandle(this.#directory, { create });
		return directory.getFileHandle(PROJECT_FILE, { create });
	}
}

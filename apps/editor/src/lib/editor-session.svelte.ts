import {
	Autosave,
	OpfsProjectStore,
	PathNotFoundError,
	ProjectDirectoryCollisionError,
	ProjectFileUnreadableError,
	ProjectFormatTooNewError,
	Workspace,
	alignmentStorePath,
	createStoreImageFetch,
	exportProjectZip,
	ingestImageFile,
	installFlushOnHide,
	listIngestedImages,
	newAlignment,
	openDecodeAndCropSource,
	parseAlignment,
	projectFilePath,
	readProjectZip,
	serialiseAlignment,
	streamingTiler,
	toDirectoryName,
	type Alignment,
	type FetchFn,
	type IngestProgress,
	type IngestedImage,
	type ProjectFile,
	type ProjectStore,
	type ProjectSummary,
	type ProjectZip,
	type SaveState,
	type TransferProgress
} from '@ballastella/core';

import { recordAlignmentWrite } from './alignment/browser-test-handle.js';
import { loadLibvips } from './ingest/libvips-loader.js';
import { saveFile } from './save-file.js';

/**
 * Whether the workspace can be reached. Not reachable is a **normal state** with a
 * locate-again affordance, not an unhandled rejection at startup (ADR-0008): a folder gets
 * moved, renamed, deleted, or has its permission declined, and a scholar who meets a stack
 * trace at that moment reasonably concludes the tool has eaten their work.
 */
export type WorkspaceStatus = 'loading' | 'ready' | 'unreachable';

/**
 * A transfer in flight, for the status region that announces it.
 *
 * A zip of a mirrored pyramid takes real seconds to tens of seconds, and it is announced rather
 * than merely drawn: SPEC story 96 asks for status to reach assistive technology, and this is one
 * of the two places in the app where the user is waiting on something they cannot see.
 */
export interface TransferState {
	readonly kind: 'export' | 'import';
	/** The Project being moved, by display name where there is one. */
	readonly subject: string;
	readonly files: number;
	readonly totalFiles: number;
	readonly finished: boolean;
}

/**
 * A validated zip waiting to be written, and where it would go.
 *
 * Held between the two halves of an import so the collision question can be asked without
 * re-reading and re-validating the archive: the user answers it by choosing a name, and the answer
 * must not be able to change what is about to be written.
 */
export interface PendingImport {
	readonly zip: ProjectZip;
	/** The display name inside the zip, for naming what is being imported. */
	readonly name: string;
	/** Where it will go. The Project's identity, so this is the thing that can collide (ADR-0008). */
	readonly directory: string;
	/** The message from a refused attempt, or `''` on the first pass. */
	readonly collision: string;
}

/** Why the Project named in `?p=` cannot be shown. */
export type ProjectProblem =
	| { readonly kind: 'format-too-new' | 'unreadable'; readonly message: string }
	| { readonly kind: 'missing'; readonly message: string };

/**
 * Everything the editor knows about the user's workspace, and the only place the app talks to
 * `@ballastella/core`.
 *
 * The store is injected rather than reached for, so the browser tests can hand in a backend
 * that fails and the app has no idea it is being lied to.
 *
 * **It is also the app's only writer of `project.json`, and holds the only in-memory copy of
 * it.** Every pane that records something — the Project name here, the Base Map default in
 * ticket 04, the Layer stack in ticket 09 — mutates {@link openProject} and writes through
 * {@link Workspace}. A pane that kept its own snapshot and serialised the whole document back
 * would clobber whatever another pane had just written, and ticket 07 puts both panes on one
 * page, which makes that a race inside a single component rather than between tabs.
 */
export class EditorSession {
	readonly #workspace: Workspace;
	readonly #autosave: Autosave;
	/** Held for the tiler, which writes tens of thousands of files that are not `project.json`. */
	readonly #store: ProjectStore;
	/** Bumped by every {@link open}, so a read that resolves late knows it has been superseded. */
	#openGeneration = 0;

	status = $state<WorkspaceStatus>('loading');
	/** The underlying failure, shown beneath "Workspace not reachable" so it is diagnosable. */
	unreachableDetail = $state('');
	projects = $state<ProjectSummary[]>([]);
	saveState = $state<SaveState>('saved');
	/**
	 * Why the last edit did not reach storage, if it did not. Shown beside the save indicator.
	 *
	 * A write that fails is not an unreachable Workspace — the Workspace is right there and its
	 * Projects still list — so it must not replace the page with "not reachable". ADR-0017 rule 5
	 * makes the indicator the signal for this, and a quota failure that says nothing at all is
	 * the worst version: the map switches, the app looks fine, and the choice is gone on reopen.
	 */
	saveError = $state('');

	/** The export or import in flight, or `null`. Rendered as announced status (ticket 13). */
	transfer = $state<TransferState | null>(null);
	/**
	 * A zip that has been read and validated but not yet written, because where to put it is still
	 * an open question. `null` whenever there is nothing to answer.
	 */
	pendingImport = $state<PendingImport | null>(null);
	/**
	 * Why the last export or import did not happen. Shown in the import dialog, and it is the whole
	 * point of the refusals: ADR-0010's "this Project is from a newer version" has to reach a
	 * screen, or a user hands a colleague a zip that silently does nothing.
	 */
	transferError = $state('');

	/** The Project directory currently open, from `?p=`. */
	openDirectory = $state<string | null>(null);
	openProject = $state<ProjectFile | null>(null);
	projectProblem = $state<ProjectProblem | null>(null);

	/**
	 * The Historical Maps in the open Project, and the ingest running now if one is.
	 *
	 * `ingest` is `null` between jobs rather than a finished-looking value, so the progress region
	 * disappears when there is nothing to report instead of sitting at 100% forever.
	 */
	images = $state<IngestedImage[]>([]);
	ingest = $state<IngestProgress | null>(null);
	/** The name of the file being ingested, for the progress message (SPEC story 23). */
	ingestLabel = $state('');
	ingestError = $state('');

	/**
	 * Why the Historical Map's stored Alignment could not be read, if it could not.
	 *
	 * A file that is there and unreadable must say so. Falling back to an empty Alignment silently
	 * would show the user no Control Points and then overwrite the ones they had on the next save —
	 * which is the largest single loss this slice could inflict.
	 */
	alignmentError = $state('');

	constructor(store: ProjectStore) {
		this.#store = store;
		this.#autosave = new Autosave(store);
		this.#workspace = new Workspace(store, { autosave: this.#autosave });
		this.#autosave.subscribe((state) => {
			this.saveState = state;
		});
	}

	/** The default: a workspace in OPFS, which every modern browser has (ADR-0001). */
	static opfs(): EditorSession {
		return new EditorSession(OpfsProjectStore.open());
	}

	/**
	 * Why this browser cannot hold a Workspace at all, or `''` when it can.
	 *
	 * OPFS is missing only in a non-secure context, and the raw DOM failure for that is
	 * "navigator.storage.getDirectory is not a function" — which diagnoses nothing and reads as
	 * the tool being broken rather than as the page being served over plain HTTP.
	 */
	static unsupportedReason(): string {
		if (OpfsProjectStore.isSupported()) return '';
		return (
			'This browser is not offering storage for a Workspace. That happens when the page is ' +
			'not served over a secure connection — open it over https://, or from localhost.'
		);
	}

	/** ADR-0017 rule 3. Returns its own teardown. */
	installFlushOnHide(): () => void {
		return installFlushOnHide(this.#autosave, { document, window });
	}

	/** Reload the Project list. Also the "locate again" action while there is no picker yet. */
	async refresh(): Promise<void> {
		try {
			this.projects = await this.#workspace.listProjects();
			this.status = 'ready';
			this.unreachableDetail = '';
		} catch (cause) {
			this.status = 'unreachable';
			this.unreachableDetail = cause instanceof Error ? cause.message : String(cause);
		}
	}

	async createProject(displayName: string): Promise<ProjectSummary | null> {
		return this.#mutate(null, () => this.#workspace.createProject(displayName));
	}

	async renameProject(directory: string, displayName: string): Promise<void> {
		await this.#mutate(directory, () => this.#workspace.renameProject(directory, displayName));
		if (this.openDirectory === directory && this.openProject) {
			this.openProject = { ...this.openProject, name: displayName };
		}
	}

	async duplicateProject(directory: string): Promise<void> {
		await this.#mutate(directory, () => this.#workspace.duplicateProject(directory));
	}

	async deleteProject(directory: string): Promise<void> {
		await this.#mutate(directory, () => this.#workspace.deleteProject(directory));
	}

	/**
	 * Hand one Project to the user as a zip (SPEC story 5).
	 *
	 * Everything pending is flushed first. Exporting a Project whose last edit is still inside the
	 * autosave debounce would otherwise produce an archive missing the change the user just made —
	 * the one failure that would make this whole path untrustworthy, since a zip is what they are
	 * about to send somebody (ADR-0017 rule 1).
	 */
	async exportProject(project: ProjectSummary): Promise<void> {
		this.transferError = '';
		await this.flush();
		const announce = (progress: TransferProgress, finished: boolean) => {
			this.transfer = {
				kind: 'export',
				subject: project.name,
				files: progress.files,
				totalFiles: progress.totalFiles,
				finished
			};
		};
		try {
			const exported = await exportProjectZip(this.#workspace.store, project.directory, {
				onProgress: (progress) => announce(progress, false)
			});
			await saveFile(exported.fileName, exported.body);
			announce(
				{
					files: exported.totalFiles,
					totalFiles: exported.totalFiles,
					bytes: exported.totalBytes,
					totalBytes: exported.totalBytes,
					path: null
				},
				true
			);
		} catch (cause) {
			this.transfer = null;
			this.transferError = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * Read a zip the user chose and work out where it would go. **Writes nothing.**
	 *
	 * The whole archive is validated here, before there is anything to write, so a zip that is
	 * refused leaves the Workspace exactly as it was. On success this leaves a {@link pendingImport}
	 * for {@link confirmImport}, which is what lets the collision be a question.
	 *
	 * The directory name is taken from the *file name*, because the Project's identity is its
	 * directory and a zip rooted at that directory does not carry it. Falling back to the display
	 * name inside would be wrong as a first choice: two Projects may share a display name, and
	 * deriving identity from it would refuse a colleague's Project for having the same title.
	 */
	async prepareImport(file: File): Promise<void> {
		this.transferError = '';
		this.pendingImport = null;
		try {
			const zip = await readProjectZip(new Uint8Array(await file.arrayBuffer()));
			const shortfall = await storageShortfall(zip.totalBytes);
			if (shortfall) {
				this.transferError = shortfall;
				return;
			}
			const base = file.name.replace(/\.zip$/i, '');
			// `toDirectoryName` always returns something usable, so ask separately whether the file name
			// had anything in it to work from before trusting what it produced.
			const fromFileName = /[a-z0-9]/i.test(base) ? toDirectoryName(base) : '';
			this.pendingImport = {
				zip,
				name: zip.project.name || fromFileName,
				directory: fromFileName || toDirectoryName(zip.project.name),
				collision: ''
			};
		} catch (cause) {
			this.transferError = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * Write a prepared import into `directory` (SPEC stories 13 and 14).
	 *
	 * A collision does not fail the import: it comes back as a question with the offending name and
	 * a free one, and the pending zip stays in hand so answering it costs nothing. Nothing has been
	 * written at the point the question is asked, which is the property that matters — the user may
	 * be importing a colleague's version of work they also have.
	 *
	 * @returns the imported Project, or `null` when it was refused
	 */
	async confirmImport(directory: string): Promise<ProjectSummary | null> {
		const pending = this.pendingImport;
		if (!pending) return null;
		this.transferError = '';
		const name = pending.name || directory;
		try {
			const imported = await this.#workspace.importProject(directory, pending.zip, {
				onProgress: (progress) => {
					this.transfer = {
						kind: 'import',
						subject: name,
						files: progress.files,
						totalFiles: progress.totalFiles,
						finished: false
					};
				}
			});
			this.transfer = {
				kind: 'import',
				subject: name,
				files: pending.zip.paths.length,
				totalFiles: pending.zip.paths.length,
				finished: true
			};
			this.pendingImport = null;
			await this.refresh();
			return imported;
		} catch (cause) {
			this.transfer = null;
			if (cause instanceof ProjectDirectoryCollisionError) {
				// Kept, not discarded: the archive is already validated and in hand, so the user answers
				// with a name rather than choosing the file again.
				this.pendingImport = {
					...pending,
					directory: cause.suggestion,
					collision: cause.message
				};
				return null;
			}
			this.transferError = cause instanceof Error ? cause.message : String(cause);
			return null;
		}
	}

	/** Abandon a prepared import. Nothing was written, so there is nothing to undo. */
	cancelImport(): void {
		this.pendingImport = null;
		this.transferError = '';
	}

	/** Clear the announced transfer status, once the user has had a chance to read it. */
	clearTransfer(): void {
		this.transfer = null;
	}

	/**
	 * Show the Project named by `?p=`, or the hub when `directory` is `null`.
	 *
	 * Reads and nothing else. Opening last year's work must leave every byte of it alone
	 * (ADR-0010), so there is no write anywhere on this path — not a stamped `updatedAt`, not a
	 * normalised field.
	 *
	 * **Idempotent, and immune to a read that arrives late.** Opening is driven by an effect over
	 * the URL, which can run more than once for one navigation, and the naive version blanked
	 * {@link openProject} and re-read it every time. An edit typed inside that window was dropped
	 * silently — `typeProjectName` saw no open Project and returned — and the field snapped back to
	 * the name on disk with nothing to say it had happened. Losing a keystroke is a small thing;
	 * losing it invisibly, in the one component whose whole job is not losing work, is not.
	 */
	async open(directory: string | null): Promise<void> {
		// Already showing it. Re-opening the same Project can only discard what is in memory.
		if (directory !== null && directory === this.openDirectory && this.openProject !== null) {
			return;
		}
		const generation = ++this.#openGeneration;
		await this.flush();
		if (generation !== this.#openGeneration) return;
		this.openDirectory = directory;
		this.openProject = null;
		this.projectProblem = null;
		this.images = [];
		this.ingestError = '';
		// The hub is what a null `?p=` shows, and it needs the list. Listing here rather than on
		// every mutation is what keeps typing a Project name from walking the whole Workspace once
		// per keystroke — a 2 GB pyramid is tens of thousands of files.
		if (directory === null) return this.refresh();

		try {
			const file = await this.#workspace.readProject(directory);
			// A later `open` has already moved on; this read is stale and would clobber it.
			if (generation !== this.#openGeneration) return;
			this.openProject = file;
			this.status = 'ready';
			this.unreachableDetail = '';
			// A read, like everything else on this path: `listIngestedImages` looks for `info.json`
			// files and writes nothing (ADR-0010).
			this.images = await listIngestedImages(this.#store, directory);
		} catch (cause) {
			if (generation !== this.#openGeneration) return;
			const problem = describeProblem(cause, directory);
			if (problem) {
				// "This Project is not there" and "the Workspace is not there" are the **same failure**
				// on the read path: a Workspace folder that has been deleted makes
				// `getDirectoryHandle('amsterdam-1625')` raise the same `NotFoundError` as a Project that
				// really has gone. Blaming the Project is the worse of the two guesses by a long way — it
				// tells a scholar their work does not exist while it sits in a folder on their desk — and
				// it offers the wrong recovery, so the Workspace is asked before the Project is blamed.
				//
				// Only on this path, and only for this one kind: `refresh` walks the Workspace, which is
				// too expensive to do on the way to a Project that opened perfectly well.
				if (problem.kind === 'missing') {
					await this.refresh();
					if (generation !== this.#openGeneration) return;
					if (this.status === 'unreachable') return;
				}
				this.projectProblem = problem;
				return;
			}
			this.status = 'unreachable';
			this.unreachableDetail = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * Add a Historical Map from a file on the user's computer (SPEC stories 21, 22, 23).
	 *
	 * Deliberately not routed through {@link #mutate} or {@link Autosave}. A pyramid is thousands of
	 * immutable files written once, not a document edited repeatedly, so coalescing writes would only
	 * add a buffer the size of the image; and ADR-0017's autosave rules are about an edit that is
	 * ending, which this is not. It also must not touch `project.json`: the Layer that refers to this
	 * image arrives in ticket 09, and stamping `updatedAt` now would be a write with nothing behind
	 * it.
	 *
	 * The two tilers are handed in from here — the one place in the app that knows both that
	 * `wasm-vips` exists and that it must not be fetched until it is needed (ADR-0019).
	 */
	async ingestImage(file: File): Promise<void> {
		const directory = this.openDirectory;
		if (!directory || this.ingest) return;

		this.ingestError = '';
		this.ingestLabel = file.name;
		this.ingest = {
			phase: 'inspecting',
			tiler: undefined,
			tilesWritten: 0,
			tileCount: 0,
			fraction: 0
		};

		try {
			await ingestImageFile({
				store: this.#store,
				projectDirectory: directory,
				file,
				openDecodeAndCrop: openDecodeAndCropSource,
				openStreaming: streamingTiler(loadLibvips),
				onProgress: (progress) => {
					this.ingest = progress;
				}
			});
			this.images = await listIngestedImages(this.#store, directory);
		} catch (cause) {
			this.ingestError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			this.ingest = null;
			this.ingestLabel = '';
		}
	}

	/**
	 * A `fetch` that answers the open Project's stored pyramids, or `null` when none is open.
	 *
	 * The ADR-0011 injection layer, handed out from here because this is the only place the app
	 * talks to `@ballastella/core` and the only place that holds the store. Every consumer of a
	 * Historical Map's bytes takes this one function: the image pane's MapLibre source through
	 * `addProtocol`, `@allmaps/maplibre` through its `fetchFn` option, and OpenSeadragon's
	 * `TileSource` at ticket 14. Requests to any other host pass straight through to the network,
	 * so a remote referenced image keeps working unchanged.
	 */
	imageServiceFetch(): FetchFn | null {
		const directory = this.openDirectory;
		return directory === null
			? null
			: createStoreImageFetch({ store: this.#store, projectDirectory: directory });
	}

	/**
	 * Read one Historical Map's Alignment, or start a new one over the whole image.
	 *
	 * A Project with no Alignment for an image is the ordinary first case, not a failure, so a
	 * missing file comes back as a fresh Alignment rather than as an error — and **nothing is
	 * written here**. ADR-0010: merely opening last year's Project must not modify a single byte of
	 * it, so the file appears only when the user makes their first Control Point.
	 *
	 * A file that exists and cannot be read is a different matter and is surfaced: it means an
	 * Alignment the user made is not being shown, and silently replacing it with an empty one would
	 * discard their work on the next save.
	 */
	async readAlignment(
		imageId: string,
		image: { width: number; height: number }
	): Promise<Alignment> {
		const directory = this.openDirectory;
		this.alignmentError = '';
		if (!directory) return newAlignment(imageId, image);

		try {
			const bytes = await this.#store.read(alignmentStorePath(directory, imageId));
			return parseAlignment(bytes, { imageId });
		} catch (cause) {
			if (cause instanceof PathNotFoundError) return newAlignment(imageId, image);
			this.alignmentError = cause instanceof Error ? cause.message : String(cause);
			throw cause;
		}
	}

	/**
	 * Write an Alignment (SPEC stories 91 and 94).
	 *
	 * **Now, not on a timer.** Every edit that reaches here is a discrete act or the end of a
	 * gesture — a pair completed, a dragged half released on pointer-up, a pair deleted — which is
	 * ADR-0017 rule 1, and is why a drag costs exactly one store write rather than one per frame.
	 * The debounce is for text being typed; there is no such thing here.
	 *
	 * Routed through the same {@link Autosave} as `project.json` so that rule 2's per-file debounce
	 * and rule 5's save state are one mechanism rather than one per file kind. It writes a different
	 * file, though: **nothing here touches `project.json`.** The Layer that will reference this
	 * Alignment arrives in ticket 09, and stamping `updatedAt` now would be a write with nothing
	 * behind it — and a second writer of the document this class holds the only copy of.
	 */
	async writeAlignment(alignment: Alignment): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;
		const path = alignmentStorePath(directory, alignment.imageId);
		try {
			await this.#autosave.commit(path, serialiseAlignment(alignment));
			this.saveError = '';
			// After the write resolved, so an attempt the store refused is not counted as one that
			// happened. This is what lets the drag test assert the *number* of writes.
			recordAlignmentWrite(path, alignment.controlPoints.length);
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * The open Project's display name is being typed. Coalesced per file, so a name typed one
	 * character at a time is one write and not twelve (ADR-0017 rule 2).
	 */
	async typeProjectName(displayName: string): Promise<void> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;
		this.openProject = { ...this.openProject, name: displayName };
		await this.#write(directory, { debounce: true });
	}

	/**
	 * The edit is over — the field lost focus, or Enter was pressed. Writes now rather than on a
	 * timer, the same rule a dragged Control Point will follow on pointer-up (ADR-0017 rule 1).
	 *
	 * A no-op when nothing is waiting to be written. Rule 1 is "commit the edit that is ending",
	 * not "write on every blur": tabbing through the name field must not rewrite `project.json`,
	 * because `writeProject` stamps a fresh `updatedAt` and ADR-0010 is explicit that merely
	 * looking at an old Project must not modify files.
	 */
	async commitProjectName(): Promise<void> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;
		if (!this.#autosave.hasPendingWrite(projectFilePath(directory))) return;
		await this.#write(directory);
	}

	/**
	 * Record the author's default Base Map (ADR-0020, ticket 04).
	 *
	 * A discrete choice, so it is written now rather than debounced, and through the same
	 * `Workspace` and the same in-memory document as every other mutation — the id is one field
	 * of `project.json`, not a file of its own.
	 */
	async chooseBaseMap(id: string): Promise<void> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;
		this.openProject = { ...this.openProject, baseMap: id };
		await this.#write(directory);
	}

	/** Write everything pending and wait for the store to have it. */
	async flush(): Promise<void> {
		await this.#autosave.flush();
	}

	/**
	 * Write the open Project's document.
	 *
	 * Deliberately not routed through {@link #mutate}: an edit inside a Project does not change
	 * the hub's list of them, and a failed write is a save-state problem rather than an
	 * unreachable Workspace.
	 */
	async #write(directory: string, options: { debounce?: boolean } = {}): Promise<void> {
		try {
			await this.#workspace.writeProject(directory, this.openProject as ProjectFile, options);
			this.saveError = '';
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * A hub action: it changes which Projects exist, so the list is reloaded after it.
	 *
	 * @param directory the Project it acts on, for the message when that Project has gone
	 */
	async #mutate<T>(directory: string | null, action: () => Promise<T>): Promise<T | null> {
		try {
			const result = await action();
			this.projects = await this.#workspace.listProjects();
			this.status = 'ready';
			this.unreachableDetail = '';
			return result;
		} catch (cause) {
			// A Project that another tab deleted, or one from a newer version, is a problem with
			// that Project — not with the Workspace, which is right here and still lists. Rendering
			// "Workspace not reachable" over a reachable Workspace is its own kind of data-loss
			// scare, and it hides the recovery the user actually has.
			const problem = describeProblem(cause, directory);
			if (problem) {
				this.projectProblem = problem;
				await this.refresh();
				return null;
			}
			this.status = 'unreachable';
			this.unreachableDetail = cause instanceof Error ? cause.message : String(cause);
			return null;
		}
	}
}

/**
 * Why this Project will not fit, or `''` when it will or when nobody can say.
 *
 * Asked **before the import is offered**, not discovered part way through it. A zip declares how
 * much it unpacks to, and browser-managed storage will say how much room is left, so the one moment
 * this is worth asking is while nothing has been written and cancelling costs nothing — running out
 * of room mid-import is a rollback and a wasted wait even when it is handled cleanly.
 *
 * Only browser-managed storage answers: `navigator.storage.estimate()` describes the origin's quota,
 * which is the OPFS Workspace. A folder Workspace (ticket 12) is on the user's own disk with no
 * quota to ask about, so nothing is claimed — a silent pass rather than a guess against the wrong
 * number, since ticket 13's import bound is what stands between an untrusted archive and that disk.
 */
async function storageShortfall(needed: number): Promise<string> {
	if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return '';
	let free: number;
	try {
		const { quota, usage } = await navigator.storage.estimate();
		if (typeof quota !== 'number' || typeof usage !== 'number') return '';
		free = quota - usage;
	} catch {
		// A browser that will not answer is not a browser that has said no.
		return '';
	}
	if (needed <= free) return '';
	const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
	return (
		`This Project needs about ${mb(needed)}, and this browser has about ${mb(Math.max(free, 0))} ` +
		`left for Ballastella. Free some space, or put your Workspace in a folder on your computer, ` +
		`and try again. Nothing has been imported.`
	);
}

/**
 * A failure that is about one Project rather than about the Workspace, described for a reader.
 * `null` for anything else, which the caller renders as an unreachable Workspace.
 */
function describeProblem(cause: unknown, directory: string | null): ProjectProblem | null {
	if (cause instanceof ProjectFormatTooNewError) {
		return { kind: 'format-too-new', message: cause.message };
	}
	if (cause instanceof PathNotFoundError) {
		return {
			kind: 'missing',
			message: directory
				? `There is no Project called “${directory}” in this Workspace.`
				: `Something this action needed is no longer in the Workspace: ${cause.message}`
		};
	}
	if (cause instanceof ProjectFileUnreadableError) {
		return { kind: 'unreadable', message: cause.message };
	}
	return null;
}

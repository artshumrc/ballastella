import { fetchAnnotationsFromApi } from '@allmaps/stdlib';
import { SvelteSet } from 'svelte/reactivity';

import {
	Autosave,
	HistoricalMapInUseError,
	HistoricalMapPartlyDeletedError,
	OpfsProjectStore,
	PathNotFoundError,
	ProjectDirectoryCollisionError,
	ProjectFileUnreadableError,
	ProjectFormatTooNewError,
	ReservedDirectoryNameError,
	UndoSlot,
	WriteAheadJournal,
	Workspace,
	addLayer,
	alignmentPath,
	annotationStorePath,
	assembleWithCanvas,
	browserJournalStorage,
	replayIsNoteworthy,
	replayJournal,
	// Aliased for the same reason `stampCanonicalUrl` is: the session has methods of these names, and
	// two things called one word is how a later edit calls the wrong one.
	baseMapCacheSize as readBaseMapCacheSize,
	baseMapCacheSizeFor as readBaseMapCacheSizeFor,
	cachedTilePath,
	clearBaseMapCache as emptyBaseMapCache,
	createStoreImageFetch,
	readCachedTileSource,
	writeCachedTileSource,
	deleteHistoricalMap,
	emptyAnnotationCollection,
	exportProjectZip,
	imageDirectory,
	imageManifestPath,
	ingestImageFile,
	fetchTilesIntoCache,
	insertLayerAt,
	installFlushOnHide,
	listIngestedImages,
	listReferencedImages,
	listWorkspaceHistoricalMaps,
	makeOfflineCopy,
	moveLayer,
	isControlPointUndo,
	layerFileRef,
	newAlignment,
	newAnnotationLayer,
	newMapLayer,
	normaliseCanonicalUrl,
	offlineCoverage,
	emptyCollection,
	openDecodeAndCropSource,
	parseAlignment,
	parseAnnotations,
	partitionByOfflineCopy,
	planPublish,
	projectFilePath,
	publishSite,
	readPublishedSite,
	readImageLabel,
	readProjectZip,
	referencedAlignmentAddress,
	referencedImage,
	referencedImagePath,
	removeLayer,
	renameLayer,
	serialiseAnnotations,
	serialiseReferencedImage,
	setLayerVisible,
	setMapLayerOpacity,
	// Aliased: the session has a method of the same name, and the two doing different amounts of work
	// under one word is how a later edit calls the wrong one.
	stampCanonicalUrl as stampWorkspaceImages,
	toDirectoryName,
	workspaceSize,
	writeAlignmentFile,
	type Alignment,
	type AlignmentAddress,
	type AlignmentFilePort,
	type AlignmentWriteOutcome,
	type AnnotationCollection,
	type AnnotationLayer,
	type BaseMapCacheSize,
	type Bytes,
	type CachedTileSource,
	type FetchFn,
	type FetchTilesOptions,
	type GeoBounds,
	type IngestProgress,
	type IngestedImage,
	type JournalReplayReport,
	type JournalStorage,
	type Layer,
	type MapLayer,
	type OfflineCopyPlan,
	type OfflineCopyProgress,
	type OfflineCoverage,
	type ProjectFile,
	type ProjectStore,
	type ProjectSummary,
	type ProjectZip,
	type PublishPlan,
	type PublishedSite,
	type ReferencedImage,
	type RemoteImageService,
	type SaveState,
	type SimpleStyle,
	type TileCoordinate,
	type TileFetchResult,
	type TransferProgress,
	type UndoRecord,
	type ViewerBundle,
	type ViewerBundleFile,
	type WorkspaceHistoricalMap,
	type WorkspaceSize
} from '@ballastella/core';

import { recordAlignmentWrite } from './alignment/browser-test-handle.js';
import { recordAnnotationWrite } from './annotations/browser-test-handle.js';
import { saveFile } from './save-file.js';

/**
 * Whether the workspace can be reached. Not reachable is a **normal state** with a
 * locate-again affordance, not an unhandled rejection at startup (ADR-0008): a folder gets
 * moved, renamed, deleted, or has its permission declined, and a scholar who meets a stack
 * trace at that moment reasonably concludes the tool has eaten their work.
 */
export type WorkspaceStatus = 'loading' | 'ready' | 'unreachable';

/**
 * The write-ahead journal's key for a named Workspace in browser storage, and for a folder.
 *
 * **The backing is in the key**, because a folder called `Marking 2026` and an OPFS Workspace
 * called `Marking 2026` are two different places holding two different people's afternoons, and one
 * replaying into the other is exactly the failure ticket 12 made easy to reach.
 */
export const opfsWorkspaceKey = (name: string): string => `opfs:${name}`;
export const folderWorkspaceKey = (folderName: string): string => `folder:${folderName}`;

/**
 * A journal key as a **Workspace the user recognises**, never as the key itself.
 *
 * ⚠ **`opfs:` is a debug token and it was reaching the screen**, in "finished saving in
 * `opfs:Marking 2026`" and on the buttons in Workspace settings. CONTEXT.md is that the UI names
 * the Workspace; a scholar has never seen that prefix and has no way to find out what it means.
 *
 * The folder case keeps a qualifier rather than dropping the distinction, because a folder
 * Workspace and a browser-storage one may share a name and the sentence has to be true of exactly
 * one of them.
 */
export function workspaceKeyLabel(key: string): string {
	if (key.startsWith('opfs:')) return key.slice('opfs:'.length);
	if (key.startsWith('folder:')) return `${key.slice('folder:'.length)} (Workspace folder)`;
	// A key from a build that keyed them differently. Shown as it is rather than mangled: the user
	// is being asked to recognise it, and a prefix this build does not know is information.
	return key;
}

/**
 * A transfer in flight, for the status region that announces it.
 *
 * A zip of an offline copy's pyramid takes real seconds to tens of seconds, and it is announced rather
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

/**
 * Why the Project named in `?p=` cannot be shown, or why the one that was asked for was not made.
 *
 * `'reserved-name'` is the second of those and the only one that is about a Project which does not
 * exist yet: ADR-0023 keeps `images/`, `alignments/`, and `base-map/` for the Workspace itself, and a
 * scholar typing "Images" has done nothing wrong — `toDirectoryName` is what turned it into a
 * collision. It is a problem with the *name*, so it is rendered on the hub beside the list, and never
 * as an unreachable Workspace: the Workspace is right there and every other Project must stay visible.
 */
export type ProjectProblem =
	| { readonly kind: 'format-too-new' | 'unreadable'; readonly message: string }
	| { readonly kind: 'missing'; readonly message: string }
	| { readonly kind: 'reserved-name'; readonly message: string };

/**
 * What adding a Historical Map did to `alignments/<image-id>.json`.
 *
 * Three outcomes rather than a boolean because only one of them is worth telling the user about,
 * and it is not the one a boolean would name. `'left alone'` is the ordinary re-add, silent by
 * design; `'kept over the offer'` is the user having asked for a community Alignment and not got
 * it, which must be said out loud — a Historical Map has **one** Alignment, shared by every Project
 * that draws it (ADR-0023), so importing over it would have discarded work that may belong to a
 * Project the user is not even looking at.
 *
 * **The union itself is `AlignmentWriteOutcome`, imported rather than restated** (ticket 18). It was
 * spelled out here as well, which is two spellings of one vocabulary in the ticket that exists
 * because two spellings of one rule drifted apart.
 */
type InitialAlignment = AlignmentWriteOutcome;

/** A Historical Map put in the stack, and what became of its Alignment. */
type MapLayerAdded = {
	/** The new Layer, or the one this Project already had for this Historical Map. */
	readonly layer: MapLayer;
	readonly alignment: InitialAlignment;
};

/** The outcome of {@link EditorSession.addReferencedMap}. */
export type ReferencedMapAdded = {
	/** The new Layer, or the one this Project already had for this Historical Map. */
	readonly layer: MapLayer;
	/**
	 * The user chose a community Alignment and it was **not** written, because this Workspace already
	 * holds an Alignment for that Historical Map that somebody has worked on. The Layer was still
	 * added, and it draws the Alignment that was already there. The surface that asked must say so.
	 */
	readonly keptExistingAlignment: boolean;
};

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
/** How a session is told which Workspace it is, which is what the journal is keyed by. */
export interface EditorSessionOptions {
	/**
	 * Where an edit is written ahead of the store (ticket 20).
	 *
	 * Optional, and its absence is a real state rather than a default: a browser with no usable
	 * `localStorage` — a locked-down private window — cannot offer this protection at all, and a
	 * silent stand-in would make the app claim a guarantee it does not have.
	 */
	readonly journalStorage?: JournalStorage;
	/**
	 * Which Workspace this session is, for the journal's key.
	 *
	 * ⚠ **Includes the backing, because two different Workspaces may share a name.** `opfs:Marking
	 * 2026` and `folder:Marking 2026` are two directories in two places, and an edit typed into one
	 * must not be replayed into the other.
	 *
	 * ⚠ **And a folder Workspace is identified by its folder's name, which is not unique.** The
	 * browser offers a picked directory no stable identifier a page may keep, so two folders called
	 * `maps` on two drives share a key. What bounds the damage is replay's own precondition — the
	 * Project's `project.json` has to still be there — and what remains is a case that is strictly
	 * better than today's, where the edit is simply lost. It is recorded in ADR-0017 rather than
	 * left here to be found.
	 */
	readonly workspaceKey?: string;
}

export class EditorSession {
	readonly #workspace: Workspace;
	readonly #autosave: Autosave;
	/** The write-ahead journal for **this** Workspace, or `undefined` where there can be none. */
	readonly #journal: WriteAheadJournal | undefined;
	readonly #journalStorage: JournalStorage | undefined;
	/** Held for the tiler, which writes tens of thousands of files that are not `project.json`. */
	readonly #store: ProjectStore;
	/** Bumped by every {@link open}, so a read that resolves late knows it has been superseded. */
	#openGeneration = 0;
	/**
	 * The one destructive action that can be reversed (ADR-0014, ticket 11).
	 *
	 * Here rather than in a component because it is one slot for the whole session — the four covered
	 * actions happen in two different panes, and two slots would mean two things each claiming to be
	 * "the last destructive action". {@link undoable} is its projection into reactive state.
	 */
	readonly #undo = new UndoSlot();

	status = $state<WorkspaceStatus>('loading');
	/** The underlying failure, shown beneath "Workspace not reachable" so it is diagnosable. */
	unreachableDetail = $state('');
	projects = $state<ProjectSummary[]>([]);
	saveState = $state<SaveState>('saved');
	/**
	 * Why the last edit is **not** protected against this tab closing before it is saved, or `''`.
	 *
	 * Distinct from {@link saveError}, which is why an edit did not reach storage. This one says the
	 * edit is on its way and the safety net under it is missing — a different sentence with a
	 * different remedy, and one the user can act on only while the page still exists (ticket 20).
	 */
	protectionWarning = $state('');
	/**
	 * What the last startup replay put back, if anything, for the user to be told about.
	 *
	 * `null` until a replay has run, and left `null` when it had nothing to say. SPEC story 111 wants
	 * this as visible text and story 112 wants it announced, and a recovery the user cannot tell
	 * happened is one they cannot check.
	 */
	replayReport = $state<JournalReplayReport | null>(null);
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
	 * What undo would reverse, or `null` when there is nothing to reverse (SPEC story 38).
	 *
	 * Rendered by `UndoControl`, which names the action rather than saying "Undo": a bare button after
	 * an accidental delete does not answer the question the user actually has. `null` is what makes "a
	 * second undo does nothing **and is not offered**" one fact rather than two.
	 */
	undoable = $state<UndoRecord | null>(null);

	/**
	 * The Historical Maps **the Workspace** holds, and the ingest running now if one is (ADR-0023).
	 *
	 * Not the open Project's: a pyramid is shared, so `images/` has one answer whichever Project is
	 * open, and which of these a Project *draws* is its Layer stack rather than a second list.
	 *
	 * `ingest` is `null` between jobs rather than a finished-looking value, so the progress region
	 * disappears when there is nothing to report instead of sitting at 100% forever.
	 */
	images = $state<IngestedImage[]>([]);
	/**
	 * The Historical Maps the Workspace **references** rather than holds (ADR-0007, ADR-0023).
	 *
	 * A separate list from {@link images}: a local copy has an `info.json` of ours beside it and a
	 * referenced image has a `remote.json` instead, because its tiles and its description are both on
	 * somebody else's server. Keeping them apart is what makes "referenced or local copy?" an
	 * observation of the files rather than a flag in `project.json` that could disagree with them.
	 *
	 * An image that has been copied offline appears in **both** — its pyramid is here and its
	 * `remote.json` stays, because that record is the citation ADR-0007 protects — so this is the list of
	 * everything the Workspace knows an origin for, and {@link remoteOrigins} is what says which are
	 * still fetched from the library.
	 */
	referencedImages = $state<ReferencedImage[]>([]);
	/**
	 * Referenced images whose `remote.json` will not parse, by id and reason.
	 *
	 * Surfaced rather than swallowed, for the same reason {@link alignmentError} is: the Project has a
	 * Layer that names an image nothing can draw, and drawing nothing while saying nothing is how a
	 * user concludes the tool lost their work.
	 */
	referencedImageErrors = $state<{ imageId: string; reason: string }[]>([]);

	/**
	 * Every Historical Map in the Workspace, with its size, where its tiles are, and who draws it.
	 *
	 * The hub's reclaim list — the one place a scholar can answer "why is my Workspace two gigabytes?"
	 * (SPEC stories 63–65). Loaded by {@link refreshHistoricalMaps} rather than on every render, because
	 * it weighs every file under `images/` and that is a walk a keystroke must not trigger.
	 *
	 * A **separate** list from {@link images} and {@link referencedImages}, which are what an open
	 * Project's panes read: those two are the raw halves of the observation, and this is the answer with
	 * used-by and a size against it.
	 */
	historicalMaps = $state<WorkspaceHistoricalMap[]>([]);
	/** Whether {@link historicalMaps} is still being walked, so the hub can say so rather than "none". */
	historicalMapsLoading = $state(false);
	/**
	 * Why the last attempt to delete a Historical Map did not happen, or `''`.
	 *
	 * A refusal rather than an error boundary: a map two Projects draw cannot be deleted, and the
	 * sentence naming them is the whole of the interaction (SPEC story 64).
	 */
	historicalMapError = $state('');

	ingest = $state<IngestProgress | null>(null);
	/** The name of the file being ingested, for the progress message (SPEC story 23). */
	ingestLabel = $state('');
	ingestError = $state('');
	/** Not `$state`: nothing renders it, and `cancelIngest` is the only reader. */
	#ingestAbort: AbortController | null = null;

	/**
	 * Why the Historical Map's stored Alignment could not be read, if it could not.
	 *
	 * A file that is there and unreadable must say so. Falling back to an empty Alignment silently
	 * would show the user no Control Points and then overwrite the ones they had on the next save —
	 * which is the largest single loss this slice could inflict.
	 */
	alignmentError = $state('');

	constructor(store: ProjectStore, options: EditorSessionOptions = {}) {
		this.#store = store;
		this.#journalStorage = options.journalStorage;
		this.#journal =
			options.journalStorage && options.workspaceKey
				? new WriteAheadJournal(options.journalStorage, options.workspaceKey)
				: undefined;
		this.#autosave = new Autosave(store, {
			...(this.#journal ? { journal: this.#journal } : {}),
			// The whole reason the journal is written at the edit rather than at `pagehide`: there is
			// still a screen to put this on and a person to read it (SPEC stories 111 and 112). At
			// `pagehide` there would be neither.
			onJournalRefused: (problem) => {
				this.protectionWarning =
					problem === null ? '' : problem instanceof Error ? problem.message : String(problem);
			}
		});
		this.#workspace = new Workspace(store, { autosave: this.#autosave });
		this.#autosave.subscribe((state) => {
			this.saveState = state;
		});
		// The same shape as the save state above: a plain core object that publishes, projected into
		// reactive state here, so there is one implementation of the semantics and one thing that renders.
		this.#undo.subscribe((record) => {
			this.undoable = record;
		});
	}

	/** The default: a named workspace in OPFS, which every modern browser has (ADR-0001, ADR-0024). */
	static opfs(name: string): EditorSession {
		const journalStorage = browserJournalStorage();
		return new EditorSession(OpfsProjectStore.open(name), {
			...(journalStorage ? { journalStorage } : {}),
			workspaceKey: opfsWorkspaceKey(name)
		});
	}

	/**
	 * Put back whatever the journal is still holding for this Workspace (ticket 20).
	 *
	 * Called once, as the Workspace is adopted, and never twice for the same session: replay drops
	 * every entry it wrote, so a second call finds nothing — but the *report* is what the user reads,
	 * and re-running would clear it.
	 *
	 * Resolves rather than rejects. A Workspace too broken to replay into is one the listing beside
	 * this is about to describe properly (ADR-0008), and a rejection from here would replace that
	 * with an error boundary.
	 */
	async replayJournalledEdits(): Promise<void> {
		const journal = this.#journal;
		const storage = this.#journalStorage;
		if (!journal || !storage) return;
		try {
			const report = await replayJournal(storage, this.#store, journal.workspace);
			this.replayReport = replayIsNoteworthy(report) ? report : null;
		} catch {
			// A store that cannot even be listed. The entries stay where they are, and the listing
			// beside this is what tells the user the Workspace is unreachable.
		}
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

	/**
	 * The store this session is bound to.
	 *
	 * For the whole-Workspace operations that are about the Workspace rather than about a Project, and
	 * therefore live on `WorkspaceStorage` rather than here — a backup is the one of those so far
	 * (ticket 13). Read-only and deliberately narrow: it does not license a second writer. Every write
	 * still goes through this session's `Workspace` and its `Autosave` (ADR-0017 rule 4), and the one
	 * caller of this only ever reads. `Workspace` exposes its own store the same way and for the same
	 * reason.
	 */
	get store(): ProjectStore {
		return this.#store;
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

	/**
	 * Remove a Project and everything in it.
	 *
	 * **The journal is emptied of it first** (ticket 20). `ProjectStore.delete` does not go through
	 * `Autosave`, so a rename still inside its debounce window would otherwise sit in the journal and
	 * be replayed at the next startup — putting `project.json` back into a directory the user had
	 * just watched disappear. Replay has its own precondition for this, and it cannot see the case
	 * that matters here: a *new* Project made afterwards under the same directory name, which from
	 * replay's side is indistinguishable from the old one still being there.
	 *
	 * Before the deletion rather than after, so a deletion that fails part way through does not leave
	 * journalled bytes for files that have gone.
	 */
	async deleteProject(directory: string): Promise<void> {
		this.#journal?.forgetUnder(`${directory}/`);
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

	/**
	 * Put down a refusal the user has now had a chance to act on.
	 *
	 * Called when the New Project dialog is opened again, so that a refused name is not still being
	 * complained about over the attempt to replace it. A successful {@link #mutate} clears it too.
	 */
	dismissProjectProblem(): void {
		this.projectProblem = null;
	}

	/**
	 * Clear the last Historical Map refusal.
	 *
	 * Called when a deletion is asked for again, so the sentence beside the list is always about the
	 * click the user has just made rather than about a map they have since stopped thinking about.
	 */
	dismissHistoricalMapError(): void {
		this.historicalMapError = '';
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
		// The undo record is cleared when the Project is closed and does not persist (ADR-0014). Here
		// rather than on navigation, because this is the one place that knows the Project has changed —
		// and it is *after* the "already showing it" return above, so moving between the panes of one
		// Project leaves a pending undo alone.
		this.#undo.clear();
		this.images = [];
		this.referencedImages = [];
		this.referencedImageErrors = [];
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
			// files and writes nothing (ADR-0010). `listReferencedImages` looks for `remote.json`, which
			// is the same walk of the same directory and is where the other kind of Historical Map is.
			//
			// Both walk the **Workspace's** `images/` rather than this Project's, because that is where the
			// pyramids are (ADR-0023). Nothing is reconciled afterwards: which of these a Layer draws is the
			// Layer's `imageId`, and whether the tiles are local is read off the files, so there is no
			// stored claim left that could disagree with the folder.
			this.images = await listIngestedImages(this.#store);
			const referenced = await listReferencedImages(this.#store);
			if (generation !== this.#openGeneration) return;
			this.referencedImages = referenced.images;
			this.referencedImageErrors = referenced.unreadable;
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
	 * **The pyramid lands in the Workspace, not in the Project** (ADR-0023), so the map this adds is
	 * available to every Project from the moment it is prepared. The open Project is required, because
	 * the gesture that reaches here is inside one and **the Layer is made now** — adding a Historical
	 * Map is the one thing that puts a map Layer in the stack (ADR-0023), and it is made whether or not
	 * anyone ever places a Control Point on it.
	 *
	 * The tiling itself is deliberately not routed through {@link #mutate} or {@link Autosave}. A
	 * pyramid is thousands of immutable files written once, not a document edited repeatedly, so
	 * coalescing writes would only add a buffer the size of the image; and ADR-0017's autosave rules are
	 * about an edit that is ending, which this is not. `project.json` is written once at the end, by
	 * {@link #addMapLayer}, because the stack genuinely changed.
	 *
	 * The tiler is handed in from here, because `@ballastella/core` names the seam rather than
	 * reaching for a canvas of its own (ADR-0019). An image larger than a browser will decode is
	 * refused by `ingestImageFile` before anything is opened (ADR-0027); there is no second tiler to
	 * fall back to and the refusal says so in terms of the image rather than of the deployment.
	 */
	async ingestImage(file: File): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;

		// ─────────────────────────────────────────────────────────────────────────────────────────
		// **ONE INGEST AT A TIME, AND SAYING SO IS THE POINT** (ticket 17's rule, found again).
		//
		// This used to be `if (!directory || this.ingest) return;` — a second file discarded in
		// silence, with no error, no announcement and nothing on screen that changed. The comment
		// below on the `images` listing already recorded the symptom ("picking the next file inside
		// that window did nothing at all") and answered it by moving the *listing* last; but the
		// signal the Project screen actually shows for "it is here" is the **Layer row**, which
		// {@link #addMapLayer} publishes several awaits before this method's `finally` clears
		// {@link ingest}. So the window it was closing never closed, and the drop stayed silent.
		//
		// The file input beside it is `disabled` while an ingest runs, which is what keeps a person
		// out of this window — a `change` event does not originate from a disabled input. It is not
		// what keeps a *caller* out: `setInputFiles` in the browser suite performs no enabled check
		// and dispatches `change` on a disabled input regardless (measured on @playwright/test
		// 1.62.1), and this silent return is what
		// `editor-stored-image-pane.e2e.ts`'s two-pyramid test spent 30 s waiting for in 6 runs of 30.
		//
		// So the guard stays — a second tiler running against the same Workspace is not wanted — and
		// it now answers. A refusal a user can read is the difference between "the app is busy" and
		// "the app is broken", and it costs one line.
		if (this.ingest) {
			this.ingestError = `“${file.name}” was not added: “${this.ingestLabel}” is still being prepared. Wait for it to finish, then pick the file again.`;
			return;
		}

		this.ingestError = '';
		this.ingestLabel = file.name;
		this.ingest = {
			phase: 'inspecting',
			tilesWritten: 0,
			tileCount: 0,
			fraction: 0
		};

		// A gigapixel scan is thousands of tiles and minutes of work, and picking the wrong file is
		// ordinary. `ingestImageFile` has taken a signal and cleaned up after itself since it was
		// written; nothing supplied one, so the claim was in a comment and not in the app.
		const controller = new AbortController();
		this.#ingestAbort = controller;

		try {
			const ingested = await ingestImageFile({
				store: this.#store,
				file,
				openDecodeAndCrop: openDecodeAndCropSource,
				onProgress: (progress) => {
					this.ingest = progress;
				},
				signal: controller.signal
			});
			// **The Layer, now.** A local image id is random (ADR-0015), so this is always a Historical
			// Map no Layer draws yet and always a Layer added rather than a no-op — but it goes through
			// the same method the referenced path uses, so there is one implementation of "adding a map
			// puts a Layer in the stack" rather than two that can drift.
			await this.#addMapLayer({ imageId: ingested.imageId, image: ingested });
			// **Last, so the map appears in the list only once the whole add is done.** The list is what
			// the interface shows for "it is here", and the file input beside it is disabled while
			// {@link ingest} is running — so listing the pyramid before the Layer and the Alignment were
			// written made a Historical Map look added while the second half was still in flight, and
			// picking the next file inside that window did nothing at all.
			this.images = await listIngestedImages(this.#store);
		} catch (cause) {
			// A cancellation is not a failure and must not be reported as one: the user asked for it,
			// and the job has already removed the tiles it had written.
			this.ingestError = controller.signal.aborted
				? ''
				: cause instanceof Error
					? cause.message
					: String(cause);
		} finally {
			this.#ingestAbort = null;
			this.ingest = null;
			this.ingestLabel = '';
		}
	}

	/** Stop the ingest in progress, if there is one. Leaves the Project as it was. */
	cancelIngest(): void {
		this.#ingestAbort?.abort();
	}

	/**
	 * A `fetch` that answers the Workspace's stored pyramids.
	 *
	 * The ADR-0011 injection layer, handed out from here because this is the only place the app
	 * talks to `@ballastella/core` and the only place that holds the store. Every consumer of a
	 * Historical Map's bytes takes this one function: the image pane's MapLibre source through
	 * `addProtocol`, `@allmaps/maplibre` through its `fetchFn` option, and OpenSeadragon's
	 * `TileSource`. Requests to any other host pass straight through to the network, so a remote
	 * referenced image keeps working unchanged.
	 *
	 * **No longer nullable, because it no longer depends on a Project being open** (ADR-0023). The
	 * pyramids are the Workspace's, so one shim serves every Project — which is exactly what makes two
	 * Projects referencing the same `imageId` draw the same bytes. The version that took a
	 * `projectDirectory` is the change SPEC calls the riskiest in the epic: rooted at a Project, this
	 * function answers a request for one map with *another map's* tiles, and nothing raises.
	 */
	imageServiceFetch(): FetchFn {
		return createStoreImageFetch({ store: this.#store });
	}

	/**
	 * Read one Historical Map's Alignment, or start a new one over the whole image.
	 *
	 * A missing file comes back as a fresh Alignment rather than as an error — and **nothing is written
	 * here**, which is ADR-0010: merely opening last year's Project, or opening the alignment view over
	 * one of its maps, must not modify a single byte of it.
	 *
	 * **When the file appears is the add, not the first Control Point** (ADR-0023). Every Historical Map
	 * in a Project has had a starter Alignment on disk since the moment it was added, because a map
	 * Layer whose `alignments/<id>.json` is absent is a Project `assertReferencesPresent` refuses. So the
	 * missing-file branch below is no longer the ordinary first case; it is a Workspace whose Alignment
	 * has been deleted or was written by an older build, and answering with a starter is what lets the
	 * user carry on rather than meeting an error over a map they can see.
	 *
	 * **Read from the Workspace, so it is the same Alignment whichever Project asked** (ADR-0023). That
	 * is the accepted risk of the move stated as code: refining it moves every Project that draws this
	 * map, published ones included.
	 *
	 * A file that exists and cannot be read is a different matter and is surfaced: it means an
	 * Alignment the user made is not being shown, and silently replacing it with an empty one would
	 * discard their work on the next save.
	 */
	async readAlignment(
		imageId: string,
		image: { width: number; height: number }
	): Promise<Alignment> {
		this.alignmentError = '';
		try {
			const bytes = await this.#store.read(alignmentPath(imageId));
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
	 * and rule 5's save state are one mechanism rather than one per file kind.
	 *
	 * **It touches `project.json` not at all, and that is ADR-0023.** A map Layer is created by exactly
	 * one thing — the user adding a Historical Map to a Project — so placing, moving, or deleting a
	 * Control Point cannot create one, cannot rename one, and cannot reorder the stack. The version
	 * that made a Layer here needed a tombstone list in `project.json` to stop a deleted Layer coming
	 * back on the next nudge; with the Layer made by the gesture alone there is nothing to resurrect it,
	 * and that field went with it.
	 *
	 * **An `update`, said out loud** (ticket 18). This is the one write in the application that is a
	 * user editing the Alignment in front of them, so it is the one write that does not have to ask
	 * what is already on disk. Saying so is what distinguishes it from the two blind overwrites this
	 * epic wrote by accident, and it is checked: `writeAlignmentFile` is the only thing that can turn
	 * an `AlignmentPath` into a path the store will accept, and it does not take a caller that has
	 * not named its intent.
	 */
	async writeAlignment(alignment: Alignment): Promise<void> {
		// The Alignment is the Workspace's (ADR-0023), but the surface that writes one is inside a
		// Project; no Project open means no alignment workspace, and a write from nowhere is a bug
		// rather than a case to serve.
		if (!this.openDirectory) return;
		const path = alignmentPath(alignment.imageId);
		try {
			await writeAlignmentFile(this.#alignmentFile, {
				alignment,
				write: { intent: 'update' },
				// **The address has to be supplied on every write, including this one** (ADR-0007). It is
				// not carried on `Alignment` and does not survive a read, so omitting it here does not
				// leave the document's `target.source.id` alone — it rewrites it to the ADR-0004
				// placeholder. For a map whose tiles are on a Library's server that is a file Allmaps
				// cannot resolve and a Layer that renders nothing, produced by placing a Control Point.
				// `#recordLocalCopy` omits it deliberately, which is now a difference the two say out loud
				// rather than one that happens to be spelled the same.
				...this.#alignmentAddressFor(alignment.imageId)
			});
			this.saveError = '';
			// After the write resolved, so an attempt the store refused is not counted as one that
			// happened. This is what lets the drag test assert the *number* of writes.
			recordAlignmentWrite(path, alignment.controlPoints.length);
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * Give a Historical Map the Alignment it starts life with, or the one the user chose to import,
	 * and **never at the cost of one somebody has worked on** (ADR-0023).
	 *
	 * The starter is `newAlignment`: zero Control Points and a Resource Mask over the whole sheet, the
	 * same document {@link readAlignment} has always produced in memory for a map nobody has placed
	 * yet. **The difference is that it is now on disk**, and that is the whole point — a map Layer's
	 * references are derived from its `imageId`, so a Layer whose `alignments/<id>.json` does not exist
	 * is a Project `assertReferencesPresent` refuses, and this build would export a zip it then would
	 * not import (ADR-0023's consequence on the starter Alignment).
	 *
	 * This does not offend ADR-0010, which forbids writing when *merely opening* a Project. Adding a
	 * Historical Map is an explicit act, and this happens only on that act.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY AN OFFERED ALIGNMENT DOES NOT SIMPLY WIN
	 *
	 * A remote resource's image id is `generateId(uri)`, the same every time anybody adds it, and
	 * ADR-0023 moved `alignments/<id>.json` out of the Project and into the Workspace — one Alignment
	 * per Historical Map, shared by every Project that draws it. So an unconditional write here is not
	 * "overwrite the file I just made". It is: align a Library map in Project A, place Control Points,
	 * add the same map to Project B months later, accept the community offer Allmaps happens to have
	 * — and Project A's placement is gone, silently, from a gesture that said nothing about Project A.
	 *
	 * The rule is therefore **the offer is written only when there is nothing to lose**: no file at
	 * all, or a file still byte-identical to the starter. Anything else is kept, and the caller says
	 * so — because the user did ask for something, and a silent no-op is its own kind of wrong.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE DECISION ITSELF IS NOT HERE, AND THAT IS TICKET 18
	 *
	 * Everything above describes `writeAlignmentFile`'s `create` intent, which is where the rule now
	 * lives — in `@ballastella/core`, beside the type that makes a blind write fail to compile, so
	 * that the next author of an Alignment write inherits it instead of rediscovering it. This method
	 * is what is left once the decision moves out: which Alignment, and where the image is served
	 * from.
	 *
	 * @param options.address where the tiles are. A referenced image's Alignment names the Library's
	 *   service as its `resource.id` rather than the ADR-0004 placeholder (ADR-0007, SPEC story 91),
	 *   so the caller that knows the service supplies it. A value rather than a `serialise` callback,
	 *   because a callback is a second serialiser at the call site and the two spellings drift.
	 * @param options.offered an Alignment the user chose to import, or `null` for the starter.
	 */
	async #writeInitialAlignment(
		imageId: string,
		image: { width: number; height: number },
		options: {
			address?: AlignmentAddress;
			offered?: Alignment | null;
		} = {}
	): Promise<InitialAlignment> {
		// Re-keyed onto this Workspace's image id: a community Alignment arrives keyed on the Allmaps
		// identifier of the resource, which is the same string here, but the record is the authority.
		const alignment = options.offered
			? { ...options.offered, imageId }
			: newAlignment(imageId, image);
		return writeAlignmentFile(this.#alignmentFile, {
			alignment,
			write: { intent: 'create' },
			...(options.address ? { address: options.address } : {})
		});
	}

	/**
	 * Storage as `writeAlignmentFile` needs it: read from the store, commit through {@link Autosave}.
	 *
	 * Through `Autosave` and not straight to the store, which is the whole reason this is a port and
	 * not a `ProjectStore`: an Alignment write that went round `Autosave` would bypass ADR-0017 rule
	 * 2's per-file debounce and rule 5's save state, so the Saved indicator would stop describing the
	 * file the user is actually editing.
	 */
	/**
	 * Where this Historical Map's Alignment should say its image is served from, as an argument
	 * spread onto a `writeAlignmentFile` call — `{ address }` for a referenced map, `{}` for one
	 * whose pyramid is in the Workspace.
	 *
	 * **`{}` and not `{ address: undefined }`**, so a caller that spreads this cannot accidentally
	 * override an address it passed itself.
	 *
	 * Derived from whether a `remote.json` is on disk (ADR-0023: `imageMode` is observable, never
	 * stored), so it is the same answer `remoteOrigins` gives and cannot drift from it.
	 */
	#alignmentAddressFor(imageId: string): { address?: AlignmentAddress } {
		const referenced = this.remoteOrigins.referenced.find((image) => image.imageId === imageId);
		return referenced ? { address: referencedAlignmentAddress(referenced.service) } : {};
	}

	get #alignmentFile(): AlignmentFilePort {
		return {
			read: (path) => this.#store.read(path),
			commit: (path, bytes) => this.#autosave.commit(path, bytes)
		};
	}

	/**
	 * The open Project's map Layer for one Historical Map, or `undefined`.
	 *
	 * **A lookup and nothing else.** Since ADR-0023 a map that is in a Project always already has its
	 * Layer — adding the map is what made it, and made its starter Alignment with it — so the question
	 * "which Layer of this Project draws this map?" has an answer in memory and never needs a write to
	 * produce one. An earlier draft of the `/align/` route asked the same question with a method that
	 * *created* the Layer when there was none, by routing `readAlignment` into `writeAlignment`; for a
	 * map already aligned in another Project that rewrote a Workspace-shared `alignments/<id>.json`
	 * through `serialiseAlignment`, dropping every field of a third-party Alignment document that
	 * `Alignment` does not model (SPEC story 60). Merely opening a view is not a write, and this cannot
	 * become one.
	 *
	 * **`undefined` is a real answer, not a gap to fill.** `images` lists the *Workspace's* Historical
	 * Maps (ADR-0023), so a Project can be shown a map it does not draw — and putting a map into a
	 * Project is adding it, a different gesture with its own affordance, rather than something a link
	 * should do on the way past.
	 *
	 * The one implementation of this question, so `#addMapLayer` and every screen that asks it cannot
	 * drift into two answers about what counts as "this Project already draws that map".
	 */
	mapLayerFor(imageId: string): MapLayer | undefined {
		return this.openProject?.layers.find(
			(layer): layer is MapLayer => layer.kind === 'map' && layer.imageId === imageId
		);
	}

	/**
	 * Put a `kind: 'map'` Layer in the stack for a Historical Map the user has just added (ADR-0023).
	 *
	 * **The one thing in the application that creates a map Layer.** An Alignment write does not, which
	 * is what lets a deleted Layer stay deleted without a tombstone in `project.json`: nothing but this
	 * gesture can bring one back, and the gesture is the user asking for it.
	 *
	 * The name starts as the image's own label, read from its `manifest.json`, which for a file the
	 * user picked is the file's name — an image id is a random identifier (ADR-0015), so naming the
	 * Layer from it would name it after a hash. SPEC story 54 is that they can then rename it.
	 *
	 * **Adding a map this Project already draws is a no-op on the stack**, not an error and not a
	 * duplicate. The existing Layer keeps its id, its position, and the name the user gave it, and
	 * `project.json` is not written, so `updatedAt` does not move either. The test is the `imageId`,
	 * which is a map Layer's whole link to its Historical Map.
	 *
	 * **The Alignment is settled before that no-op, not after it**, which is the one thing the
	 * re-add gesture can repair. A Project written by an earlier build can hold a map Layer whose
	 * `alignments/<id>.json` was never written — that Project is un-exportable, because
	 * `assertReferencesPresent` refuses it by name — and returning early on "the Layer is already
	 * there" would leave the user's only obvious remedy, adding the map again, doing nothing at all.
	 * It is also where an offered community Alignment lands when the map is already in the stack.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHAT MAY BE HELD ACROSS THE AWAITS, AND WHAT MAY NOT
	 *
	 * **Nothing is read out of `openProject` before an `await` and used after it.** Reading the
	 * image's label is a store read, and a version that took its snapshot of the document first and
	 * wrote that snapshot back discarded whatever else changed inside the window — the Project name
	 * field is on the same page, so renaming a Project while a map was being added reverted the name,
	 * on screen and on disk.
	 *
	 * `directory` is the one value that *is* captured first, because the early bail needs it and
	 * because it is not part of the document — it is which folder the document belongs to. Held
	 * carelessly it would be worse than a stale snapshot rather than better: if the user opened
	 * another Project inside the window, `#write(directory)` would put **that** Project's document
	 * into **this** Project's folder. So it is compared against `openDirectory` again after the
	 * awaits, and a mismatch abandons the write. The rule with the exception spelled out: nothing
	 * captured before an await is written after one without first being confirmed still current.
	 *
	 * @returns the Layer — the new one, or the one that was already there — and what became of the
	 *   Alignment; or `null` when nothing could be written.
	 */
	async #addMapLayer(fields: {
		imageId: string;
		image: { width: number; height: number };
		/** What to call it, when the caller knows better than `manifest.json` does. */
		name?: string;
		/** Where the image is served from. See {@link #writeInitialAlignment}. */
		address?: AlignmentAddress;
		/** A community Alignment the user chose to import. See {@link #writeInitialAlignment}. */
		alignment?: Alignment | null;
	}): Promise<MapLayerAdded | null> {
		const { imageId } = fields;
		const directory = this.openDirectory;
		// {@link mapLayerFor}, which reads the *live* `openProject` — which is exactly what each of the
		// three questions below wants, and the reason they are three questions rather than one snapshot
		// consulted three times.
		const drawnAlready = (): MapLayer | undefined => this.mapLayerFor(imageId);

		const before = this.openProject;
		if (!directory || !before) return null;

		let alignment: InitialAlignment;
		try {
			// **Before `project.json`**, and the same discipline `addAnnotationLayer` and ticket 13's
			// importer keep: a Layer whose reference names a file that is not there is a Project this
			// build's own import refuses. Written this way, the worst a failure leaves is an Alignment
			// nothing draws — bytes, not breakage.
			alignment = await this.#writeInitialAlignment(imageId, fields.image, {
				...(fields.address ? { address: fields.address } : {}),
				offered: fields.alignment
			});
			this.saveError = '';
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
			return null;
		}

		// Asked again rather than from `before`: the Alignment write awaited, and the map may have been
		// added by another gesture in that window.
		const drawn = this.openProject;
		if (!drawn) return null;
		const already = drawnAlready();
		if (already) return { layer: already, alignment };

		const name = fields.name || (await this.#imageLabel(imageId)) || imageId;
		// Taken again after that await too, never from a snapshot above — and `directory` with it, so
		// this Project's document cannot be written into a Project the user opened in the meantime.
		const project = this.openProject;
		if (!project || this.openDirectory !== directory) return null;
		// Asked a third time as well: two adds of the same map in flight together must produce one
		// Layer, not two rows over one pyramid.
		const raced = drawnAlready();
		if (raced) return { layer: raced, alignment };

		const layer = newMapLayer({ id: crypto.randomUUID(), name, imageId });
		this.openProject = { ...project, layers: addLayer(project.layers, layer) };
		await this.#write(directory);
		return this.saveError === '' ? { layer, alignment } : null;
	}

	/**
	 * Add a Historical Map that stays on somebody else's server (SPEC stories 16–20, 25, 29).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE ORDER OF THE THREE WRITES, WHICH IS NOT ARBITRARY
	 *
	 *   1. `images/<id>/remote.json` — where the tiles are, and the provenance.
	 *   2. `alignments/<id>.json` — the community Alignment the user chose, or the starter one every
	 *      Historical Map gets (ADR-0023), written by {@link #addMapLayer}.
	 *   3. `project.json`, gaining the Layer that references both.
	 *
	 * `project.json` is **last**, and it is the same discipline `addAnnotationLayer` follows and the
	 * same one ticket 13's importer follows: a Layer whose references name files that do not exist is
	 * a Project that `assertReferencesPresent` refuses. Written the other way round, a failure between
	 * the writes would leave a Layer in the stack that nothing can draw and that no later action would
	 * repair. Written this way, a failure leaves an orphaned `remote.json` — a file nothing reads,
	 * which the next add overwrites.
	 *
	 * **Step 2 used to happen only for a community Alignment, and that was the trap.** A referenced map
	 * added without one produced a Layer whose `alignments/<id>.json` did not exist, so this build
	 * exported a zip it then refused to import (ADR-0023's consequence on the starter Alignment).
	 *
	 * **And step 2 is not this method's to do**, which is the other half of the same lesson. The
	 * community Alignment used to be committed here, unconditionally, before `#addMapLayer` ran — one
	 * serialisation here and a second inside, two writers of one file that could disagree, and the one
	 * here with no idea whether it was writing over somebody's work. Both are now
	 * {@link #writeInitialAlignment}, which reaches `writeAlignmentFile` — the only thing that decides
	 * what `alignments/<id>.json` ends up holding and the only place the offer-versus-existing
	 * question is answered. See its comment for why the offer does not simply win.
	 *
	 * **Nothing records that the map is referenced, because nothing has to** (ADR-0023). `remote.json`
	 * without an `info.json` beside it *is* the record, so there is no claim in `project.json` that could
	 * disagree with the folder — and the whole "finish the interrupted copy" repair path went with it.
	 *
	 * The Alignment, either one, is serialised with the **remote service** as its `resource.id`, not
	 * the ADR-0004 placeholder. For a referenced image that is both what makes the file resolvable by
	 * Allmaps (ADR-0007, SPEC story 91) and what makes the warped Layer render at all —
	 * `@allmaps/maplibre` fetches tiles from that `id`.
	 *
	 * @returns the Layer — the new one, or the one this Project already had for this map — with what
	 *   became of the Alignment beside it; or `null` when nothing could be written
	 */
	async addReferencedMap(fields: {
		service: RemoteImageService;
		label: string;
		partOf: string;
		canvas: string;
		rights: string;
		attribution: string;
		/** A community Alignment to import, or `null` to start from scratch (ADR-0015). */
		alignment: Alignment | null;
	}): Promise<ReferencedMapAdded | null> {
		if (!this.openDirectory || !this.openProject) return null;

		const { service } = fields;
		const record = referencedImage({
			imageId: service.imageId,
			service: service.uri,
			label: fields.label,
			partOf: fields.partOf,
			canvas: fields.canvas,
			rights: fields.rights,
			attribution: fields.attribution,
			width: service.width,
			height: service.height
		});
		try {
			await this.#autosave.commit(
				referencedImagePath(record.imageId),
				serialiseReferencedImage(record)
			);
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
			return null;
		}

		// Adding the same remote resource twice is one Layer, not two, and `#addMapLayer` is where that
		// is decided. `generateId(uri)` is deterministic, so the second add lands on the same image id —
		// which is a feature (a whole class adding the same map produces one Layer each, and a
		// colleague's Project agrees) and would otherwise be a duplicate Layer over the same tiles.
		const added = await this.#addMapLayer({
			imageId: record.imageId,
			image: { width: service.width, height: service.height },
			alignment: fields.alignment,
			name: record.label || record.imageId,
			// The Library's service rather than the ADR-0004 placeholder, which for a referenced image is
			// both what makes the file resolvable by Allmaps (SPEC story 91) and what makes the warped
			// Layer render at all — `@allmaps/maplibre` fetches its tiles from that `id`.
			address: referencedAlignmentAddress(record.service)
		});
		if (!added) return null;
		// The record is refreshed even when the Layer was already there: the add re-read the resource's
		// description from the library, and the newer one is the one to keep.
		this.referencedImages = [
			...this.referencedImages.filter((image) => image.imageId !== record.imageId),
			record
		];
		return { layer: added.layer, keptExistingAlignment: added.alignment === 'kept over the offer' };
	}

	/**
	 * The Historical Maps **the Workspace** still fetches from a library, and the ones it has copied.
	 *
	 * Split on **whether the pyramid is there**, which is now the only thing there is to split on
	 * (ADR-0023): the stored `imageMode` is gone, so this is not merely the more reliable of two answers
	 * but the whole answer. A copy whose pyramid landed and whose `project.json` write did not used to be
	 * a lasting disagreement with a repair button behind it; there is nothing left to disagree, so the
	 * repair path is deleted rather than kept as dead code that lies.
	 */
	get remoteOrigins(): { referenced: ReferencedImage[]; offlineCopies: ReferencedImage[] } {
		return partitionByOfflineCopy(this.referencedImages, this.images);
	}

	/**
	 * The Workspace Historical Maps whose tiles are on somebody else's server, by image id.
	 *
	 * **Here rather than derived again in the Layers pane**, which is where it used to be: it is the
	 * same question `partitionByOfflineCopy` above has just answered, and a `$derived` set in a page is
	 * how one rule acquires a second reading. Every pane that needs it takes this one.
	 */
	get referencedImageIds(): ReadonlySet<string> {
		// A `SvelteSet` rather than a plain one because this file is reactive and the lint rule that says
		// so is right in general: a plain `Set` held anywhere here would not notify. Rebuilt on every
		// read from `$state` this getter depends on, so nothing is held.
		return new SvelteSet(this.remoteOrigins.referenced.map((image) => image.imageId));
	}

	/**
	 * Walk the Workspace's Historical Maps for the hub's reclaim list (SPEC story 63).
	 *
	 * Called by the hub when it appears, again whenever the **Project list** changes — a Project
	 * deleted here can be the last one that drew a map, and a stale list would say "no Project uses
	 * this map" about one still in use, or the reverse — and again after a deletion. Nothing else calls
	 * it: it weighs every file under `images/`, so it is a walk tied to a change in what it reports and
	 * never to a keystroke or a re-render.
	 */
	async refreshHistoricalMaps(): Promise<void> {
		this.historicalMapsLoading = true;
		try {
			this.historicalMaps = await listWorkspaceHistoricalMaps(this.#store);
		} catch (cause) {
			// The same call `refresh` makes about the Project list: a Workspace that cannot be walked is
			// the unreachable state, not an exception the hub has to survive.
			this.historicalMaps = [];
			this.status = 'unreachable';
			this.unreachableDetail = cause instanceof Error ? cause.message : String(cause);
		} finally {
			this.historicalMapsLoading = false;
		}
	}

	/**
	 * Delete one Historical Map from the Workspace — its pyramid, its `remote.json`, and its Alignment
	 * (SPEC story 65).
	 *
	 * **Refused, not cascaded, when a Project draws it** (SPEC story 64). The refusal names the Projects
	 * and is rendered beside the list; core decides it, so the sentence a user reads is written once.
	 *
	 * The open Project's own two lists are refreshed as well, because a map can be deleted from the hub
	 * while a Project is open in another route and a stale `images` there is a pane drawing from a
	 * pyramid that is gone.
	 *
	 * @returns whether the map was deleted
	 */
	async deleteHistoricalMap(imageId: string): Promise<boolean> {
		this.historicalMapError = '';
		const label = this.historicalMaps.find((map) => map.imageId === imageId)?.label ?? '';
		// The same reason `deleteProject` does it (ticket 20): the pyramid and the Alignment are both
		// removed straight from the store, so anything journalled for them would be put back at the
		// next startup — an Alignment file for a Historical Map that is no longer in the Workspace.
		this.#journal?.forgetUnder(`${imageDirectory(imageId)}/`);
		this.#journal?.forget(alignmentPath(imageId));
		try {
			await deleteHistoricalMap(this.#store, imageId, { label });
		} catch (cause) {
			// Two of these are sentences core has already written for the user, and they are used as
			// written. "Could not be deleted" is the fallback and is only true when nothing was: a
			// half-finished deletion says so itself, because telling a user nothing happened when the
			// Alignment and half the tiles are gone is the one message here that could cost them work.
			this.historicalMapError =
				cause instanceof HistoricalMapInUseError || cause instanceof HistoricalMapPartlyDeletedError
					? cause.message
					: `“${label || imageId}” could not be deleted: ${
							cause instanceof Error ? cause.message : String(cause)
						}`;
			// The listing is walked again either way: a partly deleted map is still listed, and what it
			// now weighs is not what the row on screen says.
			await this.refreshHistoricalMaps();
			return false;
		}
		this.images = this.images.filter((image) => image.imageId !== imageId);
		this.referencedImages = this.referencedImages.filter((image) => image.imageId !== imageId);
		await this.refreshHistoricalMaps();
		return true;
	}

	/**
	 * How many bytes the whole Workspace holds, for the ADR-0008 hosting warning (ticket 15, 16).
	 *
	 * Through `workspaceSize`, which uses `ProjectStore#size` and never `read`: a Workspace with a
	 * offline copy's pyramid in it is tens of thousands of files, and opening every one of them to add up
	 * their lengths would make this the slowest thing in the application. The whole Workspace rather
	 * than the open Project, because the ~1 GB budget is shared by every Project published together.
	 */
	async workspaceBytes(): Promise<WorkspaceSize> {
		return workspaceSize(this.#store);
	}

	// ── The Base Map's offline tile cache (ADR-0025) ─────────────────────────────────────────────
	//
	// Workspace-level, so these take no Project directory: two Projects in the same city share tiles,
	// which is what makes "is this Project available offline?" a question about which files exist.
	// Every one of these is a thin pass-through to core, for the same reason the rest of this class is
	// — the store is held here and nowhere else.

	/**
	 * How much of what `bounds` needs is already cached for one archive, and what filling it takes.
	 *
	 * `archive` is the catalog entry's own `archive` string, which is what the cache directory is keyed
	 * on (ticket 12). Asked per archive because a Workspace may hold a cache for each of several, and
	 * one archive's tiles do not make a Project drawn on another available offline.
	 */
	async offlineBaseMapCoverage(
		archive: string,
		bounds: GeoBounds,
		maxZoom: number
	): Promise<OfflineCoverage> {
		return offlineCoverage(this.#store, archive, bounds, maxZoom);
	}

	/** Fetch the tiles a coverage says are missing into the Workspace. */
	async fetchBaseMapTiles(options: Omit<FetchTilesOptions, 'store'>): Promise<TileFetchResult> {
		return fetchTilesIntoCache({ ...options, store: this.#store });
	}

	/**
	 * What **every** Base Map cache in this Workspace is taking up, for the hub's reclaim list.
	 *
	 * `list` + `size`, never `read`. Summed across archives because the sentence it feeds is about the
	 * Workspace's disk and the button beside it clears the lot.
	 */
	async baseMapCacheSize(): Promise<BaseMapCacheSize> {
		return readBaseMapCacheSize(this.#store);
	}

	/** What one archive's cache holds, which is the depth its own MapLibre source is capped at. */
	async baseMapCacheSizeFor(archive: string): Promise<BaseMapCacheSize> {
		return readBaseMapCacheSizeFor(this.#store, archive);
	}

	/** What one archive's cache records about its own depth, or `null` if it records nothing. */
	async cachedBaseMapTileSource(archive: string): Promise<CachedTileSource | null> {
		return readCachedTileSource(this.#store, archive);
	}

	/** Record where the cache came from. Called after a run, never before one. */
	async recordBaseMapTileSource(source: CachedTileSource): Promise<void> {
		await writeCachedTileSource(this.#store, source);
	}

	/** Delete every cached tile, and report how many went. */
	async clearBaseMapCache(): Promise<number> {
		return emptyBaseMapCache(this.#store);
	}

	/**
	 * Serve one cached tile to MapLibre, or `null` when the cache has none there (ADR-0011).
	 *
	 * The Base Map's counterpart to {@link imageServiceFetch}: the store is reached from the page
	 * through a function, never by a service worker holding a directory handle. Bound rather than
	 * returned as a method reference so a protocol registration keeps working across a re-render.
	 *
	 * ⚠ **The same function every time**, which the doc above used to claim and the code did not do.
	 * A fresh closure per call makes `{ maxZoom, readTile }` a new value on every recompute, and the
	 * `$effect` that registers it tears the protocol down and puts it back on every document change —
	 * MapLibre keeps a `maxzoom`-bearing source pointed at a handler that is briefly `null`. The store
	 * is fixed for the life of a session, so there is nothing for a second closure to capture.
	 */
	readCachedBaseMapTile(archive: string): (tile: TileCoordinate) => Promise<Uint8Array | null> {
		if (this.#readCachedBaseMapTile?.archive !== archive) {
			this.#readCachedBaseMapTile = {
				archive,
				read: this.#makeCachedBaseMapTileReader(archive)
			};
		}
		return this.#readCachedBaseMapTile.read;
	}

	/**
	 * The reader for the archive last asked about, kept — see the warning above.
	 *
	 * One slot rather than a cache per archive, and keyed since ticket 12 keyed the cache directory: a
	 * pane draws one Base Map at a time, so the reader only has to be stable *while* an entry is
	 * selected. Picking another entry deliberately produces a new function, which is exactly what the
	 * registering `$effect` should see — the tiles being served really have changed, and a reader that
	 * stayed identical while closing over the previous archive's key is the wrong-map failure arriving
	 * through the cache instead of through the directory.
	 *
	 * A plain field and not `$state`: it is written from inside a `$derived`, and nothing may re-run
	 * because a memo was filled in.
	 */
	#readCachedBaseMapTile: {
		archive: string;
		read: (tile: TileCoordinate) => Promise<Uint8Array | null>;
	} | null = null;

	#makeCachedBaseMapTileReader(
		archive: string
	): (tile: TileCoordinate) => Promise<Uint8Array | null> {
		const store = this.#store;
		return async (tile) => {
			try {
				return await store.read(cachedTilePath(archive, tile));
			} catch {
				// A tile the cache does not hold. Answered as absence rather than as an error, because a
				// stray request outside a partly filled cache is ordinary — and the Project-level claim
				// about being available offline is computed from `offlineCoverage`, never from whether
				// anything here complained.
				return null;
			}
		};
	}

	/**
	 * What publishing would write into this Workspace, and everything the user must read first
	 * (ticket 16; ADR-0006, ADR-0008).
	 *
	 * **Writes nothing.** Two of the three required warnings are questions rather than reports — the
	 * Base Map's size has to be stated *before* it is added (ADR-0020) and the ~1 GB hosting cliff is
	 * a decision (ADR-0008) — so the plan is a separate step the dialog shows before its button does
	 * anything.
	 */
	async planPublish(options: {
		bundle: ViewerBundle;
		includeBaseMap: boolean;
	}): Promise<PublishPlan> {
		return planPublish(this.#store, {
			bundle: options.bundle,
			projects: await this.#workspace.listProjects(),
			includeBaseMap: options.includeBaseMap
		});
	}

	/**
	 * Write the Published Site (SPEC stories 78–81).
	 *
	 * Everything pending is flushed first, for the same reason exporting a zip flushes: publishing a
	 * Project whose last edit is still inside the autosave debounce would put a site on the web that
	 * is missing the change the user just made — and unlike an export, they may not look at it again
	 * for a week (ADR-0017 rule 1).
	 *
	 * `readAsset` comes from the app rather than from here, because where this deployment serves the
	 * viewer's files from is `$lib/publish/viewer-bundle-source`'s business and must stay relative
	 * (ADR-0006).
	 */
	async publish(options: {
		plan: PublishPlan;
		readAsset: (file: ViewerBundleFile) => Promise<Bytes>;
		onProgress?: (progress: { files: number; totalFiles: number; path: string | null }) => void;
	}): Promise<PublishedSite> {
		await this.flush();
		const site = await publishSite({
			store: this.#store,
			plan: options.plan,
			readAsset: options.readAsset,
			...(options.onProgress ? { onProgress: options.onProgress } : {})
		});
		// The Project list on screen is what the site now claims, so a stale list would make the
		// staleness notice wrong in the direction that matters.
		this.projects = await this.#workspace.listProjects();
		return site;
	}

	/** The record the Published Site carries about itself, or `null` if there is no site yet. */
	async readPublishedSite(): Promise<PublishedSite | null> {
		return readPublishedSite(this.#store);
	}

	/**
	 * Stamp every Historical Map in the Workspace with a canonical address (SPEC story 92).
	 *
	 * Opt-in, and the **only** thing publishing does that writes the user's own files: it rewrites
	 * each `info.json`'s `id` from the ADR-0004 placeholder to `<url>/images/<image-id>`, so that the
	 * tiles become a real, citable IIIF endpoint Allmaps, Theseus, and OpenSeadragon can consume
	 * directly.
	 *
	 * **The images are stamped once for the whole Workspace, and then every Project records the
	 * address** (ADR-0023). The pyramids are shared, so there is one address per Historical Map — the
	 * per-Project version wrote `<url>/<project>/images/<id>`, a citation that broke the moment a second
	 * Project used the map. `images` therefore counts Historical Maps and not Project-image pairs.
	 *
	 * `info.json` first and `project.json` second, the same order every other write here follows: a
	 * document's record of the address must never claim a stamp the images do not carry. A failure part
	 * way through leaves some images stamped and some Projects unstamped, which the next publish repairs
	 * by stamping all of them again — idempotent, because the address does not depend on what was there
	 * before.
	 *
	 * A Project this build cannot open is skipped rather than rewritten (ADR-0010).
	 */
	async stampCanonicalUrl(url: string): Promise<{ projects: number; images: number }> {
		const stamped = normaliseCanonicalUrl(url);
		if (stamped === '') {
			// Through core's own refusal, so the sentence a user reads is written in one place.
			await stampWorkspaceImages(this.#store, url, []);
		}
		await this.flush();

		const ingested = await listIngestedImages(this.#store);
		const stamp = await stampWorkspaceImages(
			this.#store,
			stamped,
			ingested.map((image) => image.imageId)
		);

		let projects = 0;
		for (const summary of await this.#workspace.listProjects()) {
			if (summary.problem !== null) continue;
			const file = await this.#workspace.readProject(summary.directory);
			if (file.canonicalUrl !== stamp.url) {
				await this.#workspace.writeProject(summary.directory, { ...file, canonicalUrl: stamp.url });
			}
			projects += 1;
			if (this.openDirectory === summary.directory && this.openProject) {
				this.openProject = { ...this.openProject, canonicalUrl: stamp.url };
			}
		}
		this.projects = await this.#workspace.listProjects();
		return { projects, images: stamp.images.length };
	}

	/**
	 * Copy a referenced Historical Map into the Workspace as local tiles (SPEC stories 27, 28).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * TWO WRITES NOW, WHERE THERE WERE THREE
	 *
	 *   1. the pyramid, through `makeOfflineCopy` → `ingestImageFile`, whose `info.json` lands last
	 *      and is therefore the completion marker for the whole directory;
	 *   2. `alignments/<id>.json`, rewritten to name the ADR-0004 placeholder instead of the library.
	 *
	 * **`project.json` is not touched at all, and that is ADR-0023 rather than an omission.** The third
	 * write existed to flip a Layer's `imageMode` from `'referenced'` to a local copy. There is no such
	 * field: `remote.json` beside an `info.json` of ours *is* the record that the tiles are here, so
	 * making the copy is the whole of recording it, and every Project that draws this map sees it at
	 * once rather than only the one that happened to be open.
	 *
	 * That also removes the half-committed state the repair path existed for. The pyramid landing and a
	 * document write failing afterwards used to leave a Layer claiming the library while the tiles sat
	 * unused — permanent, self-contradicting, and greeted on next open by a "Finish the offline copy"
	 * button. With one derived answer there is nothing left to finish.
	 *
	 * **Step 2 is not optional.** The stored Alignment of a referenced image names the remote service as
	 * its `resource.id`, which is what made it resolvable by Allmaps and what made the warped Layer
	 * render at all. Left alone after a copy it would keep sending `@allmaps/maplibre` to the library for
	 * tiles that are now in this folder — so the copy would work, the map would draw, and making an offline copy would
	 * have bought nothing. It is also what publishing serves, and a self-contained site whose Alignment
	 * points at a stranger's server is not self-contained.
	 *
	 * A failure before step 1 finishes leaves the map still fetched from the library, which is the state
	 * it was in.
	 *
	 * @returns `true` when the copy landed and the Alignment names this Workspace's own tiles
	 */
	async makeOfflineCopy(options: {
		image: ReferencedImage;
		service: RemoteImageService;
		/** The plan the user was shown, so what was agreed to is what runs. */
		plan: OfflineCopyPlan;
		onProgress?: (progress: OfflineCopyProgress) => void;
		signal?: AbortSignal;
	}): Promise<boolean> {
		const { image, service, plan } = options;

		await makeOfflineCopy({
			store: this.#store,
			service,
			plan,
			label: image.label || image.imageId,
			fetch: this.imageServiceFetch(),
			assemble: assembleWithCanvas,
			openDecodeAndCrop: openDecodeAndCropSource,
			...(options.onProgress ? { onProgress: options.onProgress } : {}),
			...(options.signal ? { signal: options.signal } : {})
		});

		// No check that the session is still on the Project it started from. The pyramid and the Alignment
		// both belong to the Workspace, so neither write depends on which Project is open — which is what
		// used to make "the user navigated away mid-copy" one of the three routes into a half-committed
		// copy.
		return this.#recordLocalCopy(image.imageId);
	}

	/**
	 * Rewrite a copied map's Alignment to name this Workspace's own tiles rather than the library.
	 *
	 * The second of {@link makeOfflineCopy}'s two writes, kept as its own method because it is the only part
	 * of a copy that touches a document the user made.
	 *
	 * Idempotent: re-serialising an Alignment that already names the ADR-0004 placeholder produces the
	 * same bytes, so a copy repeated over a map already copied changes nothing.
	 *
	 * **An `update`, and it has to be** (ticket 18). It is not a `create` — there is certainly an
	 * Alignment there and the whole point is to change it — and it is not a `replace`, because nothing
	 * of the user's is discarded: every Control Point, the Resource Mask and the transformation type
	 * are read out of the existing file and written straight back, and since ticket 18 so is every
	 * member of the document this build does not model. The one thing that changes is the address,
	 * which is not the user's work but a statement of where the tiles now are — and the user asked for
	 * exactly that by asking for the copy.
	 *
	 * @returns `true` when the Alignment names the placeholder and the pyramid is on disk
	 */
	async #recordLocalCopy(imageId: string): Promise<boolean> {
		const path = alignmentPath(imageId);
		try {
			// Round-tripped through the parser rather than string-edited: `alignment-file.ts` is the one
			// writer of that document, and omitting the address is what puts the placeholder back.
			await writeAlignmentFile(this.#alignmentFile, {
				alignment: parseAlignment(await this.#store.read(path), { imageId }),
				write: { intent: 'update' }
			});
			this.saveError = '';
		} catch (cause) {
			// No Alignment yet is the ordinary case for a map nobody has placed. Anything else is not:
			// leaving an Alignment that points at the library would undo the whole copy, so it is reported
			// and the copy is not claimed to have landed.
			if (!(cause instanceof PathNotFoundError)) {
				this.saveError = cause instanceof Error ? cause.message : String(cause);
				return false;
			}
		}

		this.images = await listIngestedImages(this.#store);
		return this.images.some((image) => image.imageId === imageId);
	}

	/**
	 * Ask `annotations.allmaps.org` whether anyone has already aligned this image.
	 *
	 * The seam is here because this is the only place the app talks to `@ballastella/core` and to the
	 * `@allmaps/*` packages, and because it is the *only* call site — `findCommunityAlignments`
	 * returns before reaching it when the setting is off, so "off means no request" is structural
	 * rather than a flag threaded through a third party's code.
	 *
	 * `fetchAnnotationsFromApi` reaches the network through the page's own `fetch` and offers no
	 * injection point, which is why it cannot be routed through the ADR-0011 shim and why the request
	 * is counted by `recordRemoteRequest` at the caller instead.
	 */
	async fetchCommunityAnnotations(image: Parameters<typeof fetchAnnotationsFromApi>[0]) {
		return fetchAnnotationsFromApi(image);
	}

	/** What the user calls one Historical Map, or `''` when its manifest cannot be read. */
	async #imageLabel(imageId: string): Promise<string> {
		try {
			const bytes = await this.#store.read(imageManifestPath(imageId));
			return readImageLabel(JSON.parse(new TextDecoder().decode(bytes)));
		} catch {
			// Swallowed, because a name is not worth failing an add over. The caller falls back to the
			// image id — a poor name the user can change (SPEC story 54) — where throwing would leave a
			// Historical Map prepared, an Alignment written, and no Layer drawing either of them.
			return '';
		}
	}

	/**
	 * Add an empty Annotation Layer to the stack (SPEC stories 55 and 56).
	 *
	 * Its `FeatureCollection` is written **before** the Layer that references it, and with the same
	 * discipline as `orderForWriting` in the zip importer: a Layer whose `geojsonRef` names nothing is
	 * a Project that ticket 13's import refuses, so the reference must never exist without its file.
	 * Drawing into it is ticket 10.
	 *
	 * **And `project.json` is read after that write rather than before it**, for the same reason as
	 * {@link #addMapLayer}: a snapshot taken before an `await` and written back after it discards
	 * whatever else changed in between. Here the "whatever else" is the other click — a user
	 * double-clicking the button got one Layer instead of two, plus an orphaned `.geojson` in
	 * `annotations/` that nothing references and no part of the interface can reach.
	 *
	 * @returns the Layer, or `null` when it could not be created
	 */
	async addAnnotationLayer(name: string): Promise<AnnotationLayer | null> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return null;
		const layer = newAnnotationLayer({ id: crypto.randomUUID(), name });
		try {
			await this.#autosave.commit(
				annotationStorePath(directory, layer.id),
				emptyAnnotationCollection()
			);
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
			return null;
		}
		const project = this.openProject;
		if (!project) return null;
		this.openProject = { ...project, layers: addLayer(project.layers, layer) };
		await this.#write(directory);
		return layer;
	}

	/**
	 * Rename a Layer (SPEC story 54). Coalesced per file, so a name typed one character at a time is
	 * one write and not twelve (ADR-0017 rule 2).
	 *
	 * **Only `project.json` changes.** The name is display state and has no business in the Alignment
	 * or the GeoJSON, which are portability documents that stand on their own (ADR-0002).
	 */
	async typeLayerName(id: string, name: string): Promise<void> {
		await this.#changeLayers((layers) => renameLayer(layers, id, name), { debounce: true });
	}

	/** SPEC story 50. A discrete act, so it is written now rather than debounced. */
	async showLayer(id: string, visible: boolean): Promise<void> {
		await this.#changeLayers((layers) => setLayerVisible(layers, id, visible));
	}

	/**
	 * SPEC story 51. Debounced, because dragging a range input is a continuous gesture and
	 * {@link commitLayerEdit} is what commits it on release (ADR-0017 rule 1).
	 */
	async dragLayerOpacity(id: string, opacity: number): Promise<void> {
		await this.#changeLayers((layers) => setMapLayerOpacity(layers, id, opacity), {
			debounce: true
		});
	}

	/** Move a Layer to a position in the stack, 0 being the top (SPEC stories 52 and 53). */
	async moveLayerTo(id: string, toIndex: number): Promise<void> {
		await this.#changeLayers((layers) => moveLayer(layers, id, toIndex));
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// SINGLE-LEVEL UNDO (ADR-0014, SPEC story 38)
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Record a destructive action and how to reverse it.
	 *
	 * Called by whoever owns the state that changed — the pairing drafts for a Control Point, the
	 * Layers pane for an Annotation, this class for a Layer — because those are three different
	 * places and a session that reached into all of them would be the command-object architecture
	 * ADR-0014 defers. What is central is the *slot*: one record, replaced by the next destructive
	 * action, and no non-destructive path calls this at all.
	 */
	record(record: UndoRecord, apply: () => Promise<void>): void {
		this.#undo.offer(record, apply);
	}

	/**
	 * Reverse the last destructive action (SPEC story 38).
	 *
	 * **A mutation like any other**, so it coalesces and flushes through the same {@link Autosave} as
	 * the action it reverses — there is no bespoke save path here and nothing that reads "the last
	 * saved state", which is what makes undo work after autosave has already written the deletion to
	 * disk (ADR-0017's consequence). The slot is emptied before the work starts, so a second press has
	 * nothing to find and a slow undo cannot run twice.
	 */
	async undo(): Promise<void> {
		await this.#undo.take()?.();
	}

	/**
	 * Forget an undo that belongs to a Historical Map the user is no longer aligning.
	 *
	 * A Control Point record names its image, and an affordance offering to put back a point that is
	 * not on screen — in a pane showing a different map — is worse than no affordance: it describes an
	 * edit the user cannot see happen. Everything else in the slot is about the Project rather than
	 * about one image, so it survives.
	 */
	forgetUndoOfOtherImages(imageId: string): void {
		this.#undo.clearIf((record) => isControlPointUndo(record) && record.imageId !== imageId);
	}

	/**
	 * Delete a Layer, and the file it draws, so that undo can put both back (SPEC stories 38, 49).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE ORDER, WHICH IS THE CREATION ORDER IN REVERSE
	 *
	 *   1. flush, so the bytes about to be recorded are the ones the user can see, and so no debounced
	 *      write can land after the file has gone and put it back unrecorded;
	 *   2. read the referenced file, which is the only copy the undo record will have;
	 *   3. `project.json`, losing the Layer;
	 *   4. the referenced file.
	 *
	 * **`project.json` before the file, because every other path here writes the file first.** A Layer
	 * whose reference names nothing is a Project ticket 13's import refuses by name; written the other
	 * way round, a failure between the two steps would leave exactly that. This way the worst
	 * intermediate state is a file nothing references — bytes, not breakage.
	 *
	 * **Steps 2 and 4 do nothing for a map Layer, and that is ADR-0023** (SPEC story 67). Its Historical
	 * Map and its Alignment belong to the Workspace and may be drawn by other Projects, so removing the
	 * Layer must leave both where they are — `layerFileRef` answers `''` for a map Layer, which is where
	 * that decision lives. Only an Annotation Layer has a file of this Project's to take with it.
	 *
	 * **Nothing records the deletion, because nothing has to** (ADR-0023). A map Layer used to be
	 * created by an Alignment write, so deleting one and then nudging a Control Point put a *new* Layer
	 * at the top of the stack with a fresh id, and undo could not help — from the app's point of view
	 * nothing had been undone. `ProjectFile` carried a list of the deleted maps' image ids for exactly
	 * that. A Layer is now made only by {@link #addMapLayer}, on the user's explicit "add this map"
	 * gesture, so there is nothing left that could resurrect one and no tombstone to keep.
	 *
	 * @returns whether the Layer went
	 */
	async deleteLayer(id: string): Promise<boolean> {
		const directory = this.openDirectory;
		const opened = this.openProject;
		if (!directory || !opened) return false;
		const at = opened.layers.findIndex((layer) => layer.id === id);
		const layer = opened.layers[at];
		if (!layer) return false;

		// Everything pending, before anything is read: an Annotation typed into a moment ago is still
		// inside its debounce window, and recording the bytes without it would make undo restore the
		// file as it was one keystroke ago.
		await this.flush();
		const ref = layerFileRef(layer);
		const path = ref === '' ? '' : `${directory}/${ref}`;
		let bytes: Bytes | null = null;
		if (path !== '') {
			try {
				bytes = await this.#store.read(path);
			} catch (cause) {
				// No file is the ordinary case for a Layer nothing has been put in yet. Anything else is
				// not: deleting a file we could not read would be deleting work we cannot give back.
				if (!(cause instanceof PathNotFoundError)) {
					this.saveError = cause instanceof Error ? cause.message : String(cause);
					return false;
				}
			}
		}

		// Taken again after the await, never from the snapshot above: `#addMapLayer` and
		// `addAnnotationLayer` both had to learn this, and the document is the one whose loss is "not one
		// annotation but the map of everything" (ADR-0017 rule 4).
		const project = this.openProject;
		if (!project || !project.layers.some((one) => one.id === id)) return false;
		this.openProject = { ...project, layers: removeLayer(project.layers, id) };
		await this.#write(directory);
		if (this.saveError !== '') {
			// The document did not reach storage, so the Layer has not been deleted. Put the stack back as
			// it was rather than leaving the screen claiming a deletion the file does not carry.
			this.openProject = project;
			return false;
		}

		if (path !== '' && bytes !== null) await this.#store.delete(path);

		const undo: UndoRecord = { kind: 'layer-deleted', at, layer, path: ref, bytes };
		this.record(undo, () => this.#restoreLayer(undo));
		return true;
	}

	/**
	 * Put a deleted Layer and its file back — the undo of {@link deleteLayer}, in reverse order again.
	 *
	 * The file first, so the reference never names a file that is not there, and through
	 * {@link Autosave} like every other write. The bytes come from the record rather than from anything
	 * on disk, which is what makes the restored file byte-identical to the deleted one: a
	 * re-serialisation of a parsed model would be merely equivalent, and ticket 09 asserts these files
	 * survive display-state edits byte-for-byte.
	 *
	 * A map Layer has no file to put back — its Historical Map and its Alignment were never removed
	 * (ADR-0023) — so for one of those this is the stack and nothing else.
	 */
	async #restoreLayer(record: UndoRecord): Promise<void> {
		if (record.kind !== 'layer-deleted') return;
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;

		if (record.path !== '' && record.bytes !== null) {
			try {
				await this.#autosave.commit(`${directory}/${record.path}`, record.bytes);
				this.saveError = '';
			} catch (cause) {
				// Without its file the Layer would be a reference to nothing, so the entry is not restored
				// either: the state to be in is the one the delete left, with the failure said.
				this.saveError = cause instanceof Error ? cause.message : String(cause);
				return;
			}
		}

		const project = this.openProject;
		if (!project) return;
		const layers = insertLayerAt(project.layers, record.layer, record.at);
		// The array it was given means a Layer with this id is already back — `parseLayers` drops a
		// duplicate id, so writing one would produce a document whose next read loses one of the two.
		if (layers === project.layers) return;
		this.openProject = { ...project, layers };
		await this.#write(directory);
	}

	/**
	 * The edit is over — the field lost focus, Enter was pressed, or the slider was released.
	 *
	 * **A no-op when nothing is waiting to be written**, which is the same guard
	 * {@link commitProjectName} carries and for the same reason: `writeProject` stamps a fresh
	 * `updatedAt`, and ADR-0010 is explicit that merely looking at an old Project must not modify
	 * files. Tabbing through a Layer's name field is looking.
	 */
	async commitLayerEdit(): Promise<void> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;
		if (!this.#autosave.hasPendingWrite(projectFilePath(directory))) return;
		await this.#write(directory);
	}

	/**
	 * Apply `change` to the Layer stack and write the document.
	 *
	 * One funnel for every Layer mutation, so that reordering, renaming, and toggling are ordinary
	 * mutations of the one in-memory `project.json` — coalescing and flushing like every other edit
	 * rather than each inventing a save path of its own (ADR-0017). It also means there is exactly one
	 * place where "no such Layer" is a no-op rather than a write of an unchanged document.
	 */
	async #changeLayers(
		change: (layers: readonly Layer[]) => readonly Layer[],
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const directory = this.openDirectory;
		const project = this.openProject;
		if (!directory || !project) return;
		const layers = change(project.layers);
		// Reference equality: every operation in `layer.ts` returns the array it was given when it
		// changed nothing, so a move that hit the end of the stack costs no write at all.
		if (layers === project.layers) return;
		this.openProject = { ...project, layers };
		await this.#write(directory, options);
	}

	/**
	 * One map Layer's Alignment as stored, or `null` when there is no file yet.
	 *
	 * Read from the Workspace by the Layer's `imageId` (ADR-0023) — and without the Historical Map's
	 * pyramid, which the stack does not load: the Alignment carries the image's pixel dimensions itself,
	 * so a Layer can be drawn from the one file it names.
	 *
	 * A Layer whose `imageId` is `''` names no Historical Map — a hand-edited or damaged document — and
	 * answers `null` rather than reading `alignments/.json`.
	 *
	 * A file that is there and unreadable throws, for the same reason {@link readAlignment} surfaces
	 * it: silently drawing nothing would hide an Alignment the user made.
	 */
	async readLayerAlignment(layer: MapLayer): Promise<Alignment | null> {
		const { imageId } = layer;
		if (imageId === '') return null;
		try {
			return parseAlignment(await this.#store.read(alignmentPath(imageId)), { imageId });
		} catch (cause) {
			if (cause instanceof PathNotFoundError) return null;
			throw cause;
		}
	}

	/**
	 * One Annotation Layer's `FeatureCollection` as stored, or `null` when there is no file.
	 *
	 * Parsed as JSON and no further: what the features mean, how they are styled, and how a
	 * description's Markdown is sanitised are ticket 10's, and this slice draws them without
	 * interpreting them.
	 */
	async readLayerFeatures(layer: AnnotationLayer): Promise<unknown> {
		const directory = this.openDirectory;
		if (!directory || layer.geojsonRef === '') return null;
		try {
			const bytes = await this.#store.read(`${directory}/${layer.geojsonRef}`);
			return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		} catch (cause) {
			if (cause instanceof PathNotFoundError) return null;
			throw cause;
		}
	}

	/**
	 * One Annotation Layer's Annotations, as the model (ticket 10).
	 *
	 * Beside {@link readLayerFeatures} rather than replacing it, and the difference is the point: that
	 * one parses as JSON and no further, because the Layer stack draws a `FeatureCollection` without
	 * interpreting it. This one is for *editing*, which needs the Annotations themselves.
	 *
	 * A Layer with no file yet reads as an empty collection rather than as a failure, because that is
	 * the ordinary state of a Layer somebody has only just added — and **nothing is written here**
	 * (ADR-0010).
	 */
	async readAnnotations(layer: AnnotationLayer): Promise<AnnotationCollection> {
		const directory = this.openDirectory;
		if (!directory || layer.geojsonRef === '') return emptyCollection();
		try {
			return parseAnnotations(await this.#store.read(`${directory}/${layer.geojsonRef}`), {
				path: layer.geojsonRef
			});
		} catch (cause) {
			if (cause instanceof PathNotFoundError) return emptyCollection();
			// A file that is there and unreadable must say so, for the same reason `readAlignment`
			// surfaces it: drawing nothing quietly would hide Annotations the user made, and the next
			// save would overwrite them.
			throw cause;
		}
	}

	/**
	 * Write one Annotation Layer's Annotations (SPEC stories 57–66).
	 *
	 * **Through the same {@link Autosave} as everything else**, so ADR-0017's per-file debounce, its
	 * flush-on-hide, and its save state are one mechanism rather than one per file kind. There is no
	 * bespoke save path here, and in particular no `onblur`-rewrites-on-focus-and-leave shape — the
	 * one ticket 02 shipped and had to remove, because ADR-0010 is explicit that merely looking at an
	 * old Project must not modify files.
	 *
	 * `debounce` is for text being typed into the title and description fields (rule 2). A drawn
	 * shape, a moved vertex, a colour chosen, and a deletion are all discrete acts or the end of a
	 * gesture, so they are written now (rule 1) — which is what lets the vertex test assert the
	 * *number* of writes rather than merely that one happened.
	 *
	 * **`project.json` is deliberately not touched.** An Annotation is content; the Layer that
	 * references it already exists, and its name, visibility, and position are display state that has
	 * no business in a portability document (ADR-0002). Stamping `updatedAt` on the document for every
	 * vertex nudge is the same waste {@link writeAlignment} refuses on the Alignment path.
	 */
	async writeAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;
		const path = annotationStorePath(directory, layer.id);
		const bytes = serialiseAnnotations(collection);
		if (options.debounce) {
			// Rule 2's per-file timer. Nothing is recorded for this path: the write happens on the timer
			// rather than here, and the counter exists to assert that a *gesture* costs one write.
			this.#autosave.queue(path, bytes);
			return;
		}
		try {
			await this.#autosave.commit(path, bytes);
			this.saveError = '';
			// After the write resolved, so an attempt the store refused is not counted as one that
			// happened. This is what lets the vertex test assert the number of writes.
			recordAnnotationWrite(path, collection.annotations.length);
		} catch (cause) {
			this.saveError = cause instanceof Error ? cause.message : String(cause);
		}
	}

	/**
	 * Whether an Annotation Layer has bytes waiting inside their debounce window.
	 *
	 * Asked by the commit-on-blur path, so that tabbing through a title field is *looking* rather than
	 * an edit — the same guard {@link commitProjectName} and {@link commitLayerEdit} both carry, and the
	 * reason it exists is ADR-0010: merely opening last year's Project must not modify a byte of it.
	 */
	hasPendingAnnotationWrite(layer: AnnotationLayer): boolean {
		const directory = this.openDirectory;
		if (!directory) return false;
		return this.#autosave.hasPendingWrite(annotationStorePath(directory, layer.id));
	}

	/**
	 * Record an Annotation Layer's default style (ADR-0002, ADR-0009).
	 *
	 * On the **Layer**, in `project.json`, and not on the Annotations — which is what lets a whole
	 * Layer be restyled in bulk and is why nothing stamps defaults onto a feature at creation time.
	 * Debounced, because a colour input is dragged.
	 */
	async setLayerDefaultStyle(
		id: string,
		style: SimpleStyle,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		await this.#changeLayers((layers) => {
			const at = layers.findIndex((layer) => layer.id === id && layer.kind === 'annotation');
			// The array it was given when nothing changed, so `#changeLayers` can skip the write on
			// reference equality — the discipline every operation in `layer.ts` follows, and what keeps a
			// control that reports its current value from rewriting `project.json`.
			if (at === -1) return layers;
			const layer = layers[at] as AnnotationLayer;
			if (JSON.stringify(layer.defaultStyle) === JSON.stringify(style)) return layers;
			const next = [...layers];
			next[at] = { ...layer, defaultStyle: style };
			return next;
		}, options);
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
	 * Put everything pending in the write-ahead journal, synchronously (ticket 20).
	 *
	 * The half of {@link flush} that survives the page going away. Called by `installFlushOnHide` and
	 * by `WorkspaceStorage` before it discards a session, where the flush may reject and leave bytes
	 * with nowhere else to be.
	 */
	capture(): void {
		this.#autosave.capture();
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
			// A refused name that has since been accepted is no longer a problem, and an alert about a
			// Project that now exists is worse than none — it says the action failed while its result is
			// in the list underneath it.
			this.projectProblem = null;
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
	// A name the Workspace itself needs (ADR-0023). Nothing was created and nothing is wrong with the
	// Workspace, so this must not become "Workspace not reachable" — which is what it was before this
	// case existed, and which replaced the hub, and every Project in it, with a data-loss scare over a
	// name the user can simply change. The message names the reservation, which is the acceptance
	// criterion: "reserved" without saying what is reserved leaves nothing to act on.
	if (cause instanceof ReservedDirectoryNameError) {
		return { kind: 'reserved-name', message: cause.message };
	}
	return null;
}

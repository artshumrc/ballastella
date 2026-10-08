import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import {
	Autosave,
	DeletedProjects,
	EditHistory,
	LocalChangeIndex,
	ManagedProjectStore,
	MapImageInUseError,
	SynchronizationMetadata,
	MapImagePartlyDeletedError,
	OpfsProjectStore,
	PathNotFoundError,
	ProjectFileUnreadableError,
	ProjectFormatTooNewError,
	ReservedDirectoryNameError,
	WriteAheadJournal,
	Workspace,
	addLayer,
	alignmentImageId,
	alignmentPath,
	ANNOTATION_DIRECTORY,
	annotationStorePath,
	assembleWithCanvas,
	browserJournalStorage,
	browserMetadataStorage,
	forgetHeldCopy,
	deletionsAreNoteworthy,
	replayIsNoteworthy,
	replayJournal,
	createStoreImageFetch,
	deleteMapImage,
	emptyAnnotationCollection,
	imageDirectory,
	imageInfoPath,
	imageManifestPath,
	imageSizeFromInfo,
	ingestImageFile,
	installFlushOnHide,
	listIngestedImages,
	listReferencedImages,
	listWorkspaceMapImages,
	makeOfflineCopy,
	manageProjectStore,
	moveLayer,
	layerFileRef,
	newAlignment,
	newAnnotationLayer,
	newMapLayer,
	emptyCollection,
	openDecodeAndCropSource,
	parseAlignment,
	parseAnnotations,
	parseProjectFile,
	partitionByOfflineCopy,
	planPublishedSite,
	planRemoteSend as planWorkspaceUpload,
	projectFilePath,
	writePublishedSite,
	sendWorkspaceToRemote as sendWorkspace,
	readImageLabel,
	getFromRemote,
	type AlignmentChoice,
	referencedAlignmentAddress,
	referencedImage,
	referencedImagePath,
	removeLayer,
	renameLayer,
	serialiseAnnotations,
	serialiseReferencedImage,
	setLayerVisible,
	setMapLayerOpacity,
	sourceOf,
	writeAlignmentBytes,
	writeAlignmentFileReporting,
	type Alignment,
	type AlignmentAddress,
	type AlignmentFilePort,
	type AlignmentWriteOutcome,
	type AnnotationCollection,
	type AnnotationLayer,
	type Bytes,
	type StorePath,
	type BaseMapBorderStyle,
	type FetchFn,
	type HistoryFiles,
	type MapImageSource,
	type TileFetchOutcome,
	type IngestProgress,
	type IngestedImage,
	type FinishedDeletions,
	type JournalReplayReport,
	type JournalStorage,
	type MetadataStorage,
	type Layer,
	type MapLayer,
	type OfflineCopyPlan,
	type OfflineCopyProgress,
	type PendingLocalFile,
	type ProjectFile,
	type ProjectStore,
	type ProjectSummary,
	type PublishedSitePlan,
	type PublishedRepository,
	type PublishedSite,
	type ReferencedImage,
	type RemoteImageService,
	type RemoteSendPlan,
	type RemoteRepository,
	type SaveState,
	type SynchronizationBaseline,
	type ViewerBundle,
	type ViewerBundleFile,
	type WorkspaceMapImage,
	type WorkspaceUpdate,
	resolveBaseMap,
	messageOf,
	parseJsonBytes,
	readIfPresent
} from '@ballastella/core';

import { recordAlignmentWrite, recordAnnotationWrite } from './browser-test-handles.js';
import { track } from './analytics.js';
import { opfsWorkspaceKey, workspaceIdentityOf } from './workspace-key.js';

type WorkspaceStatus = 'loading' | 'ready' | 'unreachable';

export function trackLocalChanges(
	store: ProjectStore,
	workspaceKey: string,
	metadataStorage: MetadataStorage | null
): ProjectStore {
	return metadataStorage === null
		? store
		: manageProjectStore(store, new LocalChangeIndex(metadataStorage, workspaceKey));
}

type ProjectProblem = {
	readonly kind: 'format-too-new' | 'unreadable' | 'missing' | 'reserved-name';
	readonly message: string;
};

type MapLayerAdded = {
	readonly layer: MapLayer;
	readonly alignment: AlignmentWriteOutcome;
};

interface HeldStep {
	applied: Promise<void>;
	readonly end: () => void;
	readonly step: Promise<unknown>;
}

type OpacityDrag = HeldStep & { readonly id: string };

type AnnotationDrag = HeldStep & {
	readonly key: string;
	readonly path: StorePath;
	written: { annotations: number; bytes: number } | null;
};

type ReferencedMapAdded = {
	readonly layer: MapLayer;
	readonly keptExistingAlignment: boolean;
};

export interface EditorSessionOptions {
	readonly journalStorage?: JournalStorage | null;
	readonly workspaceKey?: string;
	readonly metadataStorage?: MetadataStorage | null;
}

const HISTORY_BYTE_CEILING = 32 * 1024 * 1024;

export class EditorSession {
	readonly #workspace: Workspace;
	readonly #workspaceKey: string;
	readonly #autosave: Autosave;
	readonly #journal: WriteAheadJournal | undefined;
	readonly #journalStorage: JournalStorage | undefined;
	readonly #deleted: DeletedProjects | undefined;
	readonly #synchronization: SynchronizationMetadata | undefined;
	readonly #store: ProjectStore;
	#openGeneration = 0;
	readonly #histories = new SvelteMap<string, EditHistory>();
	annotationsWrittenBack = $state(0);
	alignmentsWrittenBack = $state(0);
	#opacityDrag: OpacityDrag | null = null;
	#annotationDrag: AnnotationDrag | null = null;

	readonly #historyFiles: HistoryFiles = {
		flush: () => this.flush(),
		read: (path) => readIfPresent(this.#store, path),
		writeBack: async (path, bytes) => {
			const imageId = alignmentImageId(path);
			try {
				if (imageId !== null) {
					await this.#writeAlignmentBack(imageId, bytes);
				} else if (bytes === null) {
					await this.#store.delete(path);
				} else {
					await this.#autosave.commit(path, bytes);
				}
			} catch (cause) {
				this.saveError = messageOf(cause);

				throw cause;
			}

			if (this.openDirectory !== null && path === projectFilePath(this.openDirectory)) {
				this.openProject = bytes === null ? null : parseProjectFile(bytes);
			}

			if (
				this.openDirectory !== null &&
				path.startsWith(`${this.openDirectory}/${ANNOTATION_DIRECTORY}/`)
			) {
				this.annotationsWrittenBack += 1;
			}

			if (imageId !== null) this.alignmentsWrittenBack += 1;
			this.saveError = '';
		}
	};

	status = $state<WorkspaceStatus>('loading');
	unreachableDetail = $state('');
	projects = $state<ProjectSummary[]>([]);
	saveState = $state<SaveState>('saved');
	protectionWarning = $state('');
	replayReport = $state<JournalReplayReport | null>(null);
	deletionReport = $state<FinishedDeletions | null>(null);
	deletionWarning = $state('');
	saveError = $state('');
	openDirectory = $state<string | null>(null);
	openProject = $state<ProjectFile | null>(null);
	projectProblem = $state<ProjectProblem | null>(null);
	images = $state<IngestedImage[]>([]);
	referencedImages = $state<ReferencedImage[]>([]);
	referencedImageErrors = $state<{ imageId: string; reason: string }[]>([]);
	readonly #referenced = $derived(
		partitionByOfflineCopy(this.referencedImages, this.images).referenced
	);
	readonly referencedImageIds: ReadonlySet<string> = $derived(
		new SvelteSet(this.#referenced.map((image) => image.imageId))
	);
	mapImages = $state<WorkspaceMapImage[]>([]);
	mapImagesLoading = $state(false);
	mapImageError = $state('');
	addMapError = $state('');
	ingest = $state<IngestProgress | null>(null);
	ingestLabel = $state('');
	ingestError = $state('');
	#ingestAbort: AbortController | null = null;
	alignmentError = $state('');

	alignmentChangedElsewhere = $state.raw<{
		readonly imageId: string;
		readonly displaced: Bytes;
	} | null>(null);

	readonly #alignmentOnDisk = new SvelteMap<string, Bytes | null>();
	readonly #alignmentWriteInFlight = new SvelteMap<string, Promise<void>>();

	constructor(
		store: ProjectStore,
		{ journalStorage, metadataStorage, workspaceKey = '' }: EditorSessionOptions = {}
	) {
		this.#store = store;
		this.#workspaceKey = workspaceKey;
		if (journalStorage && workspaceKey) {
			this.#journalStorage = journalStorage;
			this.#journal = new WriteAheadJournal(journalStorage, workspaceKey);
			this.#deleted = new DeletedProjects(journalStorage, workspaceKey);
		}
		if (metadataStorage && workspaceKey) {
			this.#synchronization = new SynchronizationMetadata(metadataStorage, workspaceKey);
		}
		this.#autosave = new Autosave(store, {
			journal: this.#journal,
			onJournalRefused: (problem) => {
				this.protectionWarning = problem === null ? '' : messageOf(problem);
			}
		});
		this.#workspace = new Workspace(store, {
			autosave: this.#autosave,
			deleted: this.#deleted,
			identity: workspaceIdentityOf(workspaceKey),
			observer: this.#journal,
			onDeletionNotRecorded: () => {
				this.deletionWarning =
					'This browser would not let Ballastella write the deletion down, so it is only as ' +
					'safe as this tab: if the page closes before it finishes, the Project can come back. ' +
					'Wait for it to disappear from the list before closing this tab. Site data may be ' +
					'blocked for this site, or browser storage may be full.';
			}
		});
		this.#autosave.subscribe((state) => {
			this.saveState = state;
		});
	}

	get synchronization(): SynchronizationMetadata | null {
		return this.#synchronization ?? null;
	}

	get localChanges(): ManagedProjectStore | null {
		return this.#store instanceof ManagedProjectStore ? this.#store : null;
	}

	static forWorkspace(
		store: ProjectStore,
		workspaceKey: string,
		journalStorage: JournalStorage | null,
		metadataStorage: MetadataStorage | null
	): EditorSession {
		return new EditorSession(trackLocalChanges(store, workspaceKey, metadataStorage), {
			journalStorage,
			metadataStorage,
			workspaceKey
		});
	}

	static opfs(name: string): EditorSession {
		return EditorSession.forWorkspace(
			OpfsProjectStore.open(name),
			opfsWorkspaceKey(name),
			browserJournalStorage(),
			browserMetadataStorage()
		);
	}

	async finishInterruptedDeletions(): Promise<void> {
		const report = await this.#workspace.finishInterruptedDeletions().catch(() => null);
		if (report) this.deletionReport = deletionsAreNoteworthy(report) ? report : null;
	}

	forgetDeletion(directory: string): void {
		this.#deleted?.forget(directory);
		const report = this.deletionReport;
		if (report === null) return;
		const remaining = {
			...report,
			refused: report.refused.filter((entry) => entry.directory !== directory)
		};

		this.deletionReport = deletionsAreNoteworthy(remaining) ? remaining : null;
	}

	async replayJournalledEdits(): Promise<void> {
		const journal = this.#journal;
		const storage = this.#journalStorage;
		if (!journal || !storage) return;
		const report = await replayJournal(storage, this.#store, journal.workspace, {
			deleted: this.#deleted,
			journal
		}).catch(() => null);
		if (report) this.replayReport = replayIsNoteworthy(report) ? report : null;
	}

	async #readObserved(path: StorePath): Promise<Bytes | null> {
		const at = this.#journal?.mark() ?? 0;
		const bytes = await readIfPresent(this.#store, path);
		if (bytes) this.#journal?.observe(path, bytes, at);
		return bytes;
	}

	forgetReplaySkip(path: string, copy: string): void {
		const storage = this.#journalStorage;
		if (!storage || !this.#journal) return;
		forgetHeldCopy(storage, this.#journal.workspace, path, copy);
		const report = this.replayReport;
		if (report === null) return;
		const remaining = {
			...report,
			skipped: report.skipped.filter((entry) => entry.path !== path || entry.copy !== copy)
		};

		this.replayReport = replayIsNoteworthy(remaining) ? remaining : null;
	}

	static unsupportedReason(): string {
		if (OpfsProjectStore.isSupported()) return '';
		return (
			'This browser is not offering storage for a Workspace. That happens when the page is ' +
			'not served over a secure connection — open it over https://, or from localhost.'
		);
	}

	get store(): ProjectStore {
		return this.#store;
	}

	installFlushOnHide(): () => void {
		return installFlushOnHide(this.#autosave, { document, window });
	}

	async refresh(): Promise<void> {
		try {
			this.projects = await this.#workspace.listProjects();
			this.status = 'ready';
			this.unreachableDetail = '';
		} catch (cause) {
			this.#unreachable(cause);
		}
	}

	async createProject(displayName: string, description = ''): Promise<ProjectSummary | null> {
		const created = await this.#mutate(null, () =>
			this.#workspace.createProject(displayName, description)
		);
		if (created) track({ name: 'project-created' });
		return created;
	}

	async updateProjectDetails(
		directory: string,
		details: { name?: string; description?: string }
	): Promise<void> {
		await this.#mutate(directory, () => this.#workspace.updateProjectDetails(directory, details));
		if (this.openDirectory === directory && this.openProject) {
			this.openProject = {
				...this.openProject,
				name: details.name ?? this.openProject.name,
				description: (details.description ?? this.openProject.description).trim()
			};
		}
	}

	async duplicateProject(directory: string): Promise<void> {
		await this.#mutate(directory, () => this.#workspace.duplicateProject(directory));
	}

	async setProjectOnFrontPage(directory: string, onFrontPage: boolean): Promise<void> {
		await this.#mutate(directory, () =>
			this.#workspace.setProjectOnFrontPage(directory, onFrontPage)
		);
		const listed = this.projects.find((project) => project.directory === directory);
		if (this.openDirectory === directory && this.openProject !== null && listed !== undefined) {
			this.openProject = { ...this.openProject, onFrontPage: listed.onFrontPage };
		}
	}

	async deleteProject(directory: string): Promise<void> {
		this.deletionWarning = '';
		const was = this.projects.find((project) => project.directory === directory) ?? null;
		this.#journal?.forgetUnder(`${directory}/`);
		await this.#mutate(directory, () =>
			this.#workspace.deleteProject(
				directory,
				was ? { name: was.name, updatedAt: was.updatedAt } : null
			)
		);
	}

	dismissProjectProblem(): void {
		this.projectProblem = null;
	}

	dismissMapImageError(): void {
		this.mapImageError = '';
	}

	async open(directory: string | null): Promise<void> {
		if (directory !== null && directory === this.openDirectory && this.openProject !== null) {
			return;
		}
		const generation = ++this.#openGeneration;
		await this.flush();
		if (generation !== this.#openGeneration) return;
		this.openDirectory = directory;
		this.openProject = null;
		this.projectProblem = null;

		if (directory !== null) this.#discardHistory(directory);
		this.images = [];
		this.referencedImages = [];
		this.referencedImageErrors = [];
		this.ingestError = '';
		this.addMapError = '';

		if (directory === null) return this.refresh();

		try {
			const file = await this.#workspace.readProject(directory);

			if (generation !== this.#openGeneration) return;
			const healed = resolveBaseMap(file.baseMap).fellBack;
			this.openProject = healed ? { ...file, baseMap: null } : file;
			this.status = 'ready';
			if (healed) await this.#write(directory);
			this.unreachableDetail = '';

			this.images = await listIngestedImages(this.#store);
			const referenced = await listReferencedImages(this.#store);
			if (generation !== this.#openGeneration) return;
			this.referencedImages = referenced.images;
			this.referencedImageErrors = referenced.unreadable;
		} catch (cause) {
			if (generation !== this.#openGeneration) return;
			const problem = describeProblem(cause, directory);
			if (problem) {
				if (problem.kind === 'missing') {
					await this.refresh();
					if (generation !== this.#openGeneration) return;
					if (this.status === 'unreachable') return;
				}
				this.projectProblem = problem;
				return;
			}
			this.#unreachable(cause);
		}
	}

	async ingestImage(file: File): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;

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

			if (await this.#addMapLayer({ imageId: ingested.imageId, image: ingested })) {
				track({ name: 'map-image-added', data: { source: 'local' } });
			}

			this.images = await listIngestedImages(this.#store);
		} catch (cause) {
			this.ingestError = controller.signal.aborted ? '' : messageOf(cause);
		} finally {
			this.#ingestAbort = null;
			this.ingest = null;
			this.ingestLabel = '';
		}
	}

	cancelIngest(): void {
		this.#ingestAbort?.abort();
	}

	imageServiceFetch(onOutcome?: (outcome: TileFetchOutcome) => void): FetchFn {
		return createStoreImageFetch({ store: this.#store, onOutcome });
	}

	async readAlignment(
		imageId: string,
		image: { width: number; height: number }
	): Promise<Alignment> {
		this.alignmentError = '';
		try {
			const bytes = await this.#readObserved(alignmentPath(imageId));
			this.#alignmentOnDisk.set(imageId, bytes);
			return bytes ? parseAlignment(bytes, { imageId }) : newAlignment(imageId, image);
		} catch (cause) {
			this.#alignmentOnDisk.delete(imageId);
			this.alignmentError = messageOf(cause);
			throw cause;
		}
	}

	dismissAlignmentChangedElsewhere(): void {
		this.alignmentChangedElsewhere = null;
	}

	async restoreAlignmentChangedElsewhere(): Promise<boolean> {
		const pending = this.alignmentChangedElsewhere;
		if (!pending || !this.openDirectory) return false;
		let restored = false;

		await this.#behindAlignmentWritesFor(pending.imageId, async () => {
			try {
				await this.#replaceAlignment(
					pending.imageId,
					pending.displaced,
					'the Control Points this session wrote over the version that arrived from ' +
						'elsewhere, at the user’s request'
				);
				if (this.alignmentChangedElsewhere === pending) this.alignmentChangedElsewhere = null;

				this.#discardHistory(pending.imageId);
				restored = true;
			} catch (cause) {
				this.saveError = messageOf(cause);
			}
		});
		return restored;
	}

	async writeAlignment(alignment: Alignment): Promise<void> {
		if (!this.openDirectory) return;

		await this.#behindAlignmentWritesFor(alignment.imageId, () =>
			this.#writeAlignmentNow(alignment)
		);
	}

	async #behindAlignmentWritesFor(imageId: string, write: () => Promise<void>): Promise<void> {
		const queued = (this.#alignmentWriteInFlight.get(imageId) ?? Promise.resolve()).then(write);
		this.#alignmentWriteInFlight.set(imageId, queued);
		try {
			await queued;
		} finally {
			if (this.#alignmentWriteInFlight.get(imageId) === queued) {
				this.#alignmentWriteInFlight.delete(imageId);
			}
		}
	}

	async #writeAlignmentNow(alignment: Alignment): Promise<void> {
		const path = alignmentPath(alignment.imageId);
		try {
			const report = await writeAlignmentFileReporting(this.#alignmentFile, {
				alignment,
				write: { intent: 'update', basedOn: this.#alignmentOnDisk.get(alignment.imageId) },
				address: this.#alignmentAddressFor(alignment.imageId)
			});
			this.saveError = '';

			this.#rememberAlignmentOnDisk(alignment.imageId, report.written);
			if (report.outcome === 'written over a change' && report.displaced) {
				this.alignmentChangedElsewhere = {
					imageId: alignment.imageId,
					displaced: report.displaced
				};
				this.#discardHistory(alignment.imageId);
			}

			recordAlignmentWrite(path, alignment.controlPoints.length);
		} catch (cause) {
			this.saveError = messageOf(cause);
		}
	}

	#rememberAlignmentOnDisk(imageId: string, written: Bytes | null): void {
		if (written) this.#alignmentOnDisk.set(imageId, written);
	}

	async #writeAlignmentBack(imageId: string, bytes: Bytes | null): Promise<void> {
		let failure: unknown = null;
		await this.#behindAlignmentWritesFor(imageId, async () => {
			try {
				if (bytes === null) {
					await this.#store.delete(alignmentPath(imageId));
					this.#alignmentOnDisk.set(imageId, null);
					return;
				}
				await this.#replaceAlignment(
					imageId,
					bytes,
					'the Alignment edit named on the control the user pressed, which is what this ' +
						'screen’s Edit History was asked to reverse'
				);
			} catch (cause) {
				failure = cause;
			}
		});
		if (failure !== null) throw failure;
	}

	async #replaceAlignment(imageId: string, bytes: Bytes, discarding: string): Promise<void> {
		await writeAlignmentBytes(this.#alignmentFile, {
			imageId,
			bytes,
			write: { intent: 'replace', discarding }
		});
		this.#alignmentOnDisk.set(imageId, bytes);
	}

	mapImageSource(imageId: string): MapImageSource {
		const referenced = this.#referenced.find((image) => image.imageId === imageId);
		return referenced ? sourceOf(referenced) : { imageMode: 'offline-copy', imageId };
	}

	#alignmentAddressFor(imageId: string): AlignmentAddress | undefined {
		const source = this.mapImageSource(imageId);
		return source.imageMode === 'referenced'
			? referencedAlignmentAddress(source.service)
			: undefined;
	}

	get #alignmentFile(): AlignmentFilePort {
		return {
			read: (path) => this.#store.read(path),
			commit: (path, bytes) => this.#autosave.commit(path, bytes)
		};
	}

	mapLayerFor(imageId: string): MapLayer | undefined {
		return this.openProject?.layers.find(
			(layer): layer is MapLayer => layer.kind === 'map' && layer.imageId === imageId
		);
	}

	async #addMapLayer(fields: {
		imageId: string;
		image: { width: number; height: number };
		name?: string;
		address?: AlignmentAddress;
		alignment?: Alignment | null;
	}): Promise<MapLayerAdded | null> {
		const { imageId } = fields;
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return null;
		let alignment: AlignmentWriteOutcome;
		try {
			const report = await writeAlignmentFileReporting(this.#alignmentFile, {
				alignment: fields.alignment
					? { ...fields.alignment, imageId }
					: newAlignment(imageId, fields.image),
				write: { intent: 'create' },
				address: fields.address
			});
			this.#rememberAlignmentOnDisk(imageId, report.written);
			alignment = report.outcome;
			this.saveError = '';
		} catch (cause) {
			this.saveError = messageOf(cause);
			return null;
		}

		if (!this.openProject) return null;
		const already = this.mapLayerFor(imageId);
		if (already) return { layer: already, alignment };
		const name =
			fields.name || (await this.#readJson(imageManifestPath(imageId), readImageLabel)) || imageId;
		if (!this.openProject || this.openDirectory !== directory) return null;
		const raced = this.mapLayerFor(imageId);
		if (raced) return { layer: raced, alignment };
		const layer = newMapLayer({ id: crypto.randomUUID(), name, imageId });

		const written = await this.historyFor(directory).step(
			`Undo adding the Map Image ${quotedName(name)}`,
			[projectFilePath(directory)],
			async () => {
				const current = this.openProject;
				if (!current || this.openDirectory !== directory) return false;
				this.openProject = { ...current, layers: addLayer(current.layers, layer) };
				await this.#write(directory);
				return this.saveError === '';
			}
		);
		return written ? { layer, alignment } : null;
	}

	async addReferencedMap(fields: {
		service: RemoteImageService;
		source?: string;
		label: string;
		partOf: string;
		canvas: string;
		rights: string;
		attribution: string;
		alignment: Alignment | null;
	}): Promise<ReferencedMapAdded | null> {
		if (!this.openDirectory || !this.openProject) return null;

		const { service } = fields;
		const record = referencedImage({
			imageId: service.imageId,
			service: service.uri,
			source: fields.source || fields.partOf || service.uri,
			label: fields.label,
			partOf: fields.partOf,
			canvas: fields.canvas,
			rights: fields.rights,
			attribution: fields.attribution,
			width: service.width,
			height: service.height,

			tileSize: service.tileSize
		});
		try {
			await this.#autosave.commit(
				referencedImagePath(record.imageId),
				serialiseReferencedImage(record)
			);
		} catch (cause) {
			this.saveError = messageOf(cause);
			return null;
		}

		const added = await this.#addMapLayer({
			imageId: record.imageId,
			image: { width: service.width, height: service.height },
			alignment: fields.alignment,
			name: record.label || record.imageId,

			address: referencedAlignmentAddress(record.service)
		});
		if (!added) return null;
		track({ name: 'map-image-added', data: { source: 'remote' } });

		this.referencedImages = [
			...this.referencedImages.filter((image) => image.imageId !== record.imageId),
			record
		];
		return { layer: added.layer, keptExistingAlignment: added.alignment === 'kept over the offer' };
	}

	async addWorkspaceMap(imageId: string): Promise<MapLayer | null> {
		this.addMapError = '';
		if (!this.openDirectory || !this.openProject) return null;
		const image = await this.#storedImageSize(imageId);
		if (image === null) {
			this.addMapError =
				`That Map Image was not added: this Workspace holds no readable description of its ` +
				`size, so there is nothing to place an Alignment over. Its record at ` +
				`images/${imageId}/ is missing or damaged.`;
			return null;
		}

		const added = await this.#addMapLayer({
			imageId,
			image,
			address: this.#alignmentAddressFor(imageId)
		});
		if (added === null) {
			this.addMapError =
				this.saveError || 'That Map Image was not added: the Layer could not be written.';
			return null;
		}
		track({ name: 'map-image-added', data: { source: 'workspace' } });
		return added.layer;
	}

	async #storedImageSize(imageId: string): Promise<{ width: number; height: number } | null> {
		const size = await this.#readJson(imageInfoPath(imageId), imageSizeFromInfo);
		if (size) return size;
		const record = this.referencedImages.find((image) => image.imageId === imageId);
		if (record && record.width > 0 && record.height > 0) {
			return { width: record.width, height: record.height };
		}
		return null;
	}

	async refreshMapImages(): Promise<void> {
		this.mapImagesLoading = true;
		try {
			this.mapImages = await listWorkspaceMapImages(this.#store);
		} catch (cause) {
			this.mapImages = [];
			this.#unreachable(cause);
		} finally {
			this.mapImagesLoading = false;
		}
	}

	async refreshAddableMapImages(): Promise<void> {
		this.addMapError = '';
		this.mapImagesLoading = true;
		try {
			const referenced = await listReferencedImages(this.#store);
			this.referencedImages = referenced.images;
			this.referencedImageErrors = referenced.unreadable;
			this.images = await listIngestedImages(this.#store);
			this.mapImages = await listWorkspaceMapImages(this.#store);
		} catch (cause) {
			this.addMapError =
				`The Map Images in this Workspace could not be looked through: ` +
				`${messageOf(cause)} Everything already in this ` +
				`Project is unaffected, and a file or a library address still works.`;
		} finally {
			this.mapImagesLoading = false;
		}
	}

	async deleteMapImage(imageId: string): Promise<boolean> {
		this.mapImageError = '';
		const label = this.mapImages.find((map) => map.imageId === imageId)?.label ?? '';
		const paths = [`${imageDirectory(imageId)}/`, alignmentPath(imageId)];
		await Promise.all(paths.map((path) => this.#autosave.settled(path)));
		const forget = (): void => {
			for (const path of paths) void this.#autosave.abandon(path);
			for (const path of paths) this.#journal?.forgetUnder(path);
			this.#discardHistory(imageId);
		};
		try {
			await deleteMapImage(this.#store, imageId, { label });
		} catch (cause) {
			if (cause instanceof MapImagePartlyDeletedError) forget();
			this.mapImageError =
				cause instanceof MapImageInUseError || cause instanceof MapImagePartlyDeletedError
					? cause.message
					: `“${label || imageId}” could not be deleted: ${messageOf(cause)}`;

			await this.refreshMapImages();
			return false;
		}
		forget();
		this.images = this.images.filter((image) => image.imageId !== imageId);
		this.referencedImages = this.referencedImages.filter((image) => image.imageId !== imageId);
		await this.refreshMapImages();
		return true;
	}

	async planPublishedSite(options: {
		bundle: ViewerBundle;
		editorUrl: string;
		repository: PublishedRepository | null;
	}): Promise<PublishedSitePlan> {
		return planPublishedSite(this.#store, {
			...options,
			projects: await this.#workspace.listProjects()
		});
	}

	async writePublishedSite(options: {
		plan: PublishedSitePlan;
		readAsset: (file: ViewerBundleFile) => Promise<Bytes>;
		onProgress?: (progress: { files: number; totalFiles: number; path: string | null }) => void;
	}): Promise<PublishedSite> {
		await this.flush();
		const site = await writePublishedSite({ ...options, store: this.#store });
		this.projects = await this.#workspace.listProjects();
		return site;
	}

	async planRemoteSend(options: {
		token: string | null;
		remote: RemoteRepository;
		pending?: readonly PendingLocalFile[];
		sending?: boolean;
	}): Promise<RemoteSendPlan> {
		return planWorkspaceUpload(this.#store, {
			...options,
			baseline: await this.#baseline(options.remote)
		});
	}

	async #baseline(remote: RemoteRepository): Promise<SynchronizationBaseline | null> {
		return (await this.#synchronization?.readBaseline(remote)) ?? null;
	}

	async updateFromRemote(options: {
		remote: RemoteRepository;
		token: string | null;
		onProgress?: (progress: { files: number; totalFiles: number }) => void;
		alignmentChoices?: ReadonlyMap<string, AlignmentChoice>;
	}): Promise<{ update: WorkspaceUpdate; baselineKept: boolean }> {
		await this.flush();
		await this.localChanges?.flushChanges();

		const update = await getFromRemote(this.#store, {
			...options,
			baseline: await this.#baseline(options.remote),
			estimateStorage: () => navigator.storage.estimate(),
			workspace: this.#workspaceKey,
			onProgress: ({ files, totalFiles }) => options.onProgress?.({ files, totalFiles })
		});

		for (const history of this.#histories.values()) history.discard();

		await this.localChanges?.flushChanges();
		const baselineKept =
			this.#synchronization === undefined ||
			(await this.#synchronization.writeBaseline({
				remote: options.remote,
				commit: update.commit,
				files: update.baseline
			}));

		if (baselineKept) await this.localChanges?.changes.clearShared(update.shared);

		this.projects = await this.#workspace.listProjects();

		const showing = this.openDirectory;
		if (showing !== null) {
			this.openProject = null;
			await this.open(showing);
		}
		return { update, baselineKept };
	}

	async sendToRemote(options: {
		token: string;
		remote: RemoteRepository;
		overwrite?: readonly string[];
		onProgress?: (progress: {
			files: number;
			totalFiles: number;
			requestsRemaining: number | null;
		}) => void;
	}): Promise<{ commit: string; plan: RemoteSendPlan; baselineKept: boolean }> {
		await this.flush();
		await this.localChanges?.flushChanges();
		return sendWorkspace(this.#store, {
			...options,
			metadata: this.#synchronization,
			changes: this.localChanges?.changes
		});
	}

	async makeOfflineCopy({
		image,
		...copy
	}: {
		image: ReferencedImage;
		service: RemoteImageService;
		plan: OfflineCopyPlan;
		onProgress?: (progress: OfflineCopyProgress) => void;
		signal?: AbortSignal;
	}): Promise<boolean> {
		await makeOfflineCopy({
			...copy,
			store: this.#store,
			label: image.label || image.imageId,
			fetch: this.imageServiceFetch(),
			assemble: assembleWithCanvas,
			openDecodeAndCrop: openDecodeAndCropSource
		});

		return this.#recordLocalCopy(image.imageId);
	}

	async #recordLocalCopy(imageId: string): Promise<boolean> {
		const path = alignmentPath(imageId);
		try {
			const report = await writeAlignmentFileReporting(this.#alignmentFile, {
				alignment: parseAlignment(await this.#store.read(path), { imageId }),
				write: { intent: 'update' }
			});

			this.#rememberAlignmentOnDisk(imageId, report.written);
			this.saveError = '';
		} catch (cause) {
			if (!(cause instanceof PathNotFoundError)) {
				this.saveError = messageOf(cause);
				return false;
			}
		}

		this.images = await listIngestedImages(this.#store);
		return this.images.some((image) => image.imageId === imageId);
	}

	async #readJson<T>(path: StorePath, read: (json: unknown) => T): Promise<T | null> {
		return this.#store
			.read(path)
			.then((bytes) => read(parseJsonBytes(bytes)))
			.catch(() => null);
	}

	async addAnnotationLayer(name: string): Promise<AnnotationLayer | null> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return null;
		const layer = newAnnotationLayer({ id: crypto.randomUUID(), name });

		return this.historyFor(directory).step(
			`Undo adding the Layer ${quotedName(name)}`,
			[annotationStorePath(directory, layer.id), projectFilePath(directory)],
			async () => {
				try {
					await this.#autosave.commit(
						annotationStorePath(directory, layer.id),
						emptyAnnotationCollection()
					);
				} catch (cause) {
					this.saveError = messageOf(cause);
					return null;
				}
				const project = this.openProject;
				if (!project) return null;
				this.openProject = { ...project, layers: addLayer(project.layers, layer) };
				await this.#write(directory);
				return layer;
			}
		);
	}

	async typeLayerName(id: string, name: string): Promise<void> {
		await this.#changeLayers((layers) => renameLayer(layers, id, name), { debounce: true });
	}

	async showLayer(id: string, visible: boolean): Promise<void> {
		await this.#changeLayers((layers) => setLayerVisible(layers, id, visible), {
			label: `Undo ${visible ? 'showing' : 'hiding'} the Layer ${this.#quotedLayerName(id)}`
		});
	}

	async dragLayerOpacity(id: string, opacity: number): Promise<void> {
		const standing = this.#opacityDrag;

		if (standing && standing.id !== id) await this.commitLayerEdit();

		const drag = this.#openOpacityStep(id);
		const directory = this.openDirectory;
		if (drag === null || directory === null) return;
		const write = this.#applyLayerChange(directory, (layers) =>
			setMapLayerOpacity(layers, id, opacity)
		);
		if (write === null) return;
		const applied = drag.applied.then(() => write({ debounce: true }));
		drag.applied = applied;
		await applied;
	}

	async moveLayerTo(id: string, toIndex: number): Promise<void> {
		await this.#changeLayers((layers) => moveLayer(layers, id, toIndex), {
			label: `Undo moving the Layer ${this.#quotedLayerName(id)}`
		});
	}

	#openOpacityStep(id: string): OpacityDrag | null {
		const standing = this.#opacityDrag;
		if (standing?.id === id) return standing;
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return null;
		this.#opacityDrag = {
			id,
			...this.#holdStep(directory, `Undo the opacity of the Layer ${this.#quotedLayerName(id)}`, [
				projectFilePath(directory)
			])
		};
		return this.#opacityDrag;
	}

	#holdStep(directory: string, label: string, paths: StorePath[]): HeldStep {
		let start = (): void => {};
		let end = (): void => {};
		const applied = new Promise<void>((resolve) => (start = resolve));
		const finished = new Promise<void>((resolve) => (end = resolve));
		const step = this.historyFor(directory).step(label, paths, async () => {
			start();
			await finished;
		});
		return { applied, end, step };
	}

	async #release(held: HeldStep): Promise<void> {
		await held.applied;
		held.end();
		await held.step;
	}

	#quotedLayerName(id: string): string {
		return quotedName(this.openProject?.layers.find((layer) => layer.id === id)?.name ?? '');
	}

	historyFor(subject: string): EditHistory {
		const standing = this.#histories.get(subject);
		if (standing) return standing;
		const made = new EditHistory(this.#historyFiles, { byteCeiling: HISTORY_BYTE_CEILING });
		this.#histories.set(subject, made);
		return made;
	}

	#discardHistory(subject: string): void {
		this.#histories.get(subject)?.discard();
	}

	async deleteLayer(id: string): Promise<boolean> {
		const directory = this.openDirectory;
		const layer = this.openProject?.layers.find((one) => one.id === id);
		if (!directory || !layer) return false;
		const ref = layerFileRef(layer);
		const path = ref === '' ? '' : `${directory}/${ref}`;

		return this.historyFor(directory).step(
			`Undo delete of the Layer ${quotedName(layer.name)}`,
			path === '' ? [projectFilePath(directory)] : [path, projectFilePath(directory)],
			async () => {
				let present = false;
				if (path !== '') {
					try {
						present = (await readIfPresent(this.#store, path)) !== null;
					} catch (cause) {
						this.saveError = messageOf(cause);
						return false;
					}
				}

				const project = this.openProject;
				if (!project || !project.layers.some((one) => one.id === id)) return false;
				this.openProject = { ...project, layers: removeLayer(project.layers, id) };
				await this.#write(directory);
				if (this.saveError !== '') {
					this.openProject = project;
					return false;
				}

				if (present) await this.#store.delete(path);
				return true;
			}
		);
	}

	async commitLayerEdit(): Promise<void> {
		const drag = this.#opacityDrag;
		if (!drag) return this.commitProject();
		this.#opacityDrag = null;
		await this.#release(drag);
	}

	async #changeLayers(
		change: (layers: readonly Layer[]) => readonly Layer[],
		options: { debounce?: boolean; label?: string } = {}
	): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;
		const write = this.#applyLayerChange(directory, change);
		if (write === null) return;

		const { label } = options;

		if (label === undefined) {
			await write(options);
			return;
		}
		await this.historyFor(directory).step(label, [projectFilePath(directory)], () =>
			write(options)
		);
	}

	#applyLayerChange(
		directory: string,
		change: (layers: readonly Layer[]) => readonly Layer[]
	): ((options: { debounce?: boolean }) => Promise<void>) | null {
		const project = this.openProject;
		if (!project || this.openDirectory !== directory) return null;
		const layers = change(project.layers);
		if (layers === project.layers) return null;
		this.openProject = { ...project, layers };
		this.saveState = 'saving';
		return (options) => this.#write(directory, options);
	}

	async readLayerAlignment(layer: MapLayer): Promise<Alignment | null> {
		const { imageId } = layer;
		if (imageId === '') return null;
		const bytes = await this.#readObserved(alignmentPath(imageId));
		return bytes && parseAlignment(bytes, { imageId });
	}

	async readAnnotations(layer: AnnotationLayer): Promise<AnnotationCollection> {
		const directory = this.openDirectory;
		if (!directory || layer.geojsonRef === '') return emptyCollection();
		const bytes = await this.#readObserved(`${directory}/${layer.geojsonRef}`);
		return bytes ? parseAnnotations(bytes, { path: layer.geojsonRef }) : emptyCollection();
	}

	async writeAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		options: { debounce?: boolean; label?: string } = {}
	): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;
		const path = annotationStorePath(directory, layer.id);
		const { label } = options;

		if (label === undefined && options.debounce !== true && this.#annotationDrag?.path === path) {
			await this.#closeAnnotationDrag();
			return;
		}
		const bytes = serialiseAnnotations(collection);

		if (label !== undefined) {
			this.saveState = 'saving';
			await this.historyFor(directory).step(label, [path], () =>
				this.#putAnnotations(path, collection, bytes, options)
			);
			return;
		}
		await this.#putAnnotations(path, collection, bytes, options);
	}

	async moveAnnotationBetweenLayers(
		to: AnnotationLayer,
		target: AnnotationCollection,
		from: AnnotationLayer,
		source: AnnotationCollection,
		label: string
	): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;
		const toPath = annotationStorePath(directory, to.id);
		const fromPath = annotationStorePath(directory, from.id);
		this.saveState = 'saving';
		await this.historyFor(directory).step(label, [toPath, fromPath], async () => {
			await this.#putAnnotations(toPath, target, serialiseAnnotations(target), {});
			await this.#putAnnotations(fromPath, source, serialiseAnnotations(source), {});
		});
	}

	async dragAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		drag: { key: string; label: string }
	): Promise<void> {
		const directory = this.openDirectory;
		if (!directory) return;
		const path = annotationStorePath(directory, layer.id);
		const bytes = serialiseAnnotations(collection);
		const standing = this.#annotationDrag;
		if (standing && standing.key !== drag.key) await this.#closeAnnotationDrag();
		const open = this.#openAnnotationStep(directory, path, drag);
		open.written = { annotations: collection.annotations.length, bytes: bytes.length };

		const applied = open.applied.then(() =>
			this.#putAnnotations(path, collection, bytes, { debounce: true })
		);
		open.applied = applied;
		await applied;
	}

	#openAnnotationStep(
		directory: string,
		path: StorePath,
		drag: { key: string; label: string }
	): AnnotationDrag {
		const standing = this.#annotationDrag;
		if (standing?.key === drag.key) return standing;
		this.saveState = 'saving';
		this.#annotationDrag = {
			key: drag.key,
			path,
			written: null,
			...this.#holdStep(directory, drag.label, [path])
		};
		return this.#annotationDrag;
	}

	async #closeAnnotationDrag(): Promise<void> {
		const drag = this.#annotationDrag;
		if (!drag) return;
		this.#annotationDrag = null;
		await this.#release(drag);

		if (drag.written) {
			recordAnnotationWrite(drag.path, drag.written.annotations, drag.written.bytes);
		}
	}

	async #putAnnotations(
		path: StorePath,
		collection: AnnotationCollection,
		bytes: Bytes,
		options: { debounce?: boolean }
	): Promise<void> {
		if (options.debounce) {
			this.#autosave.queue(path, bytes);
			return;
		}
		try {
			await this.#autosave.commit(path, bytes);
			this.saveError = '';

			recordAnnotationWrite(path, collection.annotations.length, bytes.length);
		} catch (cause) {
			this.saveError = messageOf(cause);
		}
	}

	hasPendingAnnotationWrite(layer: AnnotationLayer): boolean {
		const directory = this.openDirectory;
		if (!directory) return false;
		const path = annotationStorePath(directory, layer.id);

		if (this.#annotationDrag?.path === path) return true;
		return this.#autosave.hasPendingWrite(path);
	}

	async updateProject(
		patch: Partial<ProjectFile>,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;
		this.openProject = { ...this.openProject, ...patch };
		await this.#write(directory, options);
	}

	async chooseBorderStyle(
		patch: Partial<BaseMapBorderStyle>,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const project = this.openProject;
		if (project) {
			await this.updateProject({ borderStyle: { ...project.borderStyle, ...patch } }, options);
		}
	}

	async commitProject(): Promise<void> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;
		if (!this.#autosave.hasPendingWrite(projectFilePath(directory))) return;
		await this.#write(directory);
	}

	async flush(): Promise<void> {
		await this.#autosave.flush();
	}

	capture(): void {
		this.#autosave.capture();
	}

	async #write(directory: string, options: { debounce?: boolean } = {}): Promise<void> {
		try {
			await this.#workspace.writeProject(directory, this.openProject as ProjectFile, options);
			this.saveError = '';
		} catch (cause) {
			this.saveError = messageOf(cause);
		}
	}

	#unreachable(cause: unknown): void {
		this.status = 'unreachable';
		this.unreachableDetail = messageOf(cause);
	}

	async #mutate<T>(directory: string | null, action: () => Promise<T>): Promise<T | null> {
		try {
			const result = await action();
			this.projects = await this.#workspace.listProjects();
			this.status = 'ready';
			this.unreachableDetail = '';
			this.projectProblem = null;
			return result;
		} catch (cause) {
			const problem = describeProblem(cause, directory);
			if (problem) {
				this.projectProblem = problem;
				await this.refresh();
				return null;
			}
			this.#unreachable(cause);
			return null;
		}
	}
}

const quotedName = (name: string): string => (name === '' ? 'with no name' : `“${name}”`);

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

	if (cause instanceof ReservedDirectoryNameError) {
		return { kind: 'reserved-name', message: cause.message };
	}
	return null;
}

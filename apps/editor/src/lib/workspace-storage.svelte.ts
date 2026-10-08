import { getContext, setContext } from 'svelte';

import {
	DEFAULT_WORKSPACE_NAME,
	ManagedProjectStore,
	FolderPermissionDeniedError,
	assertNotReviewing as refuseInsideReview,
	assertReviewing as refuseOutsideReview,
	chooseWorkspaceFolder,
	copyWorkspaceFiles,
	createOpfsWorkspace,
	deleteOpfsWorkspace,
	ensureOpfsWorkspace,
	exportProjectBundle,
	exportWorkspaceTar,
	forgetFolderWorkspace,
	ImportRecoveryFailedError,
	UpdateRefusedError,
	isFolderWorkspaceSupported,
	listFolderWorkspaces,
	openFolderWorkspace,
	renameFolderWorkspace,
	listOpfsWorkspaces,
	migratePreExistingFolderWorkspace,
	openOpfsWorkspace,
	allocateProjectImport,
	readReviewWorkspaceSource,
	refuseReviewDestination,
	releaseWorkspaceFolder,
	reopenRetainedWorkspaceFolder,
	retainWorkspaceFolder,
	reviewCopyStillHere,
	reviewImportOrigin,
	commitProjectImport,
	readImportEvidence,
	detachImportedProject,
	readRemoteProjectSource,
	remapProjectImport,
	serialiseProjectFile,
	readReviewMark,
	recoverProjectImport,
	recoverWorkspaceUpdate,
	reopenWorkspaceFolder,
	resolveFolderWorkspace,
	restoreWorkspaceTar,
	reviewFromRemote,
	FileSystemAccessProjectStore,
	SynchronizationMetadata,
	Workspace,
	workspaceSize,
	messageOf,
	requestPersistentStorage,
	readPersistentStoragePermission,
	readStoragePersisted,
	browserJournalStorage,
	discardDeletions,
	discardJournal,
	browserMetadataStorage,
	discardLocalChanges,
	discardSynchronizationMetadata,
	journalledWorkspaces,
	workspacesWithDeletions,
	describeRemote,
	describeReviewSubject,
	type JournalStorage,
	type ClosureFile,
	type FolderWorkspaceRecord,
	type ProjectImportSource,
	type ProjectStore,
	type ProjectSummary,
	type MetadataStorage,
	type RemoteRelationship,
	type SynchronizationBaseline,
	type RemoteReference,
	type ReviewDestination,
	type ReviewMark,
	type ReviewOrigin,
	type ReviewReference,
	type ReviewedProject,
	type StorageAnswers,
	type TransferProgressListener,
	type WorkspaceBackup,
	type WorkspaceRestore,
	type WorkspaceSize
} from '@ballastella/core';

import { EditorSession, trackLocalChanges } from './editor-session.svelte.js';
import {
	folderReferenceOf,
	folderWorkspaceKey,
	folderWorkspaceLabel,
	namedWorkspaceOf,
	opfsWorkspaceKey,
	workspaceKeyLabel
} from './workspace-key.js';
import { saveFile } from '@ballastella/ui';

import { readItem, writeItem } from './browser-storage.js';
import { GitHubAccount } from './github-account.svelte.js';
import { Remote } from './remote.svelte.js';

const estimateStorage = async (): Promise<{ quota?: number; usage?: number } | null> => {
	if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
	return navigator.storage.estimate();
};

interface TransferState {
	readonly kind: 'export' | 'import' | 'open';
	readonly subject: string;
	readonly files: number;
	readonly totalFiles: number;
	readonly finished: boolean;
}

type Announce = (files: number, totalFiles: number, finished?: boolean) => void;

export type WorkspaceBacking = 'browser' | 'folder';

export type WorkspaceEntry = {
	readonly key: string;
	readonly label: string;
	readonly kind: WorkspaceBacking;
	readonly folderName: string;
	readonly isOpen: boolean;
	readonly isReviewCopy: boolean;
};

export interface ImportTarget {
	readonly name: string;
	readonly key: string;
}

interface ImportInto {
	readonly name: string;
	readonly store: ProjectStore;
	readonly local: readonly string[];
	readonly names: readonly string[];
	readonly remote: RemoteRelationship | null;
	readonly baseline: SynchronizationBaseline | null;
	settle?: () => Promise<void>;
}

interface ReopenedOrigin {
	readonly folder: FileSystemAccessProjectStore | null;
	readonly into: ImportInto;
}

interface ImportedIntoWorkspace {
	readonly name: string;
	readonly directory: string;
	readonly workspace: string;
}

interface ImportedFromReview extends ImportedIntoWorkspace {
	readonly incomplete: string;
}

const OPEN_WORKSPACE_KEY = 'ballastella.workspace';
const OPEN_FOLDER_KEY = 'ballastella.open-folder';
const OWN_WORKSPACE_KEY = 'ballastella.own-workspace';
const OWN_FOLDER_KEY = 'ballastella.own-folder';
const WORKSPACE_LABEL_PREFIX = 'ballastella.workspace-label.';
const labelKey = (name: string): string => `${WORKSPACE_LABEL_PREFIX}${encodeURIComponent(name)}`;
const remembered = (key: string): string => readItem('localStorage', key) || '';
const remember = (key: string, value: string | null): void => writeItem('localStorage', key, value);

function rememberOwnWorkspace(name: string, folder: string): void {
	if (!folder) remember(OWN_WORKSPACE_KEY, name);
	remember(OWN_FOLDER_KEY, folder);
}

interface AdoptedFolder {
	readonly store: FileSystemAccessProjectStore;
	readonly folderReference: string;
	readonly folderName: string;
}

const folderKeyOf = (folder: { folderReference: string; folderName: string }): string =>
	folderWorkspaceKey(folder.folderReference || folder.folderName);

export class WorkspaceStorage {
	session = $state<EditorSession>(
		EditorSession.opfs(remembered(OPEN_WORKSPACE_KEY) || DEFAULT_WORKSPACE_NAME)
	);
	#folder = $state.raw<AdoptedFolder | null>(null);
	folderWorkspaces = $state<readonly FolderWorkspaceRecord[]>([]);
	workspaceName = $state(remembered(OPEN_WORKSPACE_KEY) || DEFAULT_WORKSPACE_NAME);
	resumeFolder = $state(remembered(OPEN_FOLDER_KEY));
	workspaces = $state<string[]>([]);
	workspaceLabels = $state<Readonly<Record<string, string>>>({});
	review = $state<ReviewMark | null>(null);
	reviewWorkspaces = $state<string[]>([]);
	transfer = $state<TransferState | null>(null);
	transferError = $state('');
	storageAnswers = $state<StorageAnswers | null>(null);
	canChooseFolder = $state(false);
	problem = $state('');
	orphanedJournals = $state<string[]>([]);
	unprotected = $state('');
	unavailable = $state('');
	#teardownFlushOnHide: (() => void) | undefined;
	#foldersRecorded: Promise<void> = Promise.resolve();
	#ownWorkspaceName = remembered(OWN_WORKSPACE_KEY) || DEFAULT_WORKSPACE_NAME;
	#ownFolder = remembered(OWN_FOLDER_KEY);
	readonly #journalStorage: JournalStorage | null = browserJournalStorage();
	readonly #metadataStorage: MetadataStorage | null = browserMetadataStorage();

	readonly github = new GitHubAccount({
		reviewing: () => this.review !== null,
		recovered: () => this.#recovered,
		onSignedIn: () => void this.remote.check('open')
	});

	readonly #remoteHost = { name: () => this.name, github: this.github };
	remote = $state<Remote>(new Remote(this.session, this.#remoteHost));

	#recovered: Promise<void>;
	#finishRecovery: () => void = () => undefined;

	constructor() {
		this.#recovered = this.#beginRecovery();
	}

	openWhenRecovered(directory: string | null): void {
		const session = this.session;
		if (!this.resumeFolder) void this.#recovered.then(() => session.open(directory));
	}

	#beginRecovery(): Promise<void> {
		this.#recovered = new Promise<void>((resolve) => {
			this.#finishRecovery = resolve;
		});
		return this.#recovered;
	}

	async #recoverTransfers(store: ProjectStore): Promise<boolean> {
		this.unavailable = '';
		return (
			(await this.#recover(
				store,
				() => recoverProjectImport(store),
				ImportRecoveryFailedError,
				'an Import that did not finish'
			)) &&
			this.#recover(
				store,
				() => recoverWorkspaceUpdate(store),
				UpdateRefusedError,
				'a get from GitHub that did not finish'
			)
		);
	}

	async #recover(
		store: ProjectStore,
		run: () => Promise<unknown>,
		Refused: abstract new (...args: never[]) => Error,
		what: string
	): Promise<boolean> {
		try {
			await run();
			return true;
		} catch (cause) {
			if (
				!(await store.list('').then(
					() => true,
					() => false
				))
			)
				return true;
			this.unavailable =
				cause instanceof Refused
					? cause.message
					: `This Workspace could not be opened, because ${what} could not be cleared up: ${messageOf(cause)}`;
			return false;
		}
	}

	start(): () => void {
		this.canChooseFolder = isFolderWorkspaceSupported();
		this.#teardownFlushOnHide = this.session.installFlushOnHide();

		const onFocus = (): void => {
			void this.remote.check('focus');
		};
		window.addEventListener('focus', onFocus);
		if (this.#journalStorage === null) {
			this.unprotected =
				`This browser is not letting Ballastella keep a copy of an edit while it is being ` +
				`saved, so an edit made in the last moment before you close this tab may not be kept. ` +
				`Wait for the indicator to read “Saved locally” before you leave. Allowing site data for ` +
				`this page — usually blocked in a private window — turns the protection back on.`;
		}

		void ensureOpfsWorkspace(this.workspaceName)
			.then(() => this.#recoverTransfers(this.session.store))
			.then(async (available) => {
				if (!available) return false;
				this.review = await this.#markOf(this.session.store);

				await this.#readRemote(this.session);

				if (this.review === null) {
					this.#ownWorkspaceName = this.workspaceName;
					this.#ownFolder = '';
				}
				await this.#replayAndReport();
				return true;
			})
			.catch(() => this.unavailable === '')
			.then((available) => {
				if (!available) return undefined;

				this.#finishRecovery();
				return this.refreshWorkspaces();
			})
			.catch(() => undefined);

		void this.github.restoreRememberedSignIn().catch(() => undefined);

		void this.#readStorageAnswers();

		void requestPersistentStorage()
			.then(() => this.#readStorageAnswers())
			.catch(() => undefined);

		if (this.canChooseFolder) this.#foldersRecorded = this.#recordFolderWorkspaces();
		return () => {
			window.removeEventListener('focus', onFocus);
			this.remote.close();
			this.#teardownFlushOnHide?.();
			this.#teardownFlushOnHide = undefined;
		};
	}

	async #readStorageAnswers(): Promise<void> {
		const [persisted, permission] = await Promise.all([
			readStoragePersisted(),
			readPersistentStoragePermission()
		]);
		this.storageAnswers = {
			persisted,
			permission,

			ephemeral: this.#journalStorage === null
		};
	}

	async askToKeepStorage(): Promise<void> {
		await navigator.storage?.persist?.().catch(() => false);
		await this.#readStorageAnswers();
	}

	async chooseFolder(): Promise<void> {
		await this.#openFolder(chooseWorkspaceFolder);
	}

	async resumeFolderWorkspace(): Promise<void> {
		if (this.resumeFolder === '') return;
		this.problem = '';
		await this.#foldersRecorded;
		await this.#openFolder(
			() => openFolderWorkspace(this.resumeFolder),
			'This computer no longer holds a grant for that folder. Choose it again to open your Workspace.'
		);
	}

	async #openFolder(
		open: () => Promise<FileSystemAccessProjectStore | null>,
		missing = ''
	): Promise<boolean> {
		this.problem = '';
		try {
			const store = await open();
			if (!store) {
				this.problem = missing;
				return false;
			}
			await this.#adoptFolder(store);
			return true;
		} catch (cause) {
			this.problem = describeFolderProblem(cause);
			return false;
		}
	}

	async #adoptFolder(store: FileSystemAccessProjectStore): Promise<void> {
		await this.#adopt(await this.#identify(store));
		await this.#refreshFolderWorkspaces();
	}

	async #identify(store: FileSystemAccessProjectStore): Promise<AdoptedFolder> {
		await this.#foldersRecorded;
		const record = await resolveFolderWorkspace(store.folder).catch(() => null);
		return { store, folderReference: record?.reference ?? '', folderName: store.folderName };
	}

	async #recordFolderWorkspaces(): Promise<void> {
		await migratePreExistingFolderWorkspace({
			journalStorage: this.#journalStorage,
			metadataStorage: this.#metadataStorage,
			workspaceKey: folderWorkspaceKey
		}).catch(() => null);
		await this.#refreshFolderWorkspaces();
	}

	async #refreshFolderWorkspaces(): Promise<void> {
		this.folderWorkspaces = await listFolderWorkspaces().catch(() => this.folderWorkspaces);
	}

	async #markOf(store: ProjectStore): Promise<ReviewMark | null> {
		return readReviewMark(store).catch(() => this.review);
	}

	async refreshWorkspaces(): Promise<void> {
		this.workspaces = await listOpfsWorkspaces().catch(() => this.workspaces);

		const names = this.workspaces;
		const marked = await Promise.all(
			names.map((name) => readReviewMark(openOpfsWorkspace(name)).catch(() => true))
		);
		this.reviewWorkspaces = names.filter((_, index) => marked[index] !== null);

		this.workspaceLabels = Object.fromEntries(
			this.workspaces
				.map((name) => [name, remembered(labelKey(name))] as const)
				.filter(([, label]) => label !== '')
		);

		this.#refreshOrphanedJournals();
	}

	async openWorkspace(name: string): Promise<void> {
		await this.#switchTo(name);
		await this.refreshWorkspaces();
	}

	async #switchTo(name: string): Promise<void> {
		if (this.isOpen(name)) return;
		this.problem = '';
		const opened = await ensureOpfsWorkspace(name);
		await this.#adopt(null, opened);
	}

	async locateWorkspaceAgain(): Promise<void> {
		if (this.backing !== 'browser') {
			await this.session.refresh();
			return;
		}
		const name = this.workspaceName;

		await ensureOpfsWorkspace(name).catch(() => undefined);
		await this.#adopt(null, name);
		await this.refreshWorkspaces();
	}

	async createWorkspace(displayName: string): Promise<string> {
		const name = await createOpfsWorkspace(displayName);
		await this.openWorkspace(name);
		return name;
	}

	async createFolderWorkspace(displayName: string): Promise<string> {
		if (!(await this.#openFolder(chooseWorkspaceFolder))) return '';
		const wanted = displayName.trim();
		if (wanted !== '' && this.#folder?.folderReference) {
			await this.renameEntry(folderKeyOf(this.#folder), wanted);
		}
		return this.name;
	}

	async moveIntoFolder(onProgress?: TransferProgressListener): Promise<string> {
		this.#assertOwn('moved into a folder');
		this.problem = '';
		await this.session.flush().catch(() => undefined);

		const moving = this.name;
		const store = await chooseWorkspaceFolder().catch((cause: unknown) => {
			throw new Error(describeFolderProblem(cause));
		});
		if (!store) return '';

		const copied = await copyWorkspaceFiles({
			from: this.session.store,
			to: store,
			workspaceName: moving,
			onProgress
		});
		await this.#adoptFolder(store);
		return (
			`“${moving}” is now in the folder “${store.folderName}”, as ` +
			`${copied.files} ${copied.files === 1 ? 'file' : 'files'} you can see. ` +
			`The copy in browser storage is untouched and still on the Workspace list, so look in the ` +
			`folder first and delete it from there when you are satisfied.`
		);
	}

	isOpen(name: string): boolean {
		return this.backing === 'browser' && name === this.workspaceName;
	}

	get workspaceEntries(): readonly WorkspaceEntry[] {
		const browser: WorkspaceEntry[] = this.workspaces.map((name) => ({
			key: opfsWorkspaceKey(name),
			label: this.workspaceLabels[name] || name,
			kind: 'browser',
			folderName: '',
			isOpen: this.isOpen(name),
			isReviewCopy: this.reviewWorkspaces.includes(name)
		}));
		const folders: WorkspaceEntry[] = this.folderWorkspaces.map((record) => ({
			key: folderWorkspaceKey(record.reference),
			label: record.label,
			kind: 'folder',
			folderName: record.folderName,
			isOpen: this.#folder?.folderReference === record.reference,

			isReviewCopy: false
		}));
		const unrecorded: WorkspaceEntry[] =
			this.#folder?.folderReference === ''
				? [
						{
							key: folderKeyOf(this.#folder),
							label: this.folderName || 'Workspace folder',
							kind: 'folder',
							folderName: this.folderName,
							isOpen: true,
							isReviewCopy: false
						}
					]
				: [];
		return [...browser, ...folders, ...unrecorded];
	}

	async openEntry(key: string): Promise<void> {
		const named = namedWorkspaceOf(key);
		if (named !== null) {
			await this.openWorkspace(named);
			return;
		}
		const opened = await this.#openFolder(
			() => openFolderWorkspace(folderReferenceOf(key) ?? ''),
			'This computer no longer holds a grant for that folder, so it cannot be opened from the ' +
				'list. Choose it again to put it back.'
		);
		if (!opened) await this.#refreshFolderWorkspaces();
	}

	async renameEntry(key: string, label: string): Promise<boolean> {
		const wanted = label.trim();
		if (wanted === '') return false;
		const named = namedWorkspaceOf(key);
		if (named !== null) {
			remember(labelKey(named), wanted);
			await this.refreshWorkspaces();
			return this.workspaceLabels[named] === wanted;
		}
		const renamed = await renameFolderWorkspace(folderReferenceOf(key) ?? '', wanted).catch(
			() => false
		);
		await this.#refreshFolderWorkspaces();
		return renamed;
	}

	async sizeOfEntry(key: string): Promise<WorkspaceSize | null> {
		const named = namedWorkspaceOf(key);
		if (named !== null) return workspaceSize(openOpfsWorkspace(named)).catch(() => null);
		return this.#folderKey === key ? workspaceSize(this.session.store).catch(() => null) : null;
	}

	async deleteEntry(key: string): Promise<void> {
		const named = namedWorkspaceOf(key);
		if (named !== null) {
			await this.#removeWorkspace(named);
			await this.refreshWorkspaces();
			return;
		}
		if (this.#folderKey === key) {
			throw new Error(
				'This is the Workspace you are in, so it cannot be taken off the list from inside ' +
					'itself. Open another Workspace first.'
			);
		}
		await forgetFolderWorkspace(folderReferenceOf(key) ?? '');

		await this.#discardWorkspaceRecords(key);
		await this.#refreshFolderWorkspaces();
	}

	async #removeWorkspace(name: string): Promise<void> {
		if (this.isOpen(name)) {
			throw new Error(
				`“${name}” is the Workspace you are in, so it cannot be deleted from inside itself. ` +
					`Switch to another Workspace first.`
			);
		}
		await deleteOpfsWorkspace(name);
		await this.#discardWorkspaceRecords(opfsWorkspaceKey(name));

		remember(labelKey(name), null);
	}

	async #discardWorkspaceRecords(workspaceKey: string): Promise<void> {
		if (this.#journalStorage) {
			discardJournal(this.#journalStorage, workspaceKey);
			discardDeletions(this.#journalStorage, workspaceKey);
		}
		if (this.#metadataStorage) {
			await discardSynchronizationMetadata(this.#metadataStorage, workspaceKey);
			await discardLocalChanges(this.#metadataStorage, workspaceKey);
		}
	}

	async backUp(onProgress?: TransferProgressListener): Promise<WorkspaceBackup> {
		this.#assertOwn('backed up');
		await this.session.flush().catch(() => undefined);
		const backup = await exportWorkspaceTar(this.session.store, this.name, { onProgress });
		await saveFile(backup.fileName, backup.body);
		return backup;
	}

	async restoreFrom(file: File, onProgress?: TransferProgressListener): Promise<WorkspaceRestore> {
		const restored = await restoreWorkspaceTar(
			file.stream(),
			(preferred) => this.#newWorkspace(preferred),
			{
				archiveBytes: file.size,
				estimateStorage,
				onProgress
			}
		);

		await this.openWorkspace(restored.workspaceName);
		return restored;
	}

	async #transferring<T>(
		kind: TransferState['kind'],
		subject: string,
		run: (announce: Announce) => Promise<T>
	): Promise<T> {
		try {
			return await run((files, totalFiles, finished = false) => {
				this.transfer = { kind, subject, files, totalFiles, finished };
			});
		} catch (cause) {
			this.transfer = null;
			throw cause;
		}
	}

	async exportProject(project: ProjectSummary): Promise<void> {
		this.transferError = '';
		await this.#transferring('export', project.name, async (announce) => {
			await this.session.flush();
			const exported = await exportProjectBundle(this.session.store, project.directory, {
				onProgress: (progress) => announce(progress.files, progress.totalFiles)
			});
			await saveFile(exported.fileName, exported.body);
			announce(exported.totalFiles, exported.totalFiles, true);
		}).catch((cause: unknown) => {
			this.transferError = messageOf(cause);
		});
	}

	async reviewFrom(remote: ReviewReference): Promise<ReviewedProject> {
		const subject = `${describeRemote(remote)} · ${remote.project}`;
		return this.#transferring('open', subject, async (announce) => {
			const opened = await reviewFromRemote(
				async (preferred) => this.#newWorkspace(preferred, await this.#reviewOrigin()),
				{
					remote,
					estimateStorage,
					onProgress: ({ files, totalFiles }) => announce(files, totalFiles)
				}
			);

			await this.openWorkspace(opened.workspaceName);
			announce(opened.totalFiles, opened.totalFiles, true);
			return opened;
		});
	}

	async #newWorkspace(
		preferred: string,
		origin: ReviewOrigin | null = null
	): Promise<ReviewDestination> {
		const name = await createOpfsWorkspace(preferred);
		return {
			name,
			store: openOpfsWorkspace(name),
			origin,
			discard: async () => {
				if (origin?.folderReference) await releaseWorkspaceFolder(origin.folderReference);
				await deleteOpfsWorkspace(name);
				await this.refreshWorkspaces();
			}
		};
	}

	async #reviewOrigin(): Promise<ReviewOrigin | null> {
		if (this.review !== null) return this.review.origin;
		const folder = this.#folder;
		if (folder !== null) {
			const folderReference = await retainWorkspaceFolder(folder.store.folder).catch(() => null);
			if (folderReference === null) return null;
			return {
				workspaceKey: folderKeyOf(folder),
				backing: 'folder',
				name: folder.folderName,
				folderReference
			};
		}
		return {
			workspaceKey: opfsWorkspaceKey(this.workspaceName),
			backing: 'browser',
			name: this.workspaceName,
			folderReference: ''
		};
	}

	async leaveReview(): Promise<void> {
		await this.#leaveReview();
		await this.refreshWorkspaces();
	}

	async #leaveReview(): Promise<void> {
		let folderProblem = '';
		if (this.#ownFolder) {
			await this.#openFolder(
				async () => (await openFolderWorkspace(this.#ownFolder)) ?? (await reopenWorkspaceFolder())
			);
			folderProblem = this.problem;
			if (this.backing === 'folder') {
				this.workspaceName = this.#ownWorkspaceName;
				remember(OPEN_WORKSPACE_KEY, this.#ownWorkspaceName);
				return;
			}
		}
		await this.#switchTo(
			this.isOpen(this.#ownWorkspaceName)
				? await createOpfsWorkspace(this.#ownWorkspaceName)
				: this.#ownWorkspaceName
		);
		if (folderProblem) this.problem = folderProblem;
	}

	async discardReview(): Promise<void> {
		refuseOutsideReview(this.name, this.review);
		const discarding = this.workspaceName;
		const held = this.review?.origin?.folderReference ?? '';
		this.#unlist(discarding);
		await this.#leaveReview();
		await this.#removeReviewCopy(discarding, held);
		await this.refreshWorkspaces();
	}

	#unlist(workspace: string): void {
		this.workspaces = this.workspaces.filter((name) => name !== workspace);
		this.reviewWorkspaces = this.reviewWorkspaces.filter((name) => name !== workspace);
	}

	async #removeReviewCopy(workspace: string, heldFolder: string): Promise<void> {
		await this.#removeWorkspace(workspace);
		if (heldFolder) await releaseWorkspaceFolder(heldFolder).catch(() => undefined);
	}

	get importTarget(): ImportTarget | null {
		if (this.review !== null || this.unavailable !== '') return null;
		return { name: this.name, key: this.#workspaceKey };
	}

	async importRemoteProject(
		remote: ReviewReference,
		target: ImportTarget
	): Promise<ImportedIntoWorkspace> {
		return this.#importProject(
			() => readRemoteProjectSource({ remote }),
			`${describeRemote(remote)} · ${remote.project}`,
			() => this.#openImportTarget(target)
		);
	}

	async importReview(): Promise<ImportedFromReview> {
		refuseOutsideReview(this.name, this.review);
		this.#assertRecovered('copied out of');
		const mark = this.review as ReviewMark;
		const origin = reviewImportOrigin(mark);
		const reviewWorkspace = this.workspaceName;

		await this.session.flush().catch(() => undefined);
		const reopened = await this.#reopenReviewOrigin(origin);
		const source = openOpfsWorkspace(reviewWorkspace);
		const imported = await this.#importProject(
			() => readReviewWorkspaceSource({ store: source, mark }),
			describeReviewSubject(mark),
			() => Promise.resolve(reopened.into)
		);

		if (reopened.into.store instanceof ManagedProjectStore) {
			await reopened.into.store.flushChanges();
		}

		let incomplete = '';
		try {
			if (reopened.folder === null) await this.#switchTo(origin.name);
			else await this.#adoptFolder(reopened.folder);

			await this.session.open(imported.directory);
			this.#unlist(reviewWorkspace);
			await this.#removeReviewCopy(reviewWorkspace, origin.folderReference);
		} catch (cause) {
			incomplete = `${reviewCopyStillHere(reviewWorkspace, imported.name)} ${messageOf(cause)}`;
		}
		await this.refreshWorkspaces();
		return { ...imported, incomplete };
	}

	async #reopenReviewOrigin(origin: ReviewOrigin): Promise<ReopenedOrigin> {
		const folder = origin.backing === 'folder' ? await this.#regainFolder(origin) : null;
		if (folder === null && origin.backing === 'browser') {
			const existing = await listOpfsWorkspaces().catch(() => {
				refuseReviewDestination(origin, 'unreachable');
			});
			if (!existing.includes(origin.name)) refuseReviewDestination(origin, 'gone');
		}
		const raw: ProjectStore = folder ?? openOpfsWorkspace(origin.name);
		const key = folder === null ? origin.workspaceKey : folderKeyOf(await this.#identify(folder));
		const store = trackLocalChanges(raw, key, this.#metadataStorage);
		let local: readonly string[];
		try {
			local = await store.list('');
		} catch (cause) {
			refuseReviewDestination(
				origin,
				cause instanceof DOMException && cause.name === 'NotFoundError' ? 'gone' : 'unreachable'
			);
		}

		const metadata =
			this.#metadataStorage === null
				? null
				: new SynchronizationMetadata(this.#metadataStorage, key);
		const remote = (await metadata?.readRemote().catch(() => null)) ?? null;
		const baseline =
			remote === null ? null : ((await metadata?.readBaseline(remote).catch(() => null)) ?? null);

		return {
			folder,
			into: {
				name: folder === null ? origin.name : folder.folderName,
				store,
				local,
				names: (await new Workspace(store).listProjects()).map((project) => project.name),
				remote,
				baseline
			}
		};
	}

	async #regainFolder(origin: ReviewOrigin): Promise<FileSystemAccessProjectStore> {
		let folder: FileSystemAccessProjectStore | null;
		try {
			folder = await reopenRetainedWorkspaceFolder(origin.folderReference);
		} catch (cause) {
			refuseReviewDestination(
				origin,
				cause instanceof FolderPermissionDeniedError ? 'permission-denied' : 'unreachable'
			);
		}
		if (folder === null) refuseReviewDestination(origin, 'gone');
		return folder;
	}

	async #importProject(
		read: () => Promise<ProjectImportSource>,
		subject: string,
		openInto: () => Promise<ImportInto>
	): Promise<ImportedIntoWorkspace> {
		return this.#transferring('import', subject, async (announce) => {
			const source = await read();

			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			const detached = detachImportedProject(source.project, source.origin, new Date());
			const plan = await remapProjectImport({
				...source,
				project: detached,
				projectFileBytes: serialiseProjectFile(detached)
			});

			const into = await openInto();

			const evidence = await readImportEvidence(source.origin, {
				remote: into.remote,
				baseline: into.baseline,
				local: into.local,
				token: this.github.credential
			});
			const allocation = allocateProjectImport(plan.closure, {
				names: into.names,
				local: into.local,
				...evidence
			});
			const named = { ...plan.closure.project, name: allocation.name };
			const total = plan.closure.paths.length;
			announce(0, total);
			const counted: ProjectImportSource = {
				...plan.closure,
				project: named,
				projectFileBytes: serialiseProjectFile(named),
				files: () => this.#announcing(plan.closure.files(), total, announce)
			};
			await commitProjectImport(into.store, counted, allocation.destinations, {
				estimateStorage
			});

			await into.settle?.();
			announce(total, total, true);
			return { name: allocation.name, directory: allocation.directory, workspace: into.name };
		});
	}

	async *#announcing(
		files: AsyncIterable<ClosureFile>,
		total: number,
		announce: Announce
	): AsyncIterable<ClosureFile> {
		let written = 0;
		for await (const file of files) {
			written += 1;
			announce(written, total);
			yield file;
		}
	}

	async #openImportTarget(target: ImportTarget): Promise<ImportInto> {
		if (this.importTarget?.key !== target.key) {
			throw new Error(
				`“${target.name}” is not the Workspace that is open any more, so nothing has been ` +
					`Imported. Open it again and start the Import from there.`
			);
		}
		const store = this.session.store;
		return {
			name: this.name,
			store,
			local: await store.list(''),
			names: this.session.projects.map((project) => project.name),
			remote: this.remote.bound,
			baseline: this.remote.baseline,
			settle: () => this.session.refresh()
		};
	}

	get #workspaceKey(): string {
		return this.#folderKey ?? opfsWorkspaceKey(this.workspaceName);
	}

	get #folderKey(): string | null {
		return this.#folder === null ? null : folderKeyOf(this.#folder);
	}

	#assertOwn(verb: string): void {
		refuseInsideReview(this.name, this.review, verb);
		this.#assertRecovered(verb);
	}

	#assertRecovered(verb: string): void {
		if (this.unavailable === '') return;
		throw new Error(`“${this.name}” cannot be ${verb} until it opens. ${this.unavailable}`);
	}

	async #readRemote(session: EditorSession): Promise<void> {
		const remote = new Remote(session, this.#remoteHost);
		this.remote.close();
		this.remote = remote;
		if (this.unavailable !== '') return;
		await remote.load();
		this.github.refresh();
	}

	async connectNewWorkspaceTo(remote: RemoteReference): Promise<{ notice: string }> {
		const subject = describeRemote(remote);
		const name = await createOpfsWorkspace(remote.repository);
		await this.refreshWorkspaces();
		await this.openWorkspace(name);
		await this.remote.bind(remote, null);
		return {
			notice:
				`“${this.name}” is a new Workspace for ${subject}. Nothing has been ` +
				`downloaded yet — everything ${subject} holds is waiting under To get.`
		};
	}

	get backing(): WorkspaceBacking {
		return this.#folder === null ? 'browser' : 'folder';
	}

	get folderName(): string {
		return this.#folder?.folderName ?? '';
	}

	get name(): string {
		const folder = this.#folder;
		if (folder !== null) {
			const record =
				folder.folderReference === ''
					? undefined
					: this.folderWorkspaces.find((one) => one.reference === folder.folderReference);
			return record?.label || folder.folderName || 'Workspace folder';
		}
		return this.workspaceLabels[this.workspaceName] || this.workspaceName;
	}

	workspaceLabel(key: string): string {
		const folder = this.folderWorkspaces.find(
			(record) => folderWorkspaceKey(record.reference) === key
		);
		return folder === undefined ? workspaceKeyLabel(key) : folderWorkspaceLabel(folder.label);
	}

	async #adopt(folder: AdoptedFolder | null, workspaceName = this.workspaceName): Promise<void> {
		const workspaceKey = folder === null ? opfsWorkspaceKey(workspaceName) : folderKeyOf(folder);
		const leaving = this.session;

		leaving.capture();
		await leaving.flush().catch(() => undefined);
		this.#teardownFlushOnHide?.();

		const arriving = EditorSession.forWorkspace(
			folder?.store ?? openOpfsWorkspace(workspaceName),
			workspaceKey,
			this.#journalStorage,
			this.#metadataStorage
		);
		const store = arriving.store;

		const available = await this.#recoverTransfers(store);

		this.review = folder !== null || !available ? null : await this.#markOf(store);

		await this.#readRemote(arriving);

		this.#beginRecovery();
		this.session = arriving;
		this.#folder = folder;
		this.workspaceName = workspaceName;
		remember(OPEN_WORKSPACE_KEY, workspaceName);

		this.resumeFolder = '';
		const reopenable = folder ? folder.folderReference || folder.folderName : '';
		remember(OPEN_FOLDER_KEY, reopenable);
		if (this.review === null) {
			this.#ownFolder = reopenable;
			if (folder === null) this.#ownWorkspaceName = workspaceName;
			rememberOwnWorkspace(this.#ownWorkspaceName, this.#ownFolder);
		}

		this.#teardownFlushOnHide = arriving.installFlushOnHide();

		if (!available) return;
		await store.reclaimAbandonedWrites('').catch(() => undefined);

		await this.#replayAndReport().catch(() => undefined);
		this.#finishRecovery();
	}

	async #replayAndReport(): Promise<void> {
		const session = this.session;

		await session.finishInterruptedDeletions();
		await session.replayJournalledEdits();
		if (this.session === session && session.replayReport !== null) {
			await session.refresh().catch(() => undefined);
		}
	}

	#refreshOrphanedJournals(): void {
		if (this.#journalStorage === null) return;

		const known = [
			...this.workspaces.map((name) => opfsWorkspaceKey(name)),
			opfsWorkspaceKey(this.workspaceName),
			this.#workspaceKey,
			...this.folderWorkspaces.map((folder) => folderWorkspaceKey(folder.reference))
		];

		const held = [
			...journalledWorkspaces(this.#journalStorage),
			...workspacesWithDeletions(this.#journalStorage)
		];
		this.orphanedJournals = held
			.filter((key, index) => held.indexOf(key) === index && !known.includes(key))
			.sort((a, b) => a.localeCompare(b));
	}

	discardOrphanedJournal(key: string): { edits: number; deletions: number } {
		if (this.#journalStorage === null) return { edits: 0, deletions: 0 };
		const dropped = {
			edits: discardJournal(this.#journalStorage, key),
			deletions: discardDeletions(this.#journalStorage, key)
		};
		this.#refreshOrphanedJournals();
		return dropped;
	}
}

const WORKSPACE_HOST = Symbol('ballastella.workspaceHost');

class WorkspaceHost {
	storage = $state<WorkspaceStorage | null>(null);
	unsupported = $state('');

	begin(): (() => void) | undefined {
		const reason = EditorSession.unsupportedReason();
		this.unsupported = reason;
		if (reason) return undefined;
		const storage = new WorkspaceStorage();
		this.storage = storage;
		return storage.start();
	}
}

export function provideWorkspaceHost(): WorkspaceHost {
	const host = new WorkspaceHost();
	setContext(WORKSPACE_HOST, host);
	return host;
}

export function useWorkspaceHost(): WorkspaceHost {
	return getContext<WorkspaceHost>(WORKSPACE_HOST);
}

function describeFolderProblem(cause: unknown): string {
	if (cause instanceof FolderPermissionDeniedError) {
		return `${cause.message} You can choose the folder again, or keep working in browser storage.`;
	}
	return `That folder could not be opened, so your Workspace has not changed. The browser reported: ${messageOf(cause)}`;
}

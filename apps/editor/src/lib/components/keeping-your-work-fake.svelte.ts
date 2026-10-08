import type {
	ReviewMark,
	StorageAnswers,
	TransferProgressListener,
	WorkspaceBackup,
	WorkspaceRestore
} from '@ballastella/core';

import type { WorkspaceBacking } from '../workspace-storage.svelte.js';

export const backup = (over: Partial<WorkspaceBackup> = {}): WorkspaceBackup => ({
	fileName: 'My Workspace.tar',
	workspaceName: 'My Workspace',
	displayName: 'My Workspace',
	totalFiles: 4,
	totalBytes: 2048,
	body: new ReadableStream<Uint8Array>(),
	...over
});

export class FakeStorage {
	name = $state('My Workspace');
	workspaceName = $state('My Workspace');
	folderName = $state('');
	backing = $state<WorkspaceBacking>('browser');
	canChooseFolder = $state(true);
	storageAnswers = $state<StorageAnswers | null>({
		persisted: true,
		permission: 'granted',
		ephemeral: false
	});
	review = $state<ReviewMark | null>(null);
	unavailable = $state('');
	orphanedJournals = $state<string[]>([]);
	backupAnswer: WorkspaceBackup | Error = backup();
	restoreAnswer: WorkspaceRestore | Error = {
		workspaceName: 'My Workspace 2',
		backupName: 'My Workspace',
		backupDirectoryName: 'My Workspace',
		totalFiles: 4,
		totalBytes: 2048,
		projects: ['amsterdam-1625'],
		declined: [],
		notice:
			'Restored 4 files into a new Workspace called “My Workspace 2”. Turn Share Links on again to make it a site.'
	};
	moveAnswer: string | Error =
		'“My Workspace” is now in the folder “maps”, as 4 files you can see.';
	progressSteps = 2;
	discardAnswer: { edits: number; deletions: number } = { edits: 2, deletions: 0 };
	readonly discarded: string[] = [];

	workspaceLabel(key: string): string {
		return key.replace(/^opfs:/, '');
	}

	backUp(onProgress?: TransferProgressListener): Promise<WorkspaceBackup> {
		return this.#answer(this.backupAnswer, onProgress);
	}

	restoreFrom(_file: File, onProgress?: TransferProgressListener): Promise<WorkspaceRestore> {
		return this.#answer(this.restoreAnswer, onProgress);
	}

	moveIntoFolder(onProgress?: TransferProgressListener): Promise<string> {
		return this.#answer(this.moveAnswer, onProgress);
	}

	asked = 0;
	grantAnswer: StorageAnswers = { persisted: true, permission: 'granted', ephemeral: false };

	async askToKeepStorage(): Promise<void> {
		this.asked += 1;
		this.storageAnswers = this.grantAnswer;
		await Promise.resolve();
	}

	discardOrphanedJournal(key: string): { edits: number; deletions: number } {
		this.discarded.push(key);
		this.orphanedJournals = this.orphanedJournals.filter((held) => held !== key);
		return this.discardAnswer;
	}

	transfers = 0;

	async #answer<T>(answer: T | Error, onProgress?: TransferProgressListener): Promise<T> {
		this.transfers += 1;
		for (let file = 1; file <= this.progressSteps; file += 1) {
			onProgress?.({
				files: file,
				totalFiles: this.progressSteps,
				bytes: file * 512,
				totalBytes: this.progressSteps * 512,
				path: `file-${file}`
			});
		}
		await Promise.resolve();
		if (answer instanceof Error) throw answer;
		return answer;
	}
}

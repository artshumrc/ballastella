/**
 * The members of `WorkspaceStorage` that Workspace Home's *Keeping your work* section reads, as a
 * reactive fake.
 *
 * A `.svelte.ts` module rather than a plain one because what the section renders has to follow the
 * Workspace: a discarded journal leaves the list, and a move changes which Workspace is open. The
 * real class is thousands of lines over OPFS and IndexedDB, so it is not what a component seam
 * should be standing up — what a Backup, a Restore and a move actually do to a store is asserted at
 * Seam 1, and that they reach real OPFS at all is `e2e/`'s.
 */

import type {
	ReviewMark,
	StorageAnswers,
	TransferProgressListener,
	WorkspaceBackup,
	WorkspaceRestore
} from '@ballastella/core';

import type { WorkspaceBacking } from '../workspace-storage.svelte.js';

/** A backup that was written, with the totals the outcome sentence is composed from. */
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

	/** What `backUp` answers, or throws when it is an `Error`. */
	backupAnswer: WorkspaceBackup | Error = backup();
	/** What `restoreFrom` answers, or throws when it is an `Error`. */
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
	/** What `moveIntoFolder` answers, or throws when it is an `Error`. */
	moveAnswer: string | Error =
		'“My Workspace” is now in the folder “maps”, as 4 files you can see.';
	/** How many files each transfer reports before it finishes, so progress is a state and not a race. */
	progressSteps = 2;
	/** What each discard answers, and every key it was asked for. */
	discardAnswer: { edits: number; deletions: number } = { edits: 2, deletions: 0 };
	readonly discarded: string[] = [];

	workspaceLabel(key: string): string {
		return key.replace(/^opfs:/, '');
	}

	async backUp(onProgress?: TransferProgressListener): Promise<WorkspaceBackup> {
		await this.#report(onProgress);
		if (this.backupAnswer instanceof Error) throw this.backupAnswer;
		return this.backupAnswer;
	}

	async restoreFrom(file: File, onProgress?: TransferProgressListener): Promise<WorkspaceRestore> {
		void file;
		await this.#report(onProgress);
		if (this.restoreAnswer instanceof Error) throw this.restoreAnswer;
		return this.restoreAnswer;
	}

	async moveIntoFolder(onProgress?: TransferProgressListener): Promise<string> {
		await this.#report(onProgress);
		if (this.moveAnswer instanceof Error) throw this.moveAnswer;
		return this.moveAnswer;
	}

	/** Every time the author pressed for the grant, and what the browser then said. */
	asked = 0;
	/** What {@link askToKeepStorage} leaves the browser having answered. */
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

	/**
	 * How many transfers have been started, which is how "a second press starts nothing" is read.
	 *
	 * Counted on the way in rather than on the way out: what a busy control has to be shown not to do
	 * is *begin* a second one, and a call not yet recorded looks exactly like a call that was refused.
	 */
	transfers = 0;

	/** One progress report per file, so the line a scholar watches is a reading of the transfer. */
	async #report(onProgress?: TransferProgressListener): Promise<void> {
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
	}
}

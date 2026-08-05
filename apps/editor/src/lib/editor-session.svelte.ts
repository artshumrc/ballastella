import {
	Autosave,
	OpfsProjectStore,
	PathNotFoundError,
	ProjectFileUnreadableError,
	ProjectFormatTooNewError,
	Workspace,
	installFlushOnHide,
	type ProjectFile,
	type ProjectStore,
	type ProjectSummary,
	type SaveState
} from '@ballastella/core';

/**
 * Whether the workspace can be reached. Not reachable is a **normal state** with a
 * locate-again affordance, not an unhandled rejection at startup (ADR-0008): a folder gets
 * moved, renamed, deleted, or has its permission declined, and a scholar who meets a stack
 * trace at that moment reasonably concludes the tool has eaten their work.
 */
export type WorkspaceStatus = 'loading' | 'ready' | 'unreachable';

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
 */
export class EditorSession {
	readonly #workspace: Workspace;
	readonly #autosave: Autosave;

	status = $state<WorkspaceStatus>('loading');
	/** The underlying failure, shown beneath "Workspace not reachable" so it is diagnosable. */
	unreachableDetail = $state('');
	projects = $state<ProjectSummary[]>([]);
	saveState = $state<SaveState>('saved');

	/** The Project directory currently open, from `?p=`. */
	openDirectory = $state<string | null>(null);
	openProject = $state<ProjectFile | null>(null);
	projectProblem = $state<ProjectProblem | null>(null);

	constructor(store: ProjectStore) {
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
		return this.#mutate(() => this.#workspace.createProject(displayName));
	}

	async renameProject(directory: string, displayName: string): Promise<void> {
		await this.#mutate(() => this.#workspace.renameProject(directory, displayName));
		if (this.openDirectory === directory && this.openProject) {
			this.openProject = { ...this.openProject, name: displayName };
		}
	}

	async duplicateProject(directory: string): Promise<void> {
		await this.#mutate(() => this.#workspace.duplicateProject(directory));
	}

	async deleteProject(directory: string): Promise<void> {
		await this.#mutate(() => this.#workspace.deleteProject(directory));
	}

	/**
	 * Show the Project named by `?p=`.
	 *
	 * Reads and nothing else. Opening last year's work must leave every byte of it alone
	 * (ADR-0010), so there is no write anywhere on this path — not a stamped `updatedAt`, not a
	 * normalised field.
	 */
	async open(directory: string | null): Promise<void> {
		await this.flush();
		this.openDirectory = directory;
		this.openProject = null;
		this.projectProblem = null;
		if (directory === null) return;

		try {
			this.openProject = await this.#workspace.readProject(directory);
		} catch (cause) {
			if (cause instanceof ProjectFormatTooNewError) {
				this.projectProblem = { kind: 'format-too-new', message: cause.message };
			} else if (cause instanceof PathNotFoundError) {
				this.projectProblem = {
					kind: 'missing',
					message: `There is no Project called “${directory}” in this Workspace.`
				};
			} else if (cause instanceof ProjectFileUnreadableError) {
				this.projectProblem = { kind: 'unreadable', message: cause.message };
			} else {
				this.status = 'unreachable';
				this.unreachableDetail = cause instanceof Error ? cause.message : String(cause);
			}
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
		await this.#mutate(() =>
			this.#workspace.writeProject(directory, this.openProject as ProjectFile, { debounce: true })
		);
	}

	/**
	 * The edit is over — the field lost focus, or Enter was pressed. Writes now rather than on a
	 * timer, the same rule a dragged Control Point will follow on pointer-up (ADR-0017 rule 1).
	 */
	async commitProjectName(): Promise<void> {
		const directory = this.openDirectory;
		if (!directory || !this.openProject) return;
		await this.#mutate(() =>
			this.#workspace.writeProject(directory, this.openProject as ProjectFile)
		);
	}

	/** Write everything pending and wait for the store to have it. */
	async flush(): Promise<void> {
		await this.#autosave.flush();
	}

	async #mutate<T>(action: () => Promise<T>): Promise<T | null> {
		try {
			const result = await action();
			this.projects = await this.#workspace.listProjects();
			this.status = 'ready';
			this.unreachableDetail = '';
			return result;
		} catch (cause) {
			this.status = 'unreachable';
			this.unreachableDetail = cause instanceof Error ? cause.message : String(cause);
			return null;
		}
	}
}

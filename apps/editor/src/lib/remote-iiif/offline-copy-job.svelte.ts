// Making an offline copy of one referenced Historical Map: the state of that job, from the button to
// the Layer that stops saying `'referenced'` (SPEC stories 27 and 28, ADR-0007).
//
// A class of its own beside `AddRemoteMap`, and for the same reason: none of what happens before the
// copy starts is `project.json`. Re-reading the service's `info.json`, working out which of the two
// paths it takes, adding up what the Workspace already holds, and putting the library's rights
// statement in front of the user are all things that can be abandoned with nothing written.
// `EditorSession` stays the app's only writer of the document and is what does the writing at the end.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THERE ARE TWO STEPS AND NOT ONE BUTTON
//
// ADR-0007 is explicit: "the decision must not be made implicitly by a button labelled only
// 'Download'." Copying somebody else's images is per-collection acceptable rather than universally so,
// and the two things a scholar needs in order to decide are the rights statement the library published
// and what the copy costs — the host, in requests, and their own Workspace, in bytes against ADR-0008's
// ~1 GB static-hosting cliff. Neither is knowable from the Layer list, and the Manifest they came from
// has long since been navigated away from, which is why ticket 14 wrote `rights` and
// `requiredStatement` into `remote.json` at add time.
//
// So `prepare` reads and shows; `start` copies. Nothing between them writes.

import {
	crossesHostingLimit,
	describeBytes,
	estimateOfflineCopyBytes,
	hostingLimitWarning,
	planOfflineCopy,
	readRemoteImageService,
	type FetchFn,
	type OfflineCopyPlan,
	type OfflineCopyProgress,
	type ReferencedImage,
	type RemoteImageService,
	type WorkspaceSize
} from '@ballastella/core';

import type { EditorSession } from '../editor-session.svelte.js';
import { recordRemoteRequest } from './browser-test-handle.js';

/** Which step the job is on, for the region that announces it (SPEC story 96). */
export type OfflineCopyStep =
	| 'idle'
	/** Re-reading the service's `info.json` and working out what the copy will cost. */
	| 'preparing'
	/** The plan and the rights statement are on screen; the user is deciding. */
	| 'deciding'
	/** Fetching, stitching, and tiling. */
	| 'copying';

export class OfflineCopyJob {
	/**
	 * Read through a getter rather than captured, for the reason `AddRemoteMap` gives: captured, this
	 * would keep writing into the session a *previous* Project was opened with, which is a pyramid in
	 * somebody else's folder rather than an error.
	 */
	readonly #session: () => EditorSession;

	step = $state<OfflineCopyStep>('idle');
	/** The refusal to show, in the words the core modules chose. `''` when there is nothing wrong. */
	error = $state('');

	/** The image being copied, or `null` when the dialog is closed. */
	image = $state<ReferencedImage | null>(null);
	/** Its service, re-read so the pyramid geometry is the service's own and current. */
	service = $state<RemoteImageService | null>(null);
	/** What the copy will do. `null` until it has been worked out. */
	plan = $state<OfflineCopyPlan | null>(null);
	/** What the Workspace already holds. `null` until it has been measured. */
	workspace = $state<WorkspaceSize | null>(null);

	/** How far the copy has got, or `null` between jobs. */
	progress = $state<OfflineCopyProgress | null>(null);
	/**
	 * What to announce once a copy has finished, or `''`.
	 *
	 * Held on the job rather than in the dialog because the dialog closes on success: an announcement
	 * inside it would be removed from the accessibility tree in the same frame it was added, which is
	 * indistinguishable from never having been made.
	 */
	completed = $state('');
	/** How the user cancels. Replaced per job, so an old Cancel cannot abort a new copy. */
	#abort: AbortController | null = null;

	constructor(session: () => EditorSession) {
		this.#session = session;
	}

	/** Whether the dialog is open. Bound to {@link ModalDialog}. */
	get open(): boolean {
		return this.image !== null;
	}

	/** Whether a copy is in flight, so the list can refuse to start a second one. */
	get busy(): boolean {
		return this.step === 'copying';
	}

	/**
	 * A `fetch` for the library.
	 *
	 * The ADR-0011 shim, which passes every non-placeholder host straight through unmodified — the same
	 * choice `AddRemoteMap` makes, so there is one answer to "how does this app fetch an image service".
	 * Wrapped so the Playwright suite can read back every URL the remote path asked for, which is how
	 * "after the copy, nothing is requested from the library" becomes a claim about the network rather
	 * than about a variable.
	 */
	#fetch(): FetchFn {
		const shim = this.#session().imageServiceFetch();
		const through: FetchFn = shim ?? ((input, init) => fetch(input, init));
		return (input, init) => {
			recordRemoteRequest(
				typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
			);
			return through(input, init);
		};
	}

	/**
	 * Read what this copy would cost and show it. **Writes nothing.**
	 *
	 * The service's `info.json` is re-read rather than remembered from when the map was added, because
	 * the pyramid geometry is what decides between the two paths and a library may have re-tiled since.
	 * That is one request, and it is the same request the copy would have to make anyway.
	 */
	async prepare(image: ReferencedImage): Promise<void> {
		this.error = '';
		this.completed = '';
		this.image = image;
		this.service = null;
		this.plan = null;
		this.workspace = null;
		this.progress = null;
		this.step = 'preparing';

		try {
			const service = await readRemoteImageService(image.service, { fetch: this.#fetch() });
			const plan = planOfflineCopy(service);
			// Measured after the plan rather than before, so a plan that refuses outright does not walk the
			// whole Workspace for a number nobody will be shown.
			const workspace = plan.refusal === '' ? await this.#session().workspaceBytes() : null;
			// Still the same image: the user may have closed the dialog while this was in flight.
			if (this.image?.imageId !== image.imageId) return;
			this.service = service;
			this.plan = plan;
			this.workspace = workspace;
			this.step = 'deciding';
		} catch (cause) {
			this.step = 'deciding';
			this.error = message(cause);
		}
	}

	/** Close the dialog. Nothing was written, so there is nothing to undo. */
	dismiss(): void {
		if (this.busy) return;
		this.step = 'idle';
		this.error = '';
		this.image = null;
		this.service = null;
		this.plan = null;
		this.workspace = null;
		this.progress = null;
	}

	/** Abandon a copy in flight. `ingestImageFile` removes what it wrote (ticket 05). */
	cancel(): void {
		this.#abort?.abort();
	}

	/**
	 * What this copy will add to the Workspace, in bytes, or `0` when there is no plan yet.
	 *
	 * Worked out here rather than carried as a field on {@link OfflineCopyPlan}: it is a pure function of the
	 * plan's own `width` and `height`, and a stored copy of an arithmetic result is one more thing that
	 * can disagree with the numbers it came from. The three things below — the sentence, the warning,
	 * and whether there is one — then cannot be looking at different figures.
	 */
	get estimatedBytes(): number {
		return this.plan ? estimateOfflineCopyBytes(this.plan.width, this.plan.height) : 0;
	}

	/** What the copy will add, and what the Workspace holds, as a person reads it. */
	get sizeSummary(): string {
		if (!this.plan) return '';
		const held = this.workspace;
		const adding = describeBytes(this.estimatedBytes);
		return held === null
			? `This copy will add roughly ${adding}.`
			: `This copy will add roughly ${adding} to the ${describeBytes(held.bytes)} in ` +
					`${held.files.toLocaleString()} ${held.files === 1 ? 'file' : 'files'} this Workspace ` +
					`already holds.`;
	}

	/** ADR-0008's warning, or `''` when this copy stays inside the budget. */
	get hostingWarning(): string {
		if (!this.plan || this.workspace === null) return '';
		return hostingLimitWarning(this.workspace.bytes, this.estimatedBytes);
	}

	/** Whether that warning applies, for the list's own summary. */
	get crossesLimit(): boolean {
		if (!this.plan || this.workspace === null) return false;
		return crossesHostingLimit(this.workspace.bytes, this.estimatedBytes);
	}

	/** What the running copy is doing, in a sentence, for the announced status region. */
	get progressMessage(): string {
		const progress = this.progress;
		const label = this.image?.label || this.image?.imageId || 'this map';
		if (!progress) return '';
		switch (progress.phase) {
			case 'fetching':
				return progress.requestCount > 1
					? `Copying ${label}: fetched ${progress.requestsDone} of ${progress.requestCount} tiles ` +
							`from ${this.plan?.host ?? 'the library'}.`
					: `Copying ${label}: fetching the whole image from ${this.plan?.host ?? 'the library'}.`;
			case 'assembling':
				return `Copying ${label}: putting ${progress.requestCount} tiles back together.`;
			case 'tiling':
				return progress.ingest
					? `Copying ${label}: tile ${progress.ingest.tilesWritten} of ${progress.ingest.tileCount}.`
					: `Copying ${label}: cutting new tiles.`;
			case 'done':
				return `${label} is now an offline copy in this Project.`;
		}
	}

	/**
	 * Make the copy (SPEC stories 27, 28).
	 *
	 * Through `EditorSession`, because it is the app's only writer of `project.json` — the rule this
	 * epic has broken more often than any other. The plan that was on screen is the plan that runs.
	 *
	 * @returns `true` when the copy landed
	 */
	async start(): Promise<boolean> {
		const image = this.image;
		const service = this.service;
		const plan = this.plan;
		if (!image || !service || !plan || plan.refusal !== '' || this.busy) return false;

		const abort = new AbortController();
		this.#abort = abort;
		this.error = '';
		this.step = 'copying';
		this.progress = null;

		try {
			const copied = await this.#session().makeOfflineCopy({
				image,
				service,
				plan,
				onProgress: (progress) => {
					this.progress = progress;
				},
				signal: abort.signal
			});
			if (!copied) {
				this.step = 'deciding';
				this.error = this.#session().saveError || 'The offline copy could not be recorded.';
				return false;
			}
			// The outcome is announced by the list rather than by the dialog, so that closing the dialog
			// does not take the announcement away with it — and so a screen-reader user is told the copy
			// finished rather than being told nothing while the focus moves back to the button.
			this.completed = `${image.label || image.imageId} is now an offline copy in this Project.`;
			this.step = 'idle';
			this.image = null;
			this.service = null;
			this.plan = null;
			this.workspace = null;
			this.progress = null;
			return true;
		} catch (cause) {
			this.step = 'deciding';
			this.progress = null;
			this.error = abort.signal.aborted
				? `The copy was cancelled. Nothing was added, and ${image.label || image.imageId} still ` +
					`works — it is read from ${plan.host} as before.`
				: message(cause);
			return false;
		} finally {
			this.#abort = null;
		}
	}
}

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

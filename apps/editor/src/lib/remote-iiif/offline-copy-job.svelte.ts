import {
	describeBytes,
	estimateOfflineCopyBytes,
	hostingLimitWarning,
	planOfflineCopy,
	readRemoteImageService,
	messageOf,
	type FetchFn,
	type OfflineCopyPlan,
	type OfflineCopyProgress,
	type ReferencedImage,
	type RemoteImageService,
	type WorkspaceSize,
	workspaceSize
} from '@ballastella/core';

import type { EditorSession } from '../editor-session.svelte.js';
import { recordingFetch } from '../browser-test-handles.js';

export class OfflineCopyJob {
	readonly #session: () => EditorSession;
	step = $state<'idle' | 'preparing' | 'deciding' | 'copying'>('idle');
	error = $state('');
	image = $state<ReferencedImage | null>(null);
	service = $state<RemoteImageService | null>(null);
	plan = $state<OfflineCopyPlan | null>(null);
	workspace = $state<WorkspaceSize | null>(null);
	progress = $state<OfflineCopyProgress | null>(null);
	completed = $state('');
	#abort: AbortController | null = null;

	constructor(session: () => EditorSession) {
		this.#session = session;
	}

	get open(): boolean {
		return this.image !== null;
	}

	get busy(): boolean {
		return this.step === 'copying';
	}

	#fetch(): FetchFn {
		return recordingFetch(this.#session().imageServiceFetch());
	}

	#forget(): void {
		this.image = null;
		this.service = null;
		this.plan = null;
		this.workspace = null;
		this.progress = null;
	}

	async prepare(image: ReferencedImage): Promise<void> {
		this.#forget();
		this.error = '';
		this.completed = '';
		this.image = image;
		this.step = 'preparing';

		try {
			const service = await readRemoteImageService(image.service, { fetch: this.#fetch() });
			const plan = planOfflineCopy(service);
			const workspace = plan.refusal === '' ? await workspaceSize(this.#session().store) : null;
			if (this.image?.imageId !== image.imageId) return;
			this.service = service;
			this.plan = plan;
			this.workspace = workspace;
			this.step = 'deciding';
		} catch (cause) {
			this.step = 'deciding';
			this.error = messageOf(cause);
		}
	}

	dismiss(): void {
		if (this.busy) return;
		this.step = 'idle';
		this.error = '';
		this.#forget();
	}

	cancel(): void {
		this.#abort?.abort();
	}

	get estimatedBytes(): number {
		return this.plan ? estimateOfflineCopyBytes(this.plan.width, this.plan.height) : 0;
	}

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

	get hostingWarning(): string {
		if (!this.plan || this.workspace === null) return '';
		return hostingLimitWarning(this.workspace.bytes, this.estimatedBytes);
	}

	get progressMessage(): string {
		const progress = this.progress;
		if (!progress) return '';
		const label = this.image ? nameOf(this.image) : 'this map';
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
				return copiedNotice(label);
		}
	}

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
			this.completed = copiedNotice(nameOf(image));
			this.step = 'idle';
			this.#forget();
			return true;
		} catch (cause) {
			this.step = 'deciding';
			this.progress = null;
			this.error = abort.signal.aborted
				? `The copy was cancelled. Nothing was added, and ${nameOf(image)} still ` +
					`works — it is read from ${plan.host} as before.`
				: messageOf(cause);
			return false;
		} finally {
			this.#abort = null;
		}
	}
}

const nameOf = (image: ReferencedImage): string => image.label || image.imageId;
const copiedNotice = (name: string): string => `${name} is now an offline copy in this Project.`;

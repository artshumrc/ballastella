import {
	count,
	describeBytes,
	describeTileBudget,
	fetchTilesIntoCache,
	messageOf,
	offlineCoverage,
	projectOpeningBounds,
	readCachedTileSource,
	tileBudgetRefusal,
	writeCachedTileSource,
	type BaseMapEntry,
	type GeoBounds,
	type Layer,
	type OfflineCoverage
} from '@ballastella/core';

import { openArchiveTiles } from './archive-tiles';
import { readProjectContent } from './opening-view';
import type { EditorSession } from '../editor-session.svelte.js';

type OfflineStep = 'idle' | 'inspecting' | 'deciding' | 'fetching';

export class MakeProjectOffline {
	readonly #session: () => EditorSession;
	step = $state<OfflineStep>('idle');
	open = $state(false);
	error = $state('');
	coverage = $state.raw<OfflineCoverage | null>(null);
	bounds = $state.raw<GeoBounds | null>(null);
	progress = $state.raw<{ done: number; total: number; bytes: number } | null>(null);
	completed = $state('');
	#abort: AbortController | null = null;
	#layers: readonly Layer[] = [];

	constructor(session: () => EditorSession) {
		this.#session = session;
	}

	get busy(): boolean {
		return this.step === 'fetching';
	}

	get available(): boolean {
		return this.coverage?.complete === true;
	}

	get refused(): boolean {
		return this.coverage?.budget.overThreshold === true;
	}

	get refusal(): string {
		const budget = this.coverage?.budget;
		return budget ? tileBudgetRefusal(budget) : '';
	}

	get budgetSummary(): string {
		const budget = this.coverage?.budget;
		return budget ? describeTileBudget(budget) : '';
	}

	get progressSummary(): string {
		const running = this.progress;
		if (running) {
			return `Fetched ${running.done} of ${running.total} tiles, ${describeBytes(running.bytes)} so far.`;
		}
		const coverage = this.coverage;
		if (!coverage) return '';
		if (coverage.budget.count === 0) {
			return 'This Project has nothing placed on the earth yet, so there is no area to make available offline.';
		}
		if (coverage.complete) {
			return `Available offline: all ${coverage.budget.count} Base Map tiles this Project's work covers are in this Workspace.`;
		}
		return (
			`Not available offline: ${coverage.present} of ${coverage.budget.count} Base Map tiles this ` +
			`Project's work covers are in this Workspace, and ${coverage.missing.length} ` +
			`${coverage.missing.length === 1 ? 'is' : 'are'} still missing.`
		);
	}

	async inspect(entry: BaseMapEntry, layers: readonly Layer[]): Promise<void> {
		const session = this.#session();
		this.step = 'inspecting';
		this.#layers = layers;
		this.error = '';
		this.progress = null;
		try {
			const bounds = projectOpeningBounds(await readProjectContent(session, layers));
			this.bounds = bounds;
			if (bounds === null) {
				this.coverage = null;
				this.step = 'deciding';
				return;
			}
			const archive = await openArchiveTiles(entry);
			this.coverage = await offlineCoverage(session.store, entry.archive, bounds, archive.maxZoom);
			this.step = 'deciding';
		} catch (cause) {
			this.coverage = null;
			this.step = 'idle';
			this.error =
				`The Base Map could not be read, so there is no way to say what making this Project ` +
				`available offline would take. ${messageOf(cause)}`;
		}
	}

	async ask(entry: BaseMapEntry, layers: readonly Layer[]): Promise<void> {
		this.completed = '';
		this.open = true;
		await this.inspect(entry, layers);
	}

	dismiss(): void {
		if (this.busy) return;
		this.open = false;
		this.step = 'idle';
	}

	async start(entry: BaseMapEntry): Promise<void> {
		const coverage = this.coverage;
		if (!coverage || this.busy) return;
		if (coverage.budget.overThreshold) {
			this.error = tileBudgetRefusal(coverage.budget);
			return;
		}

		const session = this.#session();
		const abort = new AbortController();
		this.#abort = abort;
		this.step = 'fetching';
		this.error = '';
		this.completed = '';
		this.progress = { done: 0, total: coverage.missing.length, bytes: 0 };

		try {
			const archive = await openArchiveTiles(entry);
			const result = await fetchTilesIntoCache({
				store: session.store,
				archive: entry.archive,
				tiles: coverage.missing,
				readTile: (tile) => archive.readTile(tile),
				signal: abort.signal,
				onProgress: (progress) => (this.progress = progress)
			});
			await writeCachedTileSource(session.store, {
				archive: entry.archive,
				maxZoom: archive.maxZoom
			});
			this.progress = null;
			this.step = 'idle';
			await this.inspect(entry, this.#layers);
			this.completed = result.cancelled
				? `Stopped after ${result.written} of ${coverage.missing.length} tiles, ${describeBytes(result.bytes)}. The tiles already fetched are kept, and starting again will fetch only what is left.`
				: `Fetched ${count(result.written, 'tile')}, ${describeBytes(result.bytes)}. ${this.available ? 'This Project is now available offline.' : 'Some tiles are not in the Base Map at all, so parts of this area will be blank.'}`;
			if (!result.cancelled && this.available) this.open = false;
		} catch (cause) {
			this.progress = null;
			this.step = 'deciding';
			this.error =
				`The Base Map tiles could not be fetched. Nothing already in this Workspace has been lost, ` +
				`and starting again will fetch only what is missing. ${messageOf(cause)}`;
		} finally {
			this.#abort = null;
		}
	}

	cancel(): void {
		this.#abort?.abort();
	}
}

export async function readOfflineCoverage(
	session: EditorSession,
	entry: BaseMapEntry,
	layers: readonly Layer[]
): Promise<{ bounds: GeoBounds | null; coverage: OfflineCoverage | null; fromRecord: boolean }> {
	const bounds = projectOpeningBounds(await readProjectContent(session, layers));
	if (bounds === null) return { bounds: null, coverage: null, fromRecord: false };
	const depth = await sourceMaxZoom(session, entry);
	return {
		bounds,
		coverage: await offlineCoverage(session.store, entry.archive, bounds, depth.maxZoom),
		fromRecord: depth.fromRecord
	};
}

async function sourceMaxZoom(
	session: EditorSession,
	entry: BaseMapEntry
): Promise<{ maxZoom: number; fromRecord: boolean }> {
	try {
		return { maxZoom: (await openArchiveTiles(entry)).maxZoom, fromRecord: false };
	} catch (cause) {
		const recorded = await readCachedTileSource(session.store, entry.archive);
		if (recorded) return { maxZoom: recorded.maxZoom, fromRecord: true };
		throw cause;
	}
}

// "Make this Project available offline": the state of that job, from the button to the last tile
// (ADR-0025, SPEC stories 70–73).
//
// A class of its own beside `MirrorMap`, and shaped like it deliberately — the two are the same
// decision about two different servers, and ADR-0007's rule governs both: **the cost is stated before
// it is spent, and the decision is never made implicitly by a button.** So `inspect` reads and shows;
// `start` fetches. Nothing between them writes a byte.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// "AVAILABLE OFFLINE" IS COMPUTED HERE TOO, AND THAT IS NOT AN IMPLEMENTATION DETAIL
//
// Nothing on this object is persisted and nothing about it is written into `project.json`. The answer
// comes from `offlineCoverage`, which asks which files exist. That is what makes the four awkward
// criteria fall out rather than needing code each: a second Project in the same city is already
// offline because the tiles are there; a Project whose work has since spread is not, because the new
// tiles are not; clearing the cache from the hub unmakes every claim at once; and re-running fetches
// only what is missing, because "what is missing" is the same question asked again.
//
// The one thing to be careful of is staleness in the other direction — this object holds an answer
// from a moment ago, and the hub can clear the cache in another tab. {@link inspect} is therefore
// re-run whenever the Project's own content changes and after every action here, and the numbers on
// screen are always the last read rather than a running tally.

import {
	OFFLINE_TILE_LIMIT,
	archiveUrl,
	cachedTilesMatchArchive,
	describeBytes,
	describeTileBudget,
	projectOpeningBounds,
	tileBudgetRefusal,
	type BaseMapEntry,
	type GeoBounds,
	type Layer,
	type OfflineCoverage
} from '@ballastella/core';

import { openArchiveTiles } from './archive-tiles';
import { resolveDeploymentAsset } from './deployment-assets';
import { readProjectContent } from './opening-view';
import type { EditorSession } from '../editor-session.svelte.js';

/** Which step the job is on, for the region that announces it (SPEC story 112). */
export type OfflineStep =
	| 'idle'
	/** Opening the archive and counting what the extent needs. Nothing has been written. */
	| 'inspecting'
	/** The count, the estimate, and any refusal are on screen; the user is deciding. */
	| 'deciding'
	/** Fetching tiles into the Workspace. */
	| 'fetching';

export class MakeProjectOffline {
	/** Read through a getter, so a job never writes into the session a previous Project was opened with. */
	readonly #session: () => EditorSession;

	step = $state<OfflineStep>('idle');
	/** Whether the dialog is open. The step alone cannot say: `idle` is both before and after. */
	open = $state(false);
	/** What went wrong, in the words the core modules chose. `''` when nothing did. */
	error = $state('');

	/** What the extent needs and how much of it is here, or `null` before anything has looked. */
	coverage = $state.raw<OfflineCoverage | null>(null);
	/** The box the Project's own content occupies, or `null` when it has none on the earth. */
	bounds = $state.raw<GeoBounds | null>(null);

	/** How far the fetch has got, or `null` between jobs. */
	progress = $state.raw<{ done: number; total: number; bytes: number } | null>(null);
	/**
	 * What to announce once a run has finished, or `''`.
	 *
	 * On the job rather than in the dialog, for the reason `MirrorMap.completed` is: the dialog closes
	 * on success, and an announcement inside it would leave the accessibility tree in the frame it
	 * entered — indistinguishable from never having been made.
	 */
	completed = $state('');

	#abort: AbortController | null = null;

	/**
	 * The Layers the last count was taken over, so a re-count after fetching frames the same Project.
	 *
	 * Held rather than re-derived because {@link start} has to ask the same question again — and the
	 * first version of this passed an empty list, which computed no bounds, reported the Project as
	 * having nothing on the earth, and so said nothing about the tiles it had just fetched.
	 */
	#layers: readonly Layer[] = [];

	constructor(session: () => EditorSession) {
		this.#session = session;
	}

	get busy(): boolean {
		return this.step === 'fetching';
	}

	/** Whether this Project is available offline right now. Computed; never a stored flag. */
	get available(): boolean {
		return this.coverage?.complete === true;
	}

	/** Whether the request is refused for being too large, so the start button is not offered. */
	get refused(): boolean {
		return this.coverage?.budget.overThreshold === true;
	}

	/** The refusal, with the numbers and the explanation, or `''` (ADR-0007, ADR-0025). */
	get refusal(): string {
		const budget = this.coverage?.budget;
		return budget ? tileBudgetRefusal(budget) : '';
	}

	/** The count and the estimate, before anything is fetched. `''` until something has looked. */
	get budgetSummary(): string {
		const budget = this.coverage?.budget;
		return budget ? describeTileBudget(budget) : '';
	}

	/** How much of the budget is already here, in words, or `''`. */
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

	/**
	 * Count what this Project's extent needs and how much of it is already here. **Writes nothing.**
	 *
	 * `entry` is the Base Map the Project is showing: the archive is what says how deep the pyramid
	 * goes, and ADR-0025's "every zoom from 0 to the source's maximum" is meaningless without asking
	 * it. That makes this a network call, which is why it is a step with its own state rather than a
	 * synchronous computation — and why it is the *first* thing the dialog does rather than something
	 * the button does behind a spinner.
	 */
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
				// Nothing on the earth. Not an error, and not "available offline" either: there is no
				// extent to make the claim about, and `progressSummary` says so in those words.
				this.coverage = null;
				this.step = 'deciding';
				return;
			}
			const archive = await openArchiveTiles(entry);
			this.coverage = await session.offlineBaseMapCoverage(bounds, archive.maxZoom);
			this.step = 'deciding';
		} catch (cause) {
			this.coverage = null;
			this.step = 'idle';
			this.error =
				`The Base Map could not be read, so there is no way to say what making this Project ` +
				`available offline would take. ${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}

	/** Open the dialog on a fresh count. */
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

	/**
	 * Fetch the missing tiles.
	 *
	 * **Only the missing ones**, from the coverage the user was shown — so the number they agreed to is
	 * the number of requests made, and re-running after a cancelled run costs only what is left
	 * (ADR-0025: do not refetch tiles already in the cache).
	 *
	 * Refuses outright above the threshold rather than trusting the dialog to have hidden the button.
	 * The refusal is a contract about somebody else's server, and a guard that lives only in markup is
	 * one route away from being absent.
	 */
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
			const result = await session.fetchBaseMapTiles({
				tiles: coverage.missing,
				readTile: (tile) => archive.readTile(tile),
				signal: abort.signal,
				onProgress: (progress) => (this.progress = progress)
			});
			// Which archive filled the cache, and how deep *it* said it went — written from the header
			// that was just read, while the network is still here. This is what lets the screen answer
			// "is this Project available offline?" with no connection at all; see {@link sourceMaxZoom}.
			// Written even for a cancelled run: the tiles a cancelled run wrote are kept, so their
			// provenance is as true as a finished run's.
			await session.recordBaseMapTileSource({
				archive: archiveUrl(entry, resolveDeploymentAsset),
				maxZoom: archive.maxZoom
			});
			this.progress = null;
			this.step = 'idle';
			// Re-read rather than reasoned about: whether the Project is now available offline is a
			// question about the files, and a tally kept here would be a second answer to it.
			await this.inspect(entry, this.#layers);
			this.completed = result.cancelled
				? `Stopped after ${result.written} of ${coverage.missing.length} tiles, ${describeBytes(result.bytes)}. The tiles already fetched are kept, and starting again will fetch only what is left.`
				: `Fetched ${result.written} ${result.written === 1 ? 'tile' : 'tiles'}, ${describeBytes(result.bytes)}. ${this.available ? 'This Project is now available offline.' : 'Some tiles are not in the Base Map at all, so parts of this area will be blank.'}`;
			if (!result.cancelled && this.available) this.open = false;
		} catch (cause) {
			this.progress = null;
			this.step = 'deciding';
			this.error =
				`The Base Map tiles could not be fetched. Nothing already in this Workspace has been lost, ` +
				`and starting again will fetch only what is missing. ` +
				`${cause instanceof Error ? cause.message : String(cause)}`;
		} finally {
			this.#abort = null;
		}
	}

	cancel(): void {
		this.#abort?.abort();
	}

	/** The threshold, for the sentence that explains the limit before it is met. */
	readonly limit = OFFLINE_TILE_LIMIT;
}

/**
 * `inspect` again after an action, without the dialog.
 *
 * The Project screen needs the computed answer whether or not anybody has opened the dialog — "is
 * this Project available offline?" is a line beside the map, not a thing you have to ask for.
 */
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
		coverage: await session.offlineBaseMapCoverage(bounds, depth.maxZoom),
		fromRecord: depth.fromRecord
	};
}

/**
 * How deep the source pyramid goes — **without the network when the cache already knows** (ADR-0025).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT JUST `openArchiveTiles(entry).maxZoom`
 *
 * It was, and that made "is this Project available offline?" a question needing a live PMTiles header
 * fetch — on every Project open, every Base Map change, and every document change. So with no
 * connection the screen said the answer could not be checked, which is the exact state the feature
 * exists to remove. It is also what forced `editor-remote-iiif.e2e.ts` to start routing the archive.
 *
 * The record beside the tiles carries the number the archive's own header gave at fetch time, so
 * using it offline is not a claim computed from our own files — that would be
 * `baseMapCacheSize().maxZoom`, which can only under-report a half-filled cache and is right for
 * *drawing* and wrong for *claiming*.
 *
 * **The archive is still asked first when it can be reached.** The record is a snapshot: a repointed
 * catalog entry, or an archive rebuilt a zoom deeper, makes it stale, and preferring it would mean a
 * Project reporting itself complete against a pyramid that has moved. Online, the source answers;
 * offline, the last thing the source said answers; and the caller is told which, so the sentence
 * beside the map can be honest about it.
 *
 * ⚠ A record naming a **different archive** is not used at all. `base-map/tiles/` carries no archive
 * in its path, so a deployment giving two catalog entries two archives has one directory serving
 * both — see the note in `offline-cache.ts` for why detection rather than keying, and why ticket 12
 * is where keying belongs.
 */
async function sourceMaxZoom(
	session: EditorSession,
	entry: BaseMapEntry
): Promise<{ maxZoom: number; fromRecord: boolean }> {
	try {
		return { maxZoom: (await openArchiveTiles(entry)).maxZoom, fromRecord: false };
	} catch (cause) {
		const recorded = await session.cachedBaseMapTileSource();
		if (recorded && cachedTilesMatchArchive(recorded, archiveUrl(entry, resolveDeploymentAsset))) {
			return { maxZoom: recorded.maxZoom, fromRecord: true };
		}
		throw cause;
	}
}

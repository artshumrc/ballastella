import type { FetchFn } from '../injection/store-image-fetch.js';
import { messageOf } from '../store/project-store.js';
import {
	describeReset,
	githubFetch,
	parseTree,
	problemOf,
	rateLimitOf,
	repoApiUrl
} from './github-api.js';
import { describeRemote, type RemoteRepository } from './remote-binding.js';
import { RemoteTreeRefusedError, readRemoteTree } from './remote-tree.js';
import type { InventoryEntry, SourceStatus } from './synchronization-planner.js';

export const REMOTE_STATUS_LABELS: Record<SourceStatus, string> = {
	'in-sync': 'In sync',
	'changes-to-send': 'Changes to send',
	'changes-to-get': 'Changes to get',
	'changes-both-ways': 'Changes both ways',
	'cannot-tell': 'Cannot tell'
};

export const REMOTE_STATUS_UNCHECKED = 'Not checked yet';

export type RemoteStatusRefusal =
	| 'unreachable'
	| 'credential'
	| 'rate-limited'
	| 'no-repository'
	| 'not-public'
	| 'truncated'
	| 'refused';

export class RemoteStatusUnavailableError extends Error {
	override readonly name = 'RemoteStatusUnavailableError';
	constructor(
		readonly refusal: RemoteStatusRefusal,
		message: string
	) {
		super(message);
	}
}

export function anonymousDetermination(refusal: RemoteStatusRefusal): SourceStatus | null {
	return refusal === 'no-repository' || refusal === 'not-public' ? 'cannot-tell' : null;
}

interface RemoteInventoryOptions {
	readonly remote: RemoteRepository;
	readonly token: string | null;
	readonly fetch?: FetchFn;
}

export async function readRemoteInventory(
	options: RemoteInventoryOptions
): Promise<readonly InventoryEntry[]> {
	return options.token === null ? anonymousInventory(options) : credentialedInventory(options);
}

async function anonymousInventory(
	options: RemoteInventoryOptions
): Promise<readonly InventoryEntry[]> {
	try {
		const blobs = await readRemoteTree(options.remote, options.fetch);
		return blobs.map((blob) => ({ path: blob.path, sha: blob.sha }));
	} catch (cause) {
		if (!(cause instanceof RemoteTreeRefusedError)) throw cause;
		if (cause.refusal === 'empty') return [];
		throw new RemoteStatusUnavailableError(
			cause.refusal,
			refusalSentence(options.remote, cause.refusal, cause.detail, cause.resetAt)
		);
	}
}

async function credentialedInventory(
	options: RemoteInventoryOptions
): Promise<readonly InventoryEntry[]> {
	const { remote } = options;
	const refuse = (refusal: RemoteStatusRefusal, detail = '', resetAt: Date | null = null) =>
		new RemoteStatusUnavailableError(refusal, refusalSentence(remote, refusal, detail, resetAt));

	const url = `${repoApiUrl(remote)}/git/trees/${encodeURIComponent(remote.branch)}?recursive=1`;
	const response = await githubFetch(
		options.fetch,
		options.token
	)(url).catch((cause: unknown) => {
		throw refuse('unreachable', messageOf(cause));
	});

	if (response.status === 409) return [];
	if (response.status === 401) throw refuse('credential');
	if (response.status === 403) {
		const budget = rateLimitOf(response.headers);
		if (budget.remaining === 0) throw refuse('rate-limited', '', budget.resetAt);
		throw refuse('refused', await problemOf(response));
	}
	if (response.status === 404) throw refuse('no-repository');
	if (!response.ok) throw refuse('refused', await problemOf(response));

	const { entries, truncated } = parseTree(await response.json().catch(() => ({})));
	if (truncated) throw refuse('truncated');
	return entries.filter((entry) => entry.type === 'blob').map(({ path, sha }) => ({ path, sha }));
}

function refusalSentence(
	remote: RemoteRepository,
	refusal: RemoteStatusRefusal,
	detail: string,
	resetAt: Date | null
): string {
	const kept = 'The status beside this is the last one Ballastella was able to work out.';
	const named = describeRemote(remote);
	switch (refusal) {
		case 'unreachable':
			return `Ballastella could not reach GitHub to check ${named}${detail === '' ? '' : `: ${detail}`}. ${kept}`;
		case 'credential':
			return `GitHub would not accept this browser's credential, so ${named} could not be checked. Sign in again. ${kept}`;
		case 'rate-limited': {
			const at = describeReset(resetAt);
			return (
				`GitHub's hourly request limit is used up, so ${named} could not be checked` +
				`${at === '' ? '' : ` until ${at}`}. ${kept}`
			);
		}
		case 'no-repository':
			return `GitHub has no ${named} that this browser can see, so it could not be checked. ${kept}`;
		case 'not-public':
			return `${named} is not readable without signing in, so it could not be checked. Sign in to GitHub to check it. ${kept}`;
		case 'truncated':
			return `GitHub could only list part of ${named}, so its status cannot be worked out from it. ${kept}`;
		default:
			return `GitHub refused to list ${named}${detail === '' ? '' : `: ${detail}`}. ${kept}`;
	}
}

export type RemoteStatusTrigger = 'open' | 'focus' | 'explicit';

export type RemoteStatusObservation =
	| {
			readonly outcome: 'determined';
			readonly status: SourceStatus;
			readonly publishedSiteStale: readonly string[];
			readonly shareLinks: boolean;
			// False when settled without a request, so it must not restart the interval.
			readonly requested: boolean;
	  }
	| { readonly outcome: 'not-attempted' };

export interface RemoteStatusState {
	readonly status: SourceStatus | null;
	readonly at: number | null;
	readonly checking: boolean;
	readonly failure: string;
	readonly publishedSiteStale: readonly string[];
	readonly shareLinks: boolean;
}

export const UNCHECKED_REMOTE_STATUS: RemoteStatusState = {
	status: null,
	at: null,
	checking: false,
	failure: '',
	publishedSiteStale: [],
	shareLinks: false
};

export const AUTOMATIC_CHECK_INTERVAL_MS = 60_000;

interface RemoteStatusCheckerOptions {
	// null, not 'not-attempted': a check that never happens must not announce itself.
	readonly observe: (trigger: RemoteStatusTrigger) => Promise<RemoteStatusObservation> | null;
	readonly now: () => number;
	readonly interval?: number;
	readonly onChange?: (state: RemoteStatusState) => void;
}

export class RemoteStatusChecker {
	readonly #observe: (trigger: RemoteStatusTrigger) => Promise<RemoteStatusObservation> | null;
	readonly #now: () => number;
	readonly #interval: number;
	readonly #onChange: ((state: RemoteStatusState) => void) | undefined;
	#state: RemoteStatusState = UNCHECKED_REMOTE_STATUS;
	#running: Promise<void> | null = null;
	#lastAttempt = Number.NEGATIVE_INFINITY;
	#closed = false;

	constructor(options: RemoteStatusCheckerOptions) {
		this.#observe = options.observe;
		this.#now = options.now;
		this.#interval = options.interval ?? AUTOMATIC_CHECK_INTERVAL_MS;
		this.#onChange = options.onChange;
	}

	get state(): RemoteStatusState {
		return this.#state;
	}

	check(trigger: RemoteStatusTrigger): Promise<void> {
		if (this.#closed) return Promise.resolve();
		if (this.#running !== null) return this.#running;
		if (trigger !== 'explicit' && this.#now() - this.#lastAttempt < this.#interval) {
			return Promise.resolve();
		}
		const observation = this.#observe(trigger);
		if (observation === null) return Promise.resolve();
		this.#announce({ ...this.#state, checking: true });
		const settled: Promise<void> = observation
			.then(
				(found) => this.#settle(found),
				(cause: unknown) => this.#refuse(cause)
			)
			.finally(() => {
				if (this.#running === settled) this.#running = null;
			});
		this.#running = settled;
		return settled;
	}

	close(): void {
		this.#closed = true;
		this.#running = null;
	}

	#settle(found: RemoteStatusObservation): void {
		if (this.#closed) return;
		if (found.outcome === 'not-attempted') {
			this.#announce({ ...this.#state, checking: false });
			return;
		}
		if (found.requested) this.#lastAttempt = this.#now();
		this.#announce({
			status: found.status,
			at: this.#now(),
			checking: false,
			failure: '',
			publishedSiteStale: found.publishedSiteStale,
			shareLinks: found.shareLinks
		});
	}

	#refuse(cause: unknown): void {
		if (this.#closed) return;
		this.#lastAttempt = this.#now();
		this.#announce({
			...this.#state,
			checking: false,
			failure: messageOf(cause)
		});
	}

	#announce(state: RemoteStatusState): void {
		this.#state = state;
		this.#onChange?.(state);
	}
}

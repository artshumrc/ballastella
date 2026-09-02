// The Remote Status a scholar reads, and the bounded checking that keeps it true (ADR-0038).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// OBSERVATIONAL, AND THAT IS THE WHOLE CONTRACT
//
// A check lists what the Remote holds. It downloads no file bytes, writes nothing to the Workspace,
// writes nothing to the Remote, and — the one that matters most — never advances a Synchronization
// Baseline: a status check never advances it, so that checking cannot hide drift. A check that
// recorded what it saw would turn somebody else's afternoon into this machine's own evidence, and the
// next Publish would delete it as an ordinary removal.
//
// The local half is `local-change-index.ts`, which answers what changed here without reading a
// gigabyte; the comparison is `synchronization-planner.ts`, which is pure. What is left for this
// module is the two things neither of those can do: one listing of the Remote, and *when* to take it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE WORDS, HERE AND NOWHERE ELSE
//
// `SourceStatus` is six stable values and deliberately carries no sentence. {@link
// REMOTE_STATUS_LABELS} is the projection into the six a user reads, and it lives beside the checker
// rather than in a component so that a second surface cannot spell one of them differently. The
// meaning is in the text, never in a colour, an icon or a disabled button.
//
// ⚠ **The repository's name belongs to `In sync` and to no other determination** (ADR-0044). Naming
// it beside a state that is not agreement reports an intention rather than a fact, so the name is
// interpolated by the badge that renders the agreeing clause and appears in none of the words here.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// SIGNED OUT MEANS ASKED FOR, NEVER POLLED
//
// A signed-out user may check a public Remote explicitly. Automatic anonymous polling is ruled out
// for a reason with a number on it — GitHub allows an anonymous reader sixty requests an
// hour *per IP address*, so a lecture theatre on one campus address polling on every window focus
// spends the room's whole budget on status checks and then cannot open a Workspace at all. So the
// trigger decides: `'explicit'` may read a public Remote anonymously, and an automatic check that
// would need a request it may not make is *not attempted* — see {@link RemoteStatusChecker.check}.

import { GITHUB_API_ORIGIN, describeReset, headerNumber, rateLimitOf } from './github-api.js';
import { describeRemote } from './remote-binding.js';
import { RemoteTreeRefusedError, readRemoteTree, urlPath } from './remote-tree.js';
import type { RemoteTreeRefusal } from './remote-tree.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import type { RemoteRepository } from './publish-to-remote.js';
import type { InventoryEntry, SourceStatus } from './synchronization-planner.js';

/**
 * The six words a scholar reads, one per {@link SourceStatus}.
 *
 * ⚠ **Every one of them says which direction is outstanding**, because that is the only thing a
 * scholar can act on: something to send, something to get, both, or neither. Git's `ahead` and
 * `behind` name positions in a commit graph nobody here is looking at, and *connected* and *up to
 * date* both report a relationship rather than whether the work is anywhere but this machine
 * (ADR-0044).
 *
 * ⚠ **`Cannot tell` is a determination and is worded as one.** It is what absence, corruption, a
 * record naming another repository and a Baseline this browser refused to keep all come to, and every
 * one of them means *nothing here can say how the two sides differ*. Shown as nothing at all — or as
 * a greyed-out control — it reads as agreement, which is the one reading that licenses overwriting.
 */
export const REMOTE_STATUS_LABELS: Record<SourceStatus, string> = {
	'in-sync': 'In sync',
	'changes-to-send': 'Changes to send',
	'changes-to-get': 'Changes to get',
	'changes-both-ways': 'Changes both ways',
	conflict: 'Conflict',
	'cannot-tell': 'Cannot tell'
};

/** What a control says before there has been a determination at all. Never one of the six. */
export const REMOTE_STATUS_UNCHECKED = 'Not checked yet';

// ── One observational listing ─────────────────────────────────────────────────────────────────

/** Why a Remote's file list could not be had, for the sentence the reader gets. */
export type RemoteStatusRefusal =
	/** The request never got an answer: offline, or a network that dropped it. */
	| 'unreachable'
	/** GitHub would not accept the credential. Its remedy is a new sign-in, not a wait. */
	| 'credential'
	/** The hourly budget is spent. The only refusal here whose remedy is waiting. */
	| 'rate-limited'
	/** No such repository, or none this reader may see — which GitHub answers identically. */
	| 'no-repository'
	/** An anonymous read of a repository that is not public. Signing in is the remedy. */
	| 'not-public'
	/** GitHub could only list part of the tree, so nothing built from it can be trusted. */
	| 'truncated'
	/** Anything else GitHub said. */
	| 'refused';

/**
 * A check that could not be completed, with the sentence its reader is shown.
 *
 * ⚠ **A refusal is never a status.** A failed check must not be reported as `In sync` — nor as
 * `Cannot tell`, which is a *successful* determination about missing evidence. {@link
 * RemoteStatusChecker} keeps the last determination visible and puts this beside it.
 */
export class RemoteStatusUnavailableError extends Error {
	readonly refusal: RemoteStatusRefusal;

	constructor(refusal: RemoteStatusRefusal, message: string) {
		super(message);
		this.name = 'RemoteStatusUnavailableError';
		this.refusal = refusal;
	}
}

export interface RemoteInventoryOptions {
	readonly remote: RemoteRepository;
	/**
	 * The credential to list with, or `null` to list anonymously.
	 *
	 * ⚠ **`null` takes the anonymous reader in `remote-tree.ts`, which cannot send a header even by
	 * accident.** That is what makes the signed-out check honest: an explicit check must read a public
	 * Remote without asking for or sending credentials, and a shared code path with an optional
	 * `Authorization` is one refactor away from sending one.
	 */
	readonly token: string | null;
	readonly fetch?: FetchFn;
}

/**
 * Every path the Remote's branch holds, with the blob SHA that makes it comparable.
 *
 * **Metadata only.** One tree listing, no `raw.githubusercontent.com` request, no blob read:
 * observing must not be able to change either side, and the cheapest way to guarantee that is to
 * have nothing to write with.
 *
 * A repository with no commits answers an empty inventory rather than a refusal — that is a Remote
 * this Workspace can genuinely say something about, and it is the state a repository opened from
 * `github.com/new` is in.
 *
 * @throws RemoteStatusUnavailableError for every way the listing can fail
 */
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
		// A repository with no commits is an empty Remote, which is an answer rather than a failure.
		if (cause.refusal === 'empty') return [];
		const refusal = ANONYMOUS_REFUSALS[cause.refusal];
		throw new RemoteStatusUnavailableError(
			refusal,
			refusalSentence(options.remote, refusal, cause.detail, cause.resetAt)
		);
	}
}

/**
 * `remote-tree.ts`'s refusals as this module's, which are the same set minus `'empty'`.
 *
 * Spelled out rather than cast, so a refusal added to `remote-tree.ts` later is a compile error here
 * rather than a check that silently reports it as "GitHub refused".
 */
const ANONYMOUS_REFUSALS: Record<Exclude<RemoteTreeRefusal, 'empty'>, RemoteStatusRefusal> = {
	'no-repository': 'no-repository',
	'not-public': 'not-public',
	'rate-limited': 'rate-limited',
	truncated: 'truncated',
	unreachable: 'unreachable',
	refused: 'refused'
};

async function credentialedInventory(
	options: RemoteInventoryOptions
): Promise<readonly InventoryEntry[]> {
	const request = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
	// ⚠ The branch is **one** encoded path parameter, as `remote-tree.ts` spells out: `/git/trees/{ref}`
	// takes a single segment, so a branch of `feature/x` written per segment asks for a path this
	// endpoint does not have at all.
	const url =
		`${GITHUB_API_ORIGIN}/repos/${urlPath(options.remote.owner)}/${urlPath(options.remote.repository)}` +
		`/git/trees/${encodeURIComponent(options.remote.branch)}?recursive=1`;

	let response: Response;
	try {
		response = await request(url, {
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${options.token}`
			}
		});
	} catch (cause) {
		throw new RemoteStatusUnavailableError(
			'unreachable',
			refusalSentence(
				options.remote,
				'unreachable',
				cause instanceof Error ? cause.message : String(cause),
				null
			)
		);
	}

	// 409 `Git Repository is empty.` is a repository with no commits, and not 404.
	if (response.status === 409) return [];
	if (response.status === 401) {
		throw new RemoteStatusUnavailableError(
			'credential',
			refusalSentence(options.remote, 'credential', '', null)
		);
	}
	// ⚠ **A 403 is two situations and the remaining count is what separates them**, exactly as the
	// anonymous reader and the publish engine both find: a spent hourly budget and a credential
	// without the rights answer the same status, and only one of them is fixed by waiting.
	if (response.status === 403) {
		const budget = rateLimitOf(response.headers);
		if (headerNumber(response.headers, 'X-RateLimit-Remaining') === 0) {
			throw new RemoteStatusUnavailableError(
				'rate-limited',
				refusalSentence(options.remote, 'rate-limited', '', budget.resetAt)
			);
		}
		throw new RemoteStatusUnavailableError(
			'refused',
			refusalSentence(options.remote, 'refused', await problemOf(response), null)
		);
	}
	if (response.status === 404) {
		throw new RemoteStatusUnavailableError(
			'no-repository',
			refusalSentence(options.remote, 'no-repository', '', null)
		);
	}
	if (!response.ok) {
		throw new RemoteStatusUnavailableError(
			'refused',
			refusalSentence(options.remote, 'refused', await problemOf(response), null)
		);
	}

	const body = (await response.json().catch(() => ({}))) as { tree?: unknown; truncated?: unknown };
	// `Array.isArray` rather than `?? []`, for `remote-tree.ts`'s reason: a `tree` that is a string is
	// iterable character by character, and one that is a number throws out of the function whose job
	// is to turn a bad answer into a refusal.
	const listed = (Array.isArray(body.tree) ? body.tree : []) as readonly {
		path?: unknown;
		sha?: unknown;
		type?: unknown;
	}[];
	const inventory: InventoryEntry[] = [];
	for (const entry of listed) {
		// Blobs only: a `tree` entry is a directory implied by the paths beneath it, and a `commit`
		// entry is a gitlink whose bytes are in another repository and are nobody's to compare here.
		if (entry.type !== 'blob') continue;
		if (typeof entry.path !== 'string' || typeof entry.sha !== 'string') continue;
		inventory.push({ path: entry.path, sha: entry.sha });
	}

	// ⚠ **A truncated listing answers 200**, so nothing throws and nothing logs. Read as complete it
	// would report every unlisted path as deleted on the Remote — `Changes to get` over a Remote
	// nobody has touched, on the largest Workspaces, which are the ones that reach the limit.
	if (body.truncated === true) {
		throw new RemoteStatusUnavailableError(
			'truncated',
			refusalSentence(options.remote, 'truncated', '', null)
		);
	}
	return inventory;
}

async function problemOf(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { message?: unknown };
		return typeof body?.message === 'string' ? body.message : response.statusText;
	} catch {
		return response.statusText;
	}
}

/**
 * What the reader is told, per refusal.
 *
 * Every one of them ends the same way, and that ending is the point: the status on screen is the last
 * one that could be worked out, so a scholar reads a failure as *stale*, never as agreement.
 */
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

// ── When to take one ──────────────────────────────────────────────────────────────────────────

/** Why a check is running. `'explicit'` is a user's gesture and is neither throttled nor gated. */
export type RemoteStatusTrigger = 'open' | 'focus' | 'explicit';

/** What one check found, or that it was not attempted at all. */
export type RemoteStatusObservation =
	| {
			readonly outcome: 'determined';
			readonly status: SourceStatus;
			/** Publish-owned paths the two sides disagree about. Never part of {@link status}. */
			readonly publishedSiteStale: readonly string[];
			/**
			 * Whether reaching this asked GitHub anything.
			 *
			 * ⚠ **What the interval is spent on.** `Cannot tell` is settled from the Baseline's absence
			 * alone, so it costs no request — and a determination that cost nothing must not close the
			 * window on the next one that would. Otherwise a Workspace that opened with no Baseline is
			 * held off for a minute after the transfer that gives it one, which is exactly when its status
			 * changes and exactly when a scholar looks.
			 */
			readonly requested: boolean;
	  }
	/**
	 * The signed-out automatic check, and the unbound Workspace.
	 *
	 * ⚠ **Not a failure, and it must not be rendered as one.** Nothing was asked of GitHub and nothing
	 * went wrong; there is simply no new determination, so the last one stands untouched.
	 */
	| { readonly outcome: 'not-attempted' };

/** Everything a control renders, and nothing it has to work out for itself. */
export interface RemoteStatusState {
	/** The last successful determination, or `null` before there has been one. */
	readonly status: SourceStatus | null;
	/** When that determination was reached, on the injected clock. `null` with no status. */
	readonly at: number | null;
	/** Whether a check is running now, for the progress a screen reader is owed. */
	readonly checking: boolean;
	/**
	 * Why the most recent check could not be completed, or `''`.
	 *
	 * Shown *beside* {@link status} rather than instead of it. Cleared by the next
	 * check that succeeds, and never by one that does not.
	 */
	readonly failure: string;
	/** Publish-owned drift from the last successful check. Separate from the six source states. */
	readonly publishedSiteStale: readonly string[];
}

/** No determination and no failure: what a newly bound Workspace starts at. */
export const UNCHECKED_REMOTE_STATUS: RemoteStatusState = {
	status: null,
	at: null,
	checking: false,
	failure: '',
	publishedSiteStale: []
};

/**
 * How long two automatic checks of one Workspace are kept apart, in milliseconds.
 *
 * A window focus is not a rare event — every switch back from a browser tab, a PDF reader or a
 * mail client is one, and a scholar comparing a manuscript facsimile with their alignment produces
 * dozens a minute. Unbounded, each would be a GitHub request against an hourly budget that a large
 * publish also has to fit inside (ADR-0033).
 */
export const AUTOMATIC_CHECK_INTERVAL_MS = 60_000;

export interface RemoteStatusCheckerOptions {
	/**
	 * Take one observation, or answer `null` **synchronously** for a check that must not run.
	 *
	 * ⚠ **`null` rather than a promise resolving to `'not-attempted'`, and the difference is what a
	 * screen reader hears.** A check that was never going to happen must not announce itself as one
	 * that is running, and by the time a promise resolves the progress has already been said out
	 * loud — on every window focus, for the whole of a signed-out session.
	 */
	readonly observe: (trigger: RemoteStatusTrigger) => Promise<RemoteStatusObservation> | null;
	/** The clock. Injected so the throttle is a table-driven test rather than a wait. */
	readonly now: () => number;
	/** Milliseconds between automatic checks. See {@link AUTOMATIC_CHECK_INTERVAL_MS}. */
	readonly interval?: number;
	/** Told whenever {@link RemoteStatusChecker.state} changes. */
	readonly onChange?: (state: RemoteStatusState) => void;
}

/**
 * One Workspace's Remote Status, checked at a bounded rate and retained across a failure.
 *
 * ⚠ **One per Workspace, and {@link close} is not optional.** A check runs while the user is free to
 * switch Workspaces, and a result arriving afterwards would render one Workspace's drift beside
 * another's name — the same hazard `SynchronizationMetadata` is keyed per Workspace for. Closing
 * makes every completion still in flight a no-op, so the ordering of a switch and a network round
 * trip stops mattering.
 */
export class RemoteStatusChecker {
	readonly #observe: (trigger: RemoteStatusTrigger) => Promise<RemoteStatusObservation> | null;
	readonly #now: () => number;
	readonly #interval: number;
	readonly #onChange: ((state: RemoteStatusState) => void) | undefined;

	#state: RemoteStatusState = UNCHECKED_REMOTE_STATUS;
	/** The check in flight, so concurrent callers share one listing rather than fanning out. */
	#running: Promise<void> | null = null;
	/** When the last attempt *finished*. A check that was not attempted never moves it. */
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

	/**
	 * Check, share the check already running, or do nothing at all.
	 *
	 * `'explicit'` is a user's gesture: it is never throttled, and it is the only trigger that may
	 * read a public Remote with no credential. `'open'` and `'focus'` are automatic
	 * and are both coalesced — a burst of focus events shares one listing — and throttled to
	 * {@link RemoteStatusCheckerOptions.interval}.
	 *
	 * Resolves once the state has settled, so a caller that wants to read the answer can await it.
	 */
	check(trigger: RemoteStatusTrigger): Promise<void> {
		if (this.#closed) return Promise.resolve();
		// Coalesced before anything else: a second caller inside a check in flight is answered by that
		// check, whatever its trigger, because a second listing would tell it the same thing.
		if (this.#running !== null) return this.#running;
		if (trigger !== 'explicit' && this.#now() - this.#lastAttempt < this.#interval) {
			return Promise.resolve();
		}
		const observation = this.#observe(trigger);
		if (observation === null) return Promise.resolve();
		this.#publish({ ...this.#state, checking: true });
		// ⚠ **The promise held is the *wrapper*, not the one it wraps.** Comparing against the inner
		// promise here never matches, so `#running` is never cleared and every later check is coalesced
		// into a listing that finished minutes ago — a status control that updates exactly once.
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

	/** Abandon this Workspace's checker. A completion after this changes and announces nothing. */
	close(): void {
		this.#closed = true;
		this.#running = null;
	}

	#settle(found: RemoteStatusObservation): void {
		if (this.#closed) return;
		if (found.outcome === 'not-attempted') {
			// Nothing was asked and nothing went wrong: the last determination, the last failure and the
			// throttle window all stand exactly as they were.
			this.#publish({ ...this.#state, checking: false });
			return;
		}
		// ⚠ **Stamped when the check *finishes*, and only when it asked GitHub something.** Stamped at
		// the start, a listing that takes eight seconds over a large tree would open the window again
		// eight seconds early; stamped for a determination that made no request, it would bound checking
		// that costs nothing to do.
		if (found.requested) this.#lastAttempt = this.#now();
		this.#publish({
			status: found.status,
			at: this.#now(),
			checking: false,
			failure: '',
			publishedSiteStale: found.publishedSiteStale
		});
	}

	#refuse(cause: unknown): void {
		if (this.#closed) return;
		// ⚠ **`status` and `at` are carried through untouched.** A network failure is not agreement, and
		// the last thing this browser actually worked out is still the best answer there is — so it stays
		// on screen, with the failure beside it saying it is no longer current.
		this.#lastAttempt = this.#now();
		this.#publish({
			...this.#state,
			checking: false,
			failure: cause instanceof Error ? cause.message : String(cause)
		});
	}

	#publish(state: RemoteStatusState): void {
		this.#state = state;
		this.#onChange?.(state);
	}
}

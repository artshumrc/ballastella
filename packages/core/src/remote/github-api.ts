// The two GitHub hosts Ballastella talks to, and what every response of theirs says about the budget.
//
// A leaf of their own rather than constants inside `fake-github.ts`, because the publish engine
// needs the API origin and a fixture must never be something production code imports. The rate-limit
// reading lives here for the same reason it is one function: the publish, the Clone and the Review
// all meet the same 403 and would otherwise each decide for themselves what an absent header means.

/** GitHub's data plane. It answers `access-control-allow-origin: *`, which is why ADR-0031 holds. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/** Where a public repository's bytes are read from, unauthenticated, by Clone and Review. */
export const GITHUB_RAW_ORIGIN = 'https://raw.githubusercontent.com';

/**
 * A header's number, or `null` when it is absent or unreadable.
 *
 * ⚠ `Headers#get` answers `null` for a header that is not there and `Number(null)` is `0`, which
 * `Number.isFinite` accepts — so a response carrying no budget header would otherwise read as a
 * budget of nought: a warning that GitHub allows no more requests this hour, and every later 403,
 * including a token with no `contents: write`, reported as a rate limit that waiting would fix.
 */
export function headerNumber(headers: Headers, name: string): number | null {
	const raw = headers.get(name);
	if (raw === null || raw.trim() === '') return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

/** What a response says is left of the hourly budget, and when it starts again. */
export type RateLimit = {
	readonly remaining: number | null;
	readonly resetAt: Date | null;
};

/**
 * The hourly budget as one response reports it.
 *
 * ⚠ **Readable at all only because `api.github.com` names both headers in
 * `access-control-expose-headers`.** A cross-origin response whose headers were not exposed arrives
 * with every one of them hidden, so this answers `{ null, null }` — which is why nothing here may
 * treat a missing header as a spent budget.
 */
export function rateLimitOf(headers: Headers): RateLimit {
	const reset = headerNumber(headers, 'X-RateLimit-Reset');
	return {
		remaining: headerNumber(headers, 'X-RateLimit-Remaining'),
		resetAt: reset !== null && reset > 0 ? new Date(reset * 1000) : null
	};
}

/** A reset time in the reader's own clock, or `''` when the response did not say when. */
export const describeReset = (resetAt: Date | null): string =>
	resetAt === null
		? ''
		: resetAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

import { test as base, expect } from '@playwright/test';

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE SUITE REACHES NOTHING BUT ITS OWN SERVERS, AND THAT IS ENFORCED RATHER THAN INTENDED.
//
// **This is a human decision from the repository owner: no test may depend on the network.**
//
// It is not a preference about tidiness. On 2026-08-07 `demo-bucket.protomaps.com/v4.pmtiles` —
// the archive every entry of this deployment's Base Map catalog points at — began answering 404,
// and three specs went red for a reason that had nothing to do with this repository. Ticket 17
// routed those three. That fixed the three; it did not fix the *class*, because routing was opt-in
// per spec and eleven specs called no route at all. A suite whose failures mean something cannot
// depend on a stranger's uptime, and cannot rely on each new spec's author remembering.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE SEAM IS `context.route` AND NOT A PROXY — MEASURED, NOT ASSUMED
//
// The doubt worth having is service workers: a worker's `fetch` is issued from a separate
// execution context, and page-level interception does not obviously reach it. ADR-0011's tile
// path and ADR-0012's shell cache both live in `apps/editor/src/service-worker.ts`, so a fence
// blind to worker traffic would be a fence with a hole exactly where this project has code.
//
// **Checked rather than reasoned about**, on `@playwright/test` 1.62.1: a `context.route('**/*')`
// installed before navigation intercepts a `fetch` issued from inside the registered service
// worker as well as one issued from the page. Both were observed reaching the handler and both
// were blocked. No `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS` was set. The ordering matters
// and this fixture guarantees it: the route is installed as part of building the `context`, which
// is strictly before any `beforeEach`, any navigation, and therefore any registration.
//
// A refusing HTTP proxy was the alternative. It was declined for two reasons and one of them is
// not obvious: an HTTPS request reaches a proxy as `CONNECT host:443`, so the proxy can name the
// *host* and never the URL — and "name the URL" is most of what makes this fence useful to the
// person who trips it. The other is that routing to a committed fixture is what a spec has to do
// anyway, so the fence and the remedy share one mechanism instead of being two.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IT COSTS
//
// Registering any route at all makes Playwright send Chromium `Fetch.enable` with
// `urlPattern: "*"` and `Network.setCacheDisabled: true` — the interception is all-or-nothing at
// the protocol level, so a narrow matcher buys nothing. Thirteen specs already paid this before
// this fence existed, because they called `routeBaseMapArchive`; the audit that came with the
// fence gave the same route to the rest, so nearly every spec would have paid it regardless.
// See the ticket for the interleaved A/B measurement.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A named, justified permission for one test file to reach one external host.
 *
 * `why` is required by the type, deliberately. An allowance with no stated reason is how a fence
 * becomes a formality: the next person reads the host, cannot tell whether it still matters, and
 * leaves it. **There are currently none in this repository**, and adding one is a decision worth
 * arguing for in review rather than a line of configuration.
 */
export type ExternalAllowance = {
	/** An exact hostname, e.g. `tiles.example.edu`. Not a pattern — a pattern hides what it permits. */
	readonly host: string;
	/** Why this test genuinely cannot use a committed fixture. */
	readonly why: string;
};

/**
 * The hosts that are this suite's own machine.
 *
 * `vite preview` serves the editor and the viewer on `localhost` (see `playwright.config.ts`), and
 * `support/editor-deployment.ts` and `support/static-site.ts` bind ephemeral ports on `127.0.0.1`
 * because a service worker needs a potentially-trustworthy origin. Both spellings, and IPv6's, are
 * this machine and none of them is the network.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is this a request the fence should let past without an allowance?
 *
 * Exported so it can be asserted directly — see `editor-network-fence.e2e.ts`. A predicate that is
 * only ever exercised through a browser is a predicate whose boundaries nobody has looked at.
 *
 * Non-HTTP schemes pass: `data:`, `blob:` and `about:` carry their own bytes and reach no host, and
 * a malformed URL is not something this fence should convert into a confusing failure.
 *
 * @param allowed the test file's declared allowances, if any
 */
export function reachesTheNetwork(
	url: string,
	allowed: readonly ExternalAllowance[] = []
): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
	if (LOCAL_HOSTS.has(parsed.hostname)) return false;
	return !allowed.some((allowance) => allowance.host === parsed.hostname);
}

/**
 * What a test author sees when their test reached the network.
 *
 * It names the URL, because the first question is always "what asked for that", and it names the
 * remedy in the spelling that works, because the second question is always "so what do I do".
 */
export function networkFenceMessage(urls: readonly string[]): string {
	const list = urls.map((url) => `  ${url}`).join('\n');
	return [
		`This test reached ${urls.length === 1 ? 'an external origin' : 'external origins'}:`,
		list,
		'',
		'No test in this suite may depend on the network — a recorded decision by the repository',
		'owner, and the reason `demo-bucket.protomaps.com` turning 404 could turn this suite red',
		'for a reason that had nothing to do with the code under test.',
		'',
		'Route it to a committed fixture. For this deployment’s Base Map archive that is one line:',
		'',
		"    import { routeBaseMapArchive } from './support/editor-deployment.js';",
		'    test.beforeEach(async ({ page }) => routeBaseMapArchive(page));',
		'',
		'For anything else, add a fixture under `e2e/fixtures/` and `page.route` it. If the test',
		'genuinely cannot work against a fixture, declare it at the top of the spec with a reason:',
		'',
		"    test.use({ allowedExternalHosts: [{ host: 'example.com', why: '…' }] });",
		'',
		'The request was blocked, so anything the test reported before this is about a page that',
		'did not get an answer.'
	].join('\n');
}

/**
 * `test` for this suite: `@playwright/test`'s, with the network fence built into its `context`.
 *
 * **Every `*.e2e.ts` file must import `test` from here**, and `scripts/check-e2e-network-fence.mjs`
 * fails `pnpm lint` if one imports it from `@playwright/test` instead. Without that check the fence
 * would be exactly what it replaces — opt-in, and forgotten by the next spec.
 *
 * The fence lives on the **`context`** fixture rather than on an `auto` one so that a test taking
 * neither `page` nor `context` still launches no browser. Three tests in this suite are in that
 * position (`viewer.e2e.ts` and two in `editor-base-map.e2e.ts` read built files off disk), and an
 * `auto` fixture would have quietly given them a Chromium each.
 */
export const test = base.extend<{ allowedExternalHosts: readonly ExternalAllowance[] }>({
	allowedExternalHosts: [[], { option: true }],

	context: async ({ context, allowedExternalHosts }, use, testInfo) => {
		const reached: string[] = [];
		// The fence's own positive controls (`editor-network-fence.e2e.ts`) reach an unresolvable
		// host on purpose and are marked `test.fail()`. Printing the explanation for them would put
		// a wall of red text in front of every clean run, which is how people learn to skim output.
		//
		// **Read at the moment of the block, not here.** `test.fail()` inside a test body runs long
		// after this fixture is set up, so a value captured now says `passed` for a test that has
		// since declared itself an expected failure — which is what the first cut of this did, and
		// it printed the wall of text anyway.
		const isExpectedFailure = () => testInfo.expectedStatus === 'failed';

		// Registered here, before any `beforeEach`, which puts it **last** in Playwright's matching
		// order — handlers are tried most-recently-registered first. That is the ordering this fence
		// needs: a spec's own `routeBaseMapArchive` or IIIF stub is consulted first and fulfils, and
		// only a request nobody claimed falls through to here.
		await context.route('**/*', async (route) => {
			const url = route.request().url();
			if (!reachesTheNetwork(url, allowedExternalHosts)) {
				await route.fallback();
				return;
			}
			if (!reached.includes(url)) {
				reached.push(url);
				// Printed as it happens as well as thrown at teardown. A blocked request usually shows
				// up first as something else — a 30 s wait for an element that never arrives — and the
				// teardown message arrives too late to stop the reader forming a theory.
				if (!isExpectedFailure()) console.error(`\n⛔ ${networkFenceMessage([url])}\n`);
			}
			// `blockedbyclient` rather than `failed`: it is what a browser reports for a request an
			// extension or policy refused, so `net::ERR_BLOCKED_BY_CLIENT` in a page's console log
			// says a fence did this and the host is not merely down.
			await route.abort('blockedbyclient');
		});

		await use(context);

		if (reached.length > 0) throw new Error(networkFenceMessage(reached));
	}
});

// `expect` is `@playwright/test`'s, unchanged, re-exported so a spec needs one import rather than
// two. **Types are not re-exported**: `Locator`, `Page`, `Route` and the rest are type-only and
// carry no behaviour, so they keep coming from `@playwright/test` and the fence check ignores them.
export { expect };

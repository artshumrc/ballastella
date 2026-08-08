import { expect, test } from './support/network-fence.js';
import { networkFenceMessage, reachesTheNetwork } from './support/network-fence.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE POSITIVE CONTROL FOR THE SUITE-WIDE NETWORK FENCE.
//
// `support/network-fence.ts` is a fence, and this repository has shipped a fence that printed its
// success message unconditionally. Every other fence here carries a `KNOWN_BAD` specimen asserted
// to be caught before the real scan runs (`check-alignment-writers.mjs`,
// `check-workspace-rooted-paths.mjs`); this is that specimen for the one fence that cannot be a
// script, because what it guards is a running browser.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THESE TESTS ARE `test.fail()` AND NOT SKIPPED
//
// `editor-retry-budget-control.e2e.ts` is skipped by default because running it *spends* the thing
// it guards — a retry out of a budget of one. This has no such cost, so it runs every time, which
// is the whole point: a fence checked only when somebody remembers to set an environment variable
// is a fence in the same condition as the routing it replaced.
//
// A blocked request produces a fixture-teardown error, and `test.fail()` turns that into a pass —
// verified rather than assumed, since a teardown failure is not obviously covered by a marker whose
// documentation talks about test bodies. **If the fence stops blocking, these go green, and
// `test.fail()` turns a green test into a failure.** That is the direction that matters.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTROL CANNOT ITSELF DEPEND ON THE NETWORK
//
// Every host below is under `.invalid`, which RFC 2606 reserves and no resolver answers. So if the
// fence is ever removed, this file still reaches nothing — it fails with a DNS error instead of a
// blocked one, and it fails either way. A control that would have hit a real host on regression
// would be the very thing being fenced against.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const OUTSIDE = 'https://ballastella-network-fence-control.invalid/probe';

test.describe('the network fence', () => {
	test('blocks a request the page makes to an external origin', async ({ page }) => {
		test.fail();
		await page.goto('./');

		const reported = await page.evaluate(
			(url) =>
				fetch(url).then(
					() => 'the request was answered',
					(error: Error) => String(error)
				),
			OUTSIDE
		);

		// The page's own view of it: a fetch that did not happen. The test still fails, at teardown,
		// with the URL and the remedy — which is what this control is asserting exists.
		expect(reported).toContain('Failed to fetch');
	});

	test('blocks a request the service worker makes to an external origin', async ({
		page,
		context
	}) => {
		test.fail();

		// ─────────────────────────────────────────────────────────────────────────────────────
		// THIS IS THE ASSUMPTION MOST LIKELY TO ROT, AND THE REASON THIS TEST EXISTS SEPARATELY
		//
		// A service worker issues its `fetch` from its own execution context, and page-level
		// interception does not obviously reach it — Playwright has carried an experimental flag
		// for service-worker network events for years. Measured on `@playwright/test` 1.62.1 with
		// no flag set, `context.route` *does* see worker traffic, and the fence is built on that.
		//
		// ADR-0011's tile path and ADR-0012's shell cache both live in the worker, so a fence blind
		// to it would have a hole exactly where this project keeps its network code. An upgrade
		// that changes Playwright's behaviour would otherwise turn the fence off in that half and
		// print nothing at all.
		const registered = context.waitForEvent('serviceworker');
		await page.goto('./');
		const worker = await registered;

		const reported = await worker.evaluate(
			(url) =>
				fetch(url).then(
					() => 'the request was answered',
					(error: Error) => String(error)
				),
			OUTSIDE
		);

		expect(reported).toContain('Failed to fetch');
	});

	test('leaves this suite’s own servers alone', async ({ page }) => {
		// The other half of the mutation check: a fence that blocked everything would make the whole
		// suite fail rather than pass, but a fence that blocked *slightly* too much — the preview
		// server's own origin under one of its spellings — would show up as a scatter of unrelated
		// failures. `vite preview` serves on `localhost`; `support/editor-deployment.ts` and
		// `support/static-site.ts` bind `127.0.0.1` because a service worker needs a
		// potentially-trustworthy origin. Both must be untouched.
		await page.goto('./');
		await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();

		for (const host of ['localhost', '127.0.0.1', '[::1]']) {
			expect(reachesTheNetwork(`http://${host}:20001/base-map/sprites/light.json`)).toBe(false);
		}
	});

	test('lets a routed archive through, with its real bytes', async ({ page }) => {
		// The fence must not make the suite pass by blocking everything: a request a spec has routed
		// to a committed fixture has to arrive complete, as a `206` over real PMTiles bytes, because
		// `pmtiles`' `FetchSource` rejects anything else (see `byteRange`). This is the shape every
		// Base Map assertion in the suite rests on.
		await routeBaseMapArchive(page);
		await page.goto('./');

		const served = await page.evaluate(async () => {
			const response = await fetch('https://demo-bucket.protomaps.com/v4.pmtiles', {
				headers: { range: 'bytes=0-6' }
			});
			const body = await response.arrayBuffer();
			return {
				status: response.status,
				length: body.byteLength,
				magic: new TextDecoder().decode(body)
			};
		});

		// A `206` cut to the seven bytes asked for, not a `200` carrying the whole archive — which is
		// the answer `pmtiles`' `FetchSource` rejects outright, and the reason `byteRange` exists.
		expect(served.status).toBe(206);
		expect(served.length).toBe(7);
		// PMTiles v3's magic number. Zeros of the right length would satisfy a length assertion, and
		// ticket 17 measured that an all-zero archive passes several of this suite's Base Map tests.
		//
		// `content-range` is deliberately not asserted: it is not a CORS-safelisted response header,
		// so JavaScript in the page cannot read it off a cross-origin `fulfill` without an
		// `access-control-expose-headers`. The header *is* sent — `pmtiles` reads it through the
		// browser's own range machinery, and fourteen specs depend on that working.
		expect(served.magic).toBe('PMTiles');
	});

	// ── The predicate, directly ────────────────────────────────────────────────────────────────
	//
	// No `page` fixture, so these launch no browser and cost milliseconds. The boundaries of a
	// predicate that decides what leaves the machine are worth looking at rather than inferring
	// from the behaviour of four browser tests.

	test('reads a URL as local, external, or not a request at all', () => {
		expect(reachesTheNetwork('http://localhost:20000/index.html')).toBe(false);
		expect(reachesTheNetwork('http://127.0.0.1:41235/service-worker.js')).toBe(false);
		expect(reachesTheNetwork('http://[::1]:20000/')).toBe(false);

		expect(reachesTheNetwork('https://demo-bucket.protomaps.com/v4.pmtiles')).toBe(true);
		expect(reachesTheNetwork('https://library.test/iiif/atlas/manifest.json')).toBe(true);
		// `unset.invalid` is ADR-0004's placeholder host. The injection shim resolves it before any
		// request is made — but if one ever escapes, it is a defect and the fence must say so rather
		// than wave it past because the TLD looks harmless.
		expect(reachesTheNetwork('https://unset.invalid/abc/0/0/0.jpg')).toBe(true);

		// Not requests to a host: these carry their own bytes and reach nothing.
		expect(reachesTheNetwork('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
		expect(reachesTheNetwork('blob:http://localhost:20000/8f2a')).toBe(false);
		expect(reachesTheNetwork('about:blank')).toBe(false);
		expect(reachesTheNetwork('not a url at all')).toBe(false);

		// A hostname that merely *contains* a local one is not local.
		expect(reachesTheNetwork('https://localhost.evil.example/')).toBe(true);
		expect(reachesTheNetwork('https://not-localhost/')).toBe(true);
	});

	test('honours a declared allowance, for that host and no other', () => {
		const allowed = [{ host: 'tiles.example.edu', why: 'a specimen, not a real allowance' }];

		expect(reachesTheNetwork('https://tiles.example.edu/planet.pmtiles', allowed)).toBe(false);
		expect(reachesTheNetwork('https://other.example.edu/planet.pmtiles', allowed)).toBe(true);
		// Exact hostnames, never patterns: a subdomain of an allowed host is a different host.
		expect(reachesTheNetwork('https://sub.tiles.example.edu/planet.pmtiles', allowed)).toBe(true);
	});

	test('names the URL and the remedy', () => {
		const message = networkFenceMessage(['https://demo-bucket.protomaps.com/v4.pmtiles']);

		// The two things somebody who trips this needs: what asked, and what to do about it.
		expect(message).toContain('https://demo-bucket.protomaps.com/v4.pmtiles');
		expect(message).toContain('routeBaseMapArchive');
		expect(message).toContain('allowedExternalHosts');
	});
});

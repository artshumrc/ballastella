import { describe, expect, it } from 'vitest';

import { refusedNetworkMessage } from './refuse-network';

// The positive control for the Node half of the network fence.
//
// Every other fence in this repository carries a `KNOWN_BAD` specimen asserted to be caught before
// the real check runs (`scripts/check-alignment-writers.mjs`, `scripts/check-workspace-rooted-paths.mjs`),
// because a fence's way of dying is silent: a suite that reaches nothing and a fence that stops
// blocking print exactly the same output. This is that specimen.
//
// **It lives beside the setup file rather than under `src/`** — `vitest.config.ts` adds
// `vitest-setup/` to the node project's `include` for these two files — so that the thing being
// asserted and the assertion cannot drift into different directories. `refuse-network.browser.test.ts`
// is its twin, and it is separate because the globals differ: there is no `XMLHttpRequest`,
// `WebSocket` or `navigator.sendBeacon` in Node, and no `node:https` in a browser.

const EXTERNAL = 'https://demo-bucket.protomaps.com/v4.pmtiles';

describe('the network fence, in Node', () => {
	it('refuses a global fetch to an external origin, naming the URL', () => {
		// **Synchronously, not as a rejected promise**, which is a deliberate departure from what
		// `fetch` does. A rejection is swallowed by any `.catch(() => undefined)` on the chain — and
		// swallowing this one would put the fence back in the state it exists to leave: quiet. A
		// throw from the call itself happens before a handler can be attached to it.
		expect(() => fetch(EXTERNAL)).toThrow('This test reached the network');
		expect(() => fetch(EXTERNAL)).toThrow(EXTERNAL);
	});

	it('refuses node:https, which `fetch` does not go through', async () => {
		// Node's `fetch` is undici and never touches `node:http`, so fencing one says nothing about
		// the other. One `import https from 'node:https'` is all it would take.
		const https = (await import('node:https')).default;
		const http = (await import('node:http')).default;

		expect(() => https.get(EXTERNAL)).toThrow('node:https.get');
		expect(() => https.request(EXTERNAL)).toThrow('node:https.request');
		expect(() => http.get('http://demo-bucket.protomaps.com/')).toThrow('node:http.get');
		// The options-object spelling, which names the host in a field rather than in a URL.
		expect(() => https.request({ hostname: 'demo-bucket.protomaps.com', path: '/' })).toThrow(
			'demo-bucket.protomaps.com'
		);
	});

	it('leaves this machine alone, or nothing local could be tested at all', async () => {
		// Port 1 answers nothing, so a *connection* error here is the fence having let it past — which
		// is the assertion. Several tests in this package stand up local servers, and Vitest's own
		// browser mode is a local server; a fence that refused `127.0.0.1` would not be strict, it
		// would stop the suite booting.
		await expect(fetch('http://127.0.0.1:1/nothing')).rejects.toThrow(/fetch failed|ECONNREFUSED/);

		const http = (await import('node:http')).default;
		// The request is *made*, then abandoned — the point is that the fence did not refuse it. Its
		// `error` listener is not defensive padding: without one, the abandoned socket's `ECONNRESET`
		// is an uncaught exception that Vitest reports at the end of the run, in a file that had
		// already passed.
		const attempt = http.request('http://localhost:1/nothing');
		attempt.on('error', () => undefined);
		attempt.destroy();
		expect(attempt.destroyed).toBe(true);
	});

	it('says what to do, not only that something is wrong', () => {
		const message = refusedNetworkMessage('fetch', EXTERNAL);

		expect(message).toContain(EXTERNAL);
		// The remedy this repository actually uses everywhere else.
		expect(message).toContain('FetchFn');
		// And the one opt-out, named, so nobody invents a second one.
		expect(message).toContain('BALLASTELLA_NETWORK_TESTS');
	});
});

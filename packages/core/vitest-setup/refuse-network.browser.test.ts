import { describe, expect, it } from 'vitest';

// The positive control for the browser half of the network fence — the twin of
// `refuse-network.test.ts`, which covers Node. Two files because the globals are disjoint: there is
// no `XMLHttpRequest`, `WebSocket` or `navigator.sendBeacon` in Node, and no `node:https` here.
//
// This half matters more than its size suggests. `*.browser.test.ts` runs in a real Chromium and a
// real Firefox against real OPFS, which is the one place in this package where the network is
// genuinely reachable from a test and where an accidental `fetch(…)` would simply work.

const EXTERNAL = 'https://demo-bucket.protomaps.com/v4.pmtiles';

describe('the network fence, in the browser', () => {
	it('refuses every global that can leave the machine, naming the URL', () => {
		// Synchronously — see the note in `refuse-network.test.ts` on why a rejection would be worse.
		expect(() => fetch(EXTERNAL)).toThrow(EXTERNAL);

		// The one most third-party libraries still use, and the one a `fetch`-only fence misses.
		expect(() => new XMLHttpRequest().open('GET', EXTERNAL)).toThrow('XMLHttpRequest');

		expect(() => new WebSocket('wss://example.com/socket')).toThrow('WebSocket');

		// The one that fires during teardown, returns a boolean nobody reads, and would otherwise be
		// invisible in both the output and the assertions.
		expect(() => navigator.sendBeacon('https://example.com/beacon')).toThrow(
			'navigator.sendBeacon'
		);
	});

	it('leaves Vitest’s own origin alone, which is what makes the fixtures work', async () => {
		// Vitest serves this module, every `import.meta.glob(…, 'url')` fixture, and its own
		// WebSocket back to the runner from `localhost`. `mirror.browser.test.ts` and
		// `decode-and-crop-tiler.browser.test.ts` both `fetch` bundled fixture URLs, so this is not a
		// hypothetical: refusing same-origin traffic would fail them and stop the project booting.
		const response = await fetch(new URL('../src/index.ts', import.meta.url).href);

		expect(response.ok).toBe(true);
	});
});

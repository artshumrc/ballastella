import { describe, expect, it } from 'vitest';

import { refusedNetworkMessage } from './refuse-network.js';

// The positive control for this project's half of the network fence.
//
// **It asserts installation, not implementation.** The fence's own behaviour is asserted where it
// is written (`packages/core/vitest-setup/refuse-network.test.ts`); what can only be asserted here
// is that `apps/editor`'s vitest project actually loads it — a `setupFiles` entry that was dropped,
// misspelled, or written on the root config instead of on the project would leave this suite
// unfenced and print exactly the same output as a fenced one. Every other fence in this repository
// carries such a specimen, because a fence's way of dying is silent.

const EXTERNAL = 'https://demo-bucket.protomaps.com/v4.pmtiles';

describe('the network fence, in the editor’s unit project', () => {
	it('refuses a global fetch to an external origin, naming the URL', () => {
		// Synchronously rather than as a rejected promise, which is the fence's own deliberate
		// departure from `fetch`: a rejection is swallowed by any `.catch(() => undefined)` on the
		// chain, and swallowing this one would put the fence back in the state it exists to leave.
		expect(() => fetch(EXTERNAL)).toThrow('This test reached the network');
		expect(() => fetch(EXTERNAL)).toThrow(EXTERNAL);
	});

	it('names the API, the URL and the remedy this repository actually uses', () => {
		// The sentence is the fence's product: a test author who trips it has to be told what to do
		// instead, and what this repository does instead is dependency injection.
		const said = refusedNetworkMessage('XMLHttpRequest', EXTERNAL);
		expect(said).toContain('XMLHttpRequest');
		expect(said).toContain(EXTERNAL);
		expect(said).toContain('FetchFn');
	});
});

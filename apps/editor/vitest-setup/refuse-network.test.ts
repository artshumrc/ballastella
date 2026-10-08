import { describe, expect, it } from 'vitest';

import { refusedNetworkMessage } from './refuse-network.js';

const EXTERNAL = 'https://demo-bucket.protomaps.com/v4.pmtiles';

describe('the network fence, in the editor’s unit project', () => {
	it('refuses a global fetch to an external origin, naming the URL', () => {
		expect(() => fetch(EXTERNAL)).toThrow('This test reached the network');
		expect(() => fetch(EXTERNAL)).toThrow(EXTERNAL);
	});

	it('names the API, the URL and the remedy this repository actually uses', () => {
		const said = refusedNetworkMessage('XMLHttpRequest', EXTERNAL);
		expect(said).toContain('XMLHttpRequest');
		expect(said).toContain(EXTERNAL);
		expect(said).toContain('FetchFn');
	});
});

import { describe, expect, it } from 'vitest';

import { refusedNetworkMessage } from './refuse-network';

const EXTERNAL = 'https://demo-bucket.protomaps.com/v4.pmtiles';

describe('the network fence, in Node', () => {
	it('refuses a global fetch to an external origin, naming the URL', () => {
		expect(() => fetch(EXTERNAL)).toThrow('This test reached the network');
		expect(() => fetch(EXTERNAL)).toThrow(EXTERNAL);
	});

	it('refuses node:https, which `fetch` does not go through', async () => {
		const https = (await import('node:https')).default;
		const http = (await import('node:http')).default;
		expect(() => https.get(EXTERNAL)).toThrow('node:https.get');
		expect(() => https.request(EXTERNAL)).toThrow('node:https.request');
		expect(() => http.get('http://demo-bucket.protomaps.com/')).toThrow('node:http.get');
		expect(() => https.request({ hostname: 'demo-bucket.protomaps.com', path: '/' })).toThrow(
			'demo-bucket.protomaps.com'
		);
	});

	it('leaves this machine alone, or nothing local could be tested at all', async () => {
		await expect(fetch('http://127.0.0.1:1/nothing')).rejects.toThrow(/fetch failed|ECONNREFUSED/);

		const http = (await import('node:http')).default;
		const attempt = http.request('http://localhost:1/nothing');
		attempt.on('error', () => undefined);
		attempt.destroy();
		expect(attempt.destroyed).toBe(true);
	});

	it('says what to do, not only that something is wrong', () => {
		const message = refusedNetworkMessage('fetch', EXTERNAL);
		expect(message).toContain(EXTERNAL);
		expect(message).toContain('FetchFn');
		expect(message).toContain('BALLASTELLA_NETWORK_TESTS');
	});
});

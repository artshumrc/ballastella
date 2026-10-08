import { describe, expect, it } from 'vitest';

const EXTERNAL = 'https://demo-bucket.protomaps.com/v4.pmtiles';

describe('the network fence, in the browser', () => {
	it('refuses every global that can leave the machine, naming the URL', () => {
		expect(() => fetch(EXTERNAL)).toThrow(EXTERNAL);
		expect(() => new XMLHttpRequest().open('GET', EXTERNAL)).toThrow('XMLHttpRequest');
		expect(() => new WebSocket('wss://example.com/socket')).toThrow('WebSocket');

		expect(() => navigator.sendBeacon('https://example.com/beacon')).toThrow(
			'navigator.sendBeacon'
		);
	});

	it('leaves Vitest’s own origin alone, which is what makes the fixtures work', async () => {
		const response = await fetch(new URL('../src/index.ts', import.meta.url).href);
		expect(response.ok).toBe(true);
	});
});

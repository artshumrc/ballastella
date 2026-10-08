import { describe, expect, it } from 'vitest';

import { encode } from '../test-support.js';
import { gitBlobSha } from './blob-sha.js';

describe('gitBlobSha', () => {
	it.each([
		['empty content', new Uint8Array(0), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'],
		['a short text blob', encode('hello'), 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0'],
		[
			'a binary blob',
			new Uint8Array([0x00, 0x01, 0x02, 0xff]),
			'f971a5e28b6c4cb237ca3c7349e33bb600dbc907'
		]
	])("gives git's SHA for %s", async (_, bytes, sha) => {
		expect(await gitBlobSha(bytes)).toBe(sha);
	});

	it('is lowercase hex, forty characters long', async () => {
		expect(await gitBlobSha(encode('anything at all'))).toMatch(/^[0-9a-f]{40}$/);
	});

	it('reads the length in bytes rather than in characters', async () => {
		expect(await gitBlobSha(encode('€'))).toBe('eca7d6d81cace4d7fdc1808a5d7619cfe98a6bde');
	});

	it('reads only the bytes it is given, not the whole of a larger buffer', async () => {
		const buffer = new Uint8Array([0xaa, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xbb]);
		expect(await gitBlobSha(buffer.subarray(1, 6))).toBe(
			'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0'
		);
	});
});

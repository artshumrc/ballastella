import { describe, expect, it } from 'vitest';

import { gitBlobSha } from './blob-sha.js';

// The values below are git's own, and the command that produced each is beside it so a future
// reader can re-derive them rather than trust them. They are the whole of the evidence that a
// browser's arithmetic agrees with the tool the Remote is running: incremental upload, conflict
// detection, and a resumed get all compare a SHA computed here against one GitHub computed, and
// if this is wrong all three are wrong together, silently, in the same direction.
describe('gitBlobSha', () => {
	const utf8 = (text: string) => new TextEncoder().encode(text);

	it("gives git's SHA for empty content", async () => {
		// printf '' | git hash-object --stdin
		await expect(gitBlobSha(new Uint8Array(0))).resolves.toBe(
			'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
		);
	});

	it("gives git's SHA for a short text blob", async () => {
		// printf 'hello' | git hash-object --stdin
		await expect(gitBlobSha(utf8('hello'))).resolves.toBe(
			'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0'
		);
	});

	it("gives git's SHA for a binary blob", async () => {
		// printf '\x00\x01\x02\xff' | git hash-object --stdin
		await expect(gitBlobSha(new Uint8Array([0x00, 0x01, 0x02, 0xff]))).resolves.toBe(
			'f971a5e28b6c4cb237ca3c7349e33bb600dbc907'
		);
	});

	it('is lowercase hex, forty characters long', async () => {
		expect(await gitBlobSha(utf8('anything at all'))).toMatch(/^[0-9a-f]{40}$/);
	});

	it('reads the length in bytes rather than in characters', async () => {
		// A three-byte character in a one-character string. `printf '€' | git hash-object --stdin`
		// says 3, so a header built from `String#length` would disagree with git for every file
		// holding a curly quote — which is most of this repository's own prose.
		expect(await gitBlobSha(utf8('€'))).toBe('eca7d6d81cace4d7fdc1808a5d7619cfe98a6bde');
	});

	it('reads only the bytes it is given, not the whole of a larger buffer', async () => {
		// A view into a longer buffer is what `Uint8Array#subarray` hands back, and a digest taken
		// over the underlying buffer rather than the view would quietly hash the neighbours too.
		const buffer = new Uint8Array([0xaa, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xbb]);
		expect(await gitBlobSha(buffer.subarray(1, 6))).toBe(
			'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0'
		);
	});
});

import { createTarDecoder, createTarPacker, packTar, unpackTar } from 'modern-tar';
import { describe, expect, it } from 'vitest';

import { collect, decode } from '../test-support.js';

const KIB = 1024;
const MIB = 1024 * 1024;

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
	const reader = stream.getReader();
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return total;
		total += value.length;
	}
}

const file = (name: string, body: string) => ({
	header: {
		name,
		size: new TextEncoder().encode(body).length,
		type: 'file' as const,
		mtime: new Date(0)
	},
	body
});

const decodeStrictly = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
	for await (const entry of stream.pipeThrough(createTarDecoder({ strict: true }))) {
		await drain(entry.body);
	}
};

describe('a path longer than tar’s name field survives a round trip', () => {
	const uuid = '0189a4c3-1c2f-7f1e-9b3a-0f2e5d6c7a8b';
	const sixtyFour = 'p'.repeat(64);

	const paths: readonly (readonly [string, string])[] = [
		['an ordinary short path', 'a-project/project.json'],
		['a 64-character Project directory’s annotation', `${sixtyFour}/annotations/${uuid}.geojson`],
		['exactly 100 bytes', `${'a'.repeat(87)}/${'b'.repeat(12)}`],
		['exactly 101 bytes', `${'a'.repeat(88)}/${'b'.repeat(12)}`],
		['exactly 256 bytes', `${'a'.repeat(120)}/${'b'.repeat(135)}`],
		['exactly 257 bytes', `${'a'.repeat(121)}/${'b'.repeat(135)}`],
		['150 bytes with no separator', 'x'.repeat(150)],
		['300 bytes with no separator', 'y'.repeat(300)],
		['a Devanagari Workspace name', 'अंकन-२०२६/project.json'],
		['a Devanagari name at annotation depth', `${'अ'.repeat(40)}/annotations/${uuid}.geojson`],
		['a CJK Workspace name', '標記二〇二六/images/abc/info.json'],
		['an Arabic Workspace name', 'ترميز ٢٠٢٦/project.json'],
		['a name with an emoji', 'Marking 2026 🗺️/project.json'],
		['a non-ASCII path near 200 bytes', `${'é'.repeat(80)}/${'ü'.repeat(19)}`]
	];

	it.for(paths)('%s', async ([, path]) => {
		const body = `content of ${path}`;
		const archive = await packTar([file(path, body)]);

		const [entry, ...rest] = await unpackTar(archive, { strict: true });

		expect(rest).toEqual([]);
		expect(entry?.header.name).toBe(path);
		expect(new TextDecoder().decode(entry?.data)).toBe(body);
	});

	it('carries a long path even when the entry is empty', async () => {
		const path = `${sixtyFour}/annotations/${uuid}.geojson`;
		const archive = await packTar([
			{ header: { name: path, size: 0, type: 'file', mtime: new Date(0) } }
		]);
		const [entry] = await unpackTar(archive, { strict: true });
		expect(entry?.header.name).toBe(path);
		expect(entry?.data?.length).toBe(0);
	});
});

describe('packing streams rather than buffering the archive', () => {
	it('emits the archive as the entry is written, not after it', async () => {
		const { readable, controller } = createTarPacker();

		let emitted = 0;
		const reader = readable.getReader();
		const consumer = (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				emitted += value.length;
			}
		})();

		const total = 4 * MIB;
		const chunk = new Uint8Array(64 * KIB);
		const writer = controller.add({ name: 'big.bin', size: total, type: 'file' }).getWriter();
		let emittedAtHalfway = -1;
		for (let written = 0; written < total; written += chunk.length) {
			await writer.write(chunk);
			if (written + chunk.length >= total / 2 && emittedAtHalfway < 0) emittedAtHalfway = emitted;
		}
		await writer.close();
		controller.finalize();
		await consumer;

		expect(emittedAtHalfway).toBeGreaterThan(total / 2 - 64 * KIB);
		expect(emitted).toBe(total + 1536);
	});

	it('stops accepting writes when the sink stops reading', async () => {
		const { readable, controller } = createTarPacker();
		const chunk = new Uint8Array(64 * KIB);
		const writer = controller.add({ name: 'big.bin', size: 1024 * MIB, type: 'file' }).getWriter();
		let accepted = 0;
		let stalled = false;
		for (let i = 0; i < 1024; i += 1) {
			const outcome = await Promise.race([
				writer.write(chunk).then(() => 'accepted' as const),
				new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 500))
			]);
			if (outcome === 'stalled') {
				stalled = true;
				break;
			}
			accepted += chunk.length;
		}

		expect(stalled).toBe(true);
		expect(accepted).toBeLessThan(16 * MIB);
		void readable;
	});
});

describe('unpacking streams rather than buffering the archive', () => {
	it('does not pull a whole entry before handing over its body', async () => {
		const entrySize = 64 * MIB;
		const { readable, controller } = createTarPacker();
		const body = controller.add({ name: 'big.bin', size: entrySize, type: 'file' });
		let produced = 0;
		const producing = (async () => {
			const writer = body.getWriter();
			const chunk = new Uint8Array(64 * KIB);
			for (let i = 0; i < entrySize / chunk.length; i += 1) {
				await writer.write(chunk);
				produced += chunk.length;
			}
			await writer.close();
			controller.finalize();
		})();
		producing.catch(() => undefined);

		const entries = readable.pipeThrough(createTarDecoder({ strict: true }));
		const reader = entries.getReader();
		const { value: entry } = await reader.read();
		expect(entry?.header.name).toBe('big.bin');
		expect(entry?.header.size).toBe(entrySize);

		await new Promise((resolve) => setTimeout(resolve, 1000));

		expect(produced).toBeLessThan(entrySize / 2);

		await entry?.body.cancel();
		await reader.cancel();
	});

	it('never runs more than a bounded distance ahead of a slow consumer', async () => {
		const count = 4;
		const each = 8 * MIB;

		const { readable, controller } = createTarPacker();
		let produced = 0;
		const producing = (async () => {
			for (let i = 0; i < count; i += 1) {
				const writer = controller
					.add({ name: `tiles/${i}.jpg`, size: each, type: 'file', mtime: new Date(0) })
					.getWriter();
				for (let j = 0; j < each / (64 * KIB); j += 1) {
					await writer.write(new Uint8Array(64 * KIB));
					produced += 64 * KIB;
				}
				await writer.close();
			}
			controller.finalize();
		})();

		let consumed = 0;
		let widestGap = 0;
		for await (const entry of readable.pipeThrough(createTarDecoder({ strict: true }))) {
			const reader = entry.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				consumed += value.length;
				widestGap = Math.max(widestGap, produced - consumed);
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}
		await producing;

		expect(consumed).toBe(count * each);
		expect(widestGap).toBeLessThan(16 * MIB);
		expect(widestGap).toBeLessThan((count * each) / 2);
	}, 120_000);
});

describe('a damaged archive is refused rather than silently shortened', () => {
	it('throws on a truncated archive instead of yielding a short one', async () => {
		const archive = await packTar([file('a.txt', 'aaaa'), file('b.txt', 'bbbb')]);

		for (const cut of [300, 600, 1100, 1536, archive.length - 1024, archive.length - 512]) {
			await expect(decodeStrictly(new Blob([archive.subarray(0, cut)]).stream())).rejects.toThrow(
				/truncated/i
			);
		}
	});

	it('throws on a corrupted header checksum in strict mode', async () => {
		const damaged = (await packTar([file('a.txt', 'aaaa')])).slice();
		damaged[3] = (damaged[3] ?? 0) ^ 0xff;

		await expect(decodeStrictly(new Blob([damaged]).stream())).rejects.toThrow();
	});
});

describe('an archive is byte-reproducible when its entry times are constant', () => {
	const build = (): Promise<Uint8Array> =>
		packTar([
			file('a-project/project.json', '{}'),
			file(`${'p'.repeat(64)}/annotations/0189a4c3-1c2f-7f1e-9b3a-0f2e5d6c7a8b.geojson`, '{}')
		]);

	it('produces identical bytes twice over, long paths included', async () => {
		expect(await build()).toEqual(await build());
	});

	it('does not, when the entry time is left to the clock', async () => {
		const withoutMtime = (): Promise<Uint8Array> =>
			packTar([{ header: { name: 'a', size: 1, type: 'file' }, body: 'x' }]);
		const first = await withoutMtime();
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(await withoutMtime()).not.toEqual(first);
	});
});

describe('a PAX entry is not mistaken for a file', () => {
	it('hides the PaxHeader pseudo-entry from the caller, buffered or streamed', async () => {
		const long = `${'p'.repeat(121)}/${'q'.repeat(140)}/file.json`;
		const archive = await packTar([file(long, 'abc')]);
		const entries = await unpackTar(archive, { strict: true });
		expect(entries.map((entry) => entry.header.name)).toEqual([long]);
		expect(new TextEncoder().encode(long).length).toBeGreaterThan(256);
		expect(new TextDecoder('latin1').decode(archive)).toContain('PaxHeader');

		const seen: string[] = [];
		for await (const entry of new Blob([archive])
			.stream()
			.pipeThrough(createTarDecoder({ strict: true }))) {
			seen.push(entry.header.name);
			expect(decode(await collect(entry.body))).toBe('abc');
		}
		expect(seen).toEqual([long]);
	});
});

// ADR-0024 justifies moving Workspace transfer off zip and onto tar on two properties of
// `modern-tar` that were, when the ADR was written, taken from its README: that it **streams** in
// both directions, and that it carries paths past tar's 100-byte `name` field through **USTAR
// `prefix` or PAX**. Neither may be built on unverified.
//
// This file is that verification, and it is deliberately a test rather than a paragraph.
// `tile-cache.test.ts` makes the same move for its tile counts — it asserts the totals so the figures
// in the module comment cannot rot unnoticed — and the reasoning is identical here, only stronger: the
// numbers in `pnpm-workspace.yaml`'s `modern-tar` entry and in `workspace-tar.ts`'s header are the
// numbers this file measures, so a `modern-tar` upgrade that quietly starts buffering whole entries
// turns this red instead of turning a scholar's iPad restore into an out-of-memory crash.
//
// **Every assertion here is a measurement of the library, not of our code.** Nothing in
// `packages/core` is imported. That is the point: this is the premise, and `workspace-tar.test.ts`
// is what we built on it.

import { createTarDecoder, createTarPacker, packTar, unpackTar } from 'modern-tar';
import { describe, expect, it } from 'vitest';

const KIB = 1024;
const MIB = 1024 * 1024;

/** Read a stream to its end, returning only the total length — never the bytes. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
	const reader = stream.getReader();
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return total;
		total += value.length;
	}
}

/** Concatenate a stream into one buffer. Only ever used on archives small enough to hold. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

describe('a path longer than tar’s name field survives a round trip', () => {
	// The 100-byte `name` field is the whole reason this needs asserting. Two mechanisms carry a
	// longer path — USTAR's 155-byte `prefix`, good to 256 bytes when there is a `/` in the right
	// place, and a PAX `path` record beyond that — and which one applies is not something a caller
	// chooses. So the assertion is on the *outcome*: the name that comes back is the name that went
	// in, byte for byte, whichever mechanism carried it.
	//
	// These are not invented lengths. `<project-dir-up-to-64>/annotations/<uuid>.geojson` is the
	// real shape ADR-0024 names, and the leading directory is a **Workspace or Project name the user
	// typed**, so it can be Devanagari, CJK, Arabic, or emoji. `toWorkspaceName` keeps every one of
	// those spellings intact, and a backup that mangled one would undo that care.
	const uuid = '0189a4c3-1c2f-7f1e-9b3a-0f2e5d6c7a8b';
	const sixtyFour = 'p'.repeat(64);

	const paths: readonly (readonly [string, string])[] = [
		['an ordinary short path', 'a-project/project.json'],
		// The headline case: a Project directory at the 64-character limit
		// `toDirectoryName` allows, plus the annotation path under it. 121 bytes.
		['a 64-character Project directory’s annotation', `${sixtyFour}/annotations/${uuid}.geojson`],
		// Straddling the 100-byte boundary exactly, from both sides, because an off-by-one in a
		// length check is the failure this class of bug actually takes.
		['exactly 100 bytes', `${'a'.repeat(87)}/${'b'.repeat(12)}`],
		['exactly 101 bytes', `${'a'.repeat(88)}/${'b'.repeat(12)}`],
		// Straddling the 256-byte boundary, where USTAR `prefix` stops being able to carry it and a
		// PAX record has to take over.
		['exactly 256 bytes', `${'a'.repeat(120)}/${'b'.repeat(135)}`],
		['exactly 257 bytes', `${'a'.repeat(121)}/${'b'.repeat(135)}`],
		// No `/` at all, so there is no split point and `prefix` cannot help at any length.
		['150 bytes with no separator', 'x'.repeat(150)],
		['300 bytes with no separator', 'y'.repeat(300)],
		// User data. A Workspace name is whatever the scholar typed.
		['a Devanagari Workspace name', 'अंकन-२०२६/project.json'],
		['a Devanagari name at annotation depth', `${'अ'.repeat(40)}/annotations/${uuid}.geojson`],
		['a CJK Workspace name', '標記二〇二六/images/abc/info.json'],
		['an Arabic Workspace name', 'ترميز ٢٠٢٦/project.json'],
		// An emoji outside the BMP, so the name is longer in code units than in code points and
		// longer again in UTF-8 bytes — three different lengths, which is where a truncating
		// writer cuts a surrogate pair in half.
		['a name with an emoji', 'Marking 2026 🗺️/project.json'],
		// Non-ASCII long enough that byte length and code-point length disagree across the
		// boundary: 199 bytes in 100 code points.
		['a non-ASCII path near 200 bytes', `${'é'.repeat(80)}/${'ü'.repeat(19)}`]
	];

	it.for(paths)('%s', async ([, path]) => {
		const body = `content of ${path}`;
		const bytes = new TextEncoder().encode(body);
		const archive = await packTar([
			{ header: { name: path, size: bytes.length, type: 'file', mtime: new Date(0) }, body: bytes }
		]);

		const [entry, ...rest] = await unpackTar(archive, { strict: true });

		expect(rest).toEqual([]);
		// The name, exactly. Not "starts with", not normalised — a Workspace name is its directory
		// name in both backings, so a name that comes back different is a Workspace that restores
		// under the wrong name.
		expect(entry?.header.name).toBe(path);
		expect(new TextDecoder().decode(entry?.data)).toBe(body);
	});

	it('carries a long path even when the entry is empty', async () => {
		// A zero-length file has no body blocks for a length mismatch to hide in, so it isolates the
		// header. `annotations/` legitimately holds empty GeoJSON in a Project nobody has drawn in.
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
		// The claim is not "it finishes"; it is that bytes leave before the entry is complete. So the
		// measurement is: at the half-way point of writing one 4 MiB entry, how much has already gone
		// downstream? A writer that buffered the entry would answer zero.
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

		// Measured at modern-tar 0.8.2: 2,163,200 B emitted by the half-way mark of a 4 MiB entry —
		// the entry's own bytes, one 512-byte header ahead of them. Asserted as "at least most of
		// the way", rather than to the byte, because the exact figure is a chunk boundary; what has
		// to hold is that it is not zero and not a small constant.
		expect(emittedAtHalfway).toBeGreaterThan(total / 2 - 64 * KIB);
		// And the whole archive is the entry plus its header plus padding plus the two zero blocks
		// that end it — 1,536 B of overhead on one entry, not a second copy of the data.
		expect(emitted).toBe(total + 1536);
	});

	it('stops accepting writes when the sink stops reading', async () => {
		// Backpressure is the half of "streaming" that a naive implementation gets wrong: it can
		// emit incrementally and still accept unbounded input, which puts the archive in the heap by
		// another route. Nothing reads `readable` here, so `write()` must eventually stop resolving.
		const { readable, controller } = createTarPacker();
		const chunk = new Uint8Array(64 * KIB);
		const writer = controller.add({ name: 'big.bin', size: 1024 * MIB, type: 'file' }).getWriter();

		let accepted = 0;
		let stalled = false;
		// 1024 MiB declared, but we give up long before that: 64 MiB of accepted writes into a sink
		// nobody is reading would already disprove the bound this asserts.
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
		// Measured at modern-tar 0.8.2: 8,323,072 B — about 7.94 MiB, the default high-water marks
		// of the stream chain. Bounded is the property; 16 MiB is the ceiling this pins it under, so
		// a regression to "buffers everything" fails here rather than in a scholar's browser.
		expect(accepted).toBeLessThan(16 * MIB);
		void readable;
	});
});

describe('unpacking streams rather than buffering the archive', () => {
	it('does not pull a whole entry before handing over its body', async () => {
		// The measurement that matters for restore on an iPad. One 64 MiB entry is produced by a
		// packer; the decoder is given the header and then we simply **do not read the body**. If the
		// decoder buffered entries, the producer would run to completion regardless. It must instead
		// stall a few megabytes in.
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
		// The producer is expected never to finish here, and its rejection on cancel is not a
		// failure of this test.
		producing.catch(() => undefined);

		const entries = readable.pipeThrough(createTarDecoder({ strict: true }));
		const reader = entries.getReader();
		const { value: entry } = await reader.read();
		expect(entry?.header.name).toBe('big.bin');
		expect(entry?.header.size).toBe(entrySize);

		// Let everything that can settle, settle, while the body is held unread.
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Measured at modern-tar 0.8.2: **9,437,184 B — 9.00 MiB — of the 64 MiB entry above.**
		//
		// ⚠ The entry size is named from `entrySize` rather than written into this sentence, because
		// the sentence and the code had already drifted once: the comment said 256 MiB while the test
		// ran 64 MiB, and that wrong figure was copied into `pnpm-workspace.yaml`. A number in prose
		// beside a number in code is a number that will disagree with it.
		//
		// Asserted as a fraction rather than as the figure, so the bound survives a change in the
		// stream chain's high-water marks: what must never happen is the producer reaching the end,
		// which is what "buffers the entry" looks like.
		expect(produced).toBeLessThan(entrySize / 2);

		await entry?.body.cancel();
		await reader.cancel();
	});

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// ⚠ THERE IS NO MEMORY-FIGURE TEST HERE, AND THAT IS A DECISION WITH A HISTORY
	//
	// What has to be shown is that restore does not hold the whole archive, by **peak usage** or by
	// **streamed consumption**. Three attempts were made at *peak usage*, and all three produced a
	// number that could not be trusted:
	//
	//   1. **Peak `heapUsed` growth** across a 512 MiB round trip. Reported 2.80 MiB, and that figure
	//      was published in `pnpm-workspace.yaml` and in two module headers before review caught it. It
	//      measured **nothing**: a `Uint8Array`'s payload is external memory and does not appear in
	//      `heapUsed` at all. Measured against a consumer deliberately retaining every chunk — the
	//      exact bug the assertion existed to catch:
	//
	//          streaming consumer   heapUsed +3.17 MiB   arrayBuffers  +18.44 MiB
	//          retaining consumer   heapUsed +5.24 MiB   arrayBuffers +512.00 MiB
	//
	//      A bound of 64 MiB on `heapUsed` passes just as comfortably for a consumer holding the whole
	//      archive as for one holding none of it.
	//   2. **Peak `arrayBuffers` during the run.** Dominated by allocation churn rather than by what is
	//      held: a fresh 64 KiB buffer per write means thousands become garbage immediately and sit
	//      uncollected, so the figure tracks when the collector last ran. Measured swinging between
	//      3.9 MiB and 22.3 MiB for identical work, and once reporting the *retaining* consumer as
	//      cheaper than the streaming one.
	//   3. **`arrayBuffers` retained after a forced `gc()`.** The right question, and unavailable:
	//      `globalThis.gc` is undefined under vitest, and getting `--expose-gc` to the worker means
	//      changing the pool configuration for all 1,100 tests in this project to serve one assertion.
	//
	// So this file asserts **streamed consumption**, the alternative, measured in bytes moved through a
	// stream rather than in bytes the collector has got round to freeing. It is deterministic, it needs
	// no runtime flag, and it is already asserted three times over: the packer stalls its writer into
	// an unread sink (above), the decoder stalls its producer 9.00 MiB into a 64 MiB entry whose body
	// is held unread (above), and `workspace-tar.test.ts` shows restore writing files while most of the
	// archive is still unread and never letting the unwritten backlog exceed a constant.
	//
	// **The measurement below is the whole-archive version of that**, and it is the one that would
	// catch a decoder that accumulated across entries rather than within one.
	it('never runs more than a bounded distance ahead of a slow consumer', async () => {
		// 32 MiB in 8 MiB entries, consumed slowly. What is measured is how far the *producer* gets
		// while the consumer dawdles: a decoder that buffered would let it run to the end.
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
				// Yield, so the producer has every opportunity to run ahead if it is going to.
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}
		await producing;

		expect(consumed).toBe(count * each);
		// Measured at modern-tar 0.8.2: the producer never gets more than ~9 MiB ahead, whatever the
		// archive's size — the stream chain's own high-water marks and nothing more. Asserted under
		// 16 MiB, and separately as less than half the archive so the bound cannot be satisfied by an
		// archive that simply got smaller.
		expect(widestGap).toBeLessThan(16 * MIB);
		expect(widestGap).toBeLessThan((count * each) / 2);
	}, 120_000);
});

describe('a damaged archive is refused rather than silently shortened', () => {
	// This is the specific failure ADR-0024 escaped. The zip reader read a 70,000-entry archive back as 4,464
	// files **with no error at all**, and the only reason anybody noticed was a test that counted.
	// A backup format whose truncation is silent is not a backup format, so the contrast is
	// asserted rather than assumed.
	it('throws on a truncated archive instead of yielding a short one', async () => {
		const archive = await packTar([
			{ header: { name: 'a.txt', size: 4, type: 'file', mtime: new Date(0) }, body: 'aaaa' },
			{ header: { name: 'b.txt', size: 4, type: 'file', mtime: new Date(0) }, body: 'bbbb' }
		]);

		// Cut inside the first header, inside the first body, between entries, and one block short of
		// the end-of-archive marker. Every one of them has to be an error.
		for (const cut of [300, 600, 1100, 1536, archive.length - 1024, archive.length - 512]) {
			const truncated = new Blob([archive.subarray(0, cut)]).stream();
			await expect(
				(async () => {
					for await (const entry of truncated.pipeThrough(createTarDecoder({ strict: true }))) {
						await drain(entry.body);
					}
				})()
			).rejects.toThrow(/truncated/i);
		}
	});

	it('throws on a corrupted header checksum in strict mode', async () => {
		const archive = await packTar([
			{ header: { name: 'a.txt', size: 4, type: 'file', mtime: new Date(0) }, body: 'aaaa' }
		]);
		// Flip a byte inside the name field. The checksum no longer agrees with the block.
		const damaged = archive.slice();
		damaged[3] = (damaged[3] ?? 0) ^ 0xff;

		await expect(
			(async () => {
				for await (const entry of new Blob([damaged])
					.stream()
					.pipeThrough(createTarDecoder({ strict: true }))) {
					await drain(entry.body);
				}
			})()
		).rejects.toThrow();
	});
});

describe('an archive is byte-reproducible when its entry times are constant', () => {
	// Byte-reproducibility is what lets the round-trip test assert *lossless* rather than
	// *plausible*, and it is a property of how we call the library rather than of the library. Both
	// halves are asserted, because the failing half is the one a future edit would reintroduce by
	// dropping an `mtime`.
	const build = (): Promise<Uint8Array> =>
		packTar([
			{
				header: { name: 'a-project/project.json', size: 2, type: 'file', mtime: new Date(0) },
				body: '{}'
			},
			{
				header: {
					name: `${'p'.repeat(64)}/annotations/0189a4c3-1c2f-7f1e-9b3a-0f2e5d6c7a8b.geojson`,
					size: 2,
					type: 'file',
					mtime: new Date(0)
				},
				body: '{}'
			}
		]);

	it('produces identical bytes twice over, long paths included', async () => {
		expect(await build()).toEqual(await build());
	});

	it('does not, when the entry time is left to the clock', async () => {
		// The control. Without this, "we pass a constant mtime" is a line of code nothing depends on,
		// and the reproducibility assertion above could pass for the wrong reason.
		const withoutMtime = (): Promise<Uint8Array> =>
			packTar([{ header: { name: 'a', size: 1, type: 'file' }, body: 'x' }]);
		const first = await withoutMtime();
		// Tar records mtime in whole seconds, so the clock has to actually tick to differ.
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(await withoutMtime()).not.toEqual(first);
	});

	it('round-trips a constant entry time exactly', async () => {
		const mtime = new Date(0);
		const archive = await packTar([
			{ header: { name: 'a', size: 1, type: 'file', mtime }, body: 'x' }
		]);
		const [entry] = await unpackTar(archive, { strict: true });
		expect(entry?.header.mtime?.getTime()).toBe(mtime.getTime());
	});
});

describe('there is no entry-count ceiling', () => {
	it('writes and reads back more entries than a zip can index', async () => {
		// 70,000 — the exact number that produced a zip claiming 4,464. A zip's 16-bit count wraps
		// here; tar has no count to wrap, having no central directory at all. The assertion is on the
		// **entry count read back**, which is the assertion that caught the zip writer.
		const count = 70_000;
		const { readable, controller } = createTarPacker();

		const producing = (async () => {
			const one = new Uint8Array([7]);
			for (let i = 0; i < count; i += 1) {
				const writer = controller
					.add({ name: `tiles/${i}.jpg`, size: 1, type: 'file', mtime: new Date(0) })
					.getWriter();
				await writer.write(one);
				await writer.close();
			}
			controller.finalize();
		})();

		let read = 0;
		let bytes = 0;
		for await (const entry of readable.pipeThrough(createTarDecoder({ strict: true }))) {
			read += 1;
			bytes += await drain(entry.body);
		}
		await producing;

		expect(read).toBe(count);
		expect(bytes).toBe(count);
	}, 120_000);
});

describe('a PAX entry is not mistaken for a file', () => {
	it('hides the PaxHeader pseudo-entry from the caller', async () => {
		// A long path is carried by writing an extra `pax-header` entry ahead of the real one. A
		// decoder that surfaced it would give restore a file called `PaxHeader/...` to write, which
		// is litter in the user's Workspace at best. Asserted because it is the kind of thing a
		// reader assumes.
		const long = `${'p'.repeat(121)}/${'q'.repeat(140)}/file.json`;
		const archive = await packTar([
			{ header: { name: long, size: 1, type: 'file', mtime: new Date(0) }, body: 'x' }
		]);
		const entries = await unpackTar(archive, { strict: true });
		expect(entries.map((entry) => entry.header.name)).toEqual([long]);
		// And the archive really did need PAX: the path is past what `prefix` can carry.
		expect(new TextEncoder().encode(long).length).toBeGreaterThan(256);
		// The pseudo-entry is in the bytes even though it is not in the parse, which is what makes
		// the assertion above meaningful rather than vacuous.
		expect(new TextDecoder('latin1').decode(archive)).toContain('PaxHeader');
	});

	it('streams a long-path entry through the decoder too, not only the buffered helper', async () => {
		// `unpackTar` and `createTarDecoder` are separate code paths, and restore uses the streaming
		// one. Long paths have to work there as well, which is not something the buffered helper's
		// passing establishes.
		const long = `${'p'.repeat(121)}/${'q'.repeat(140)}/file.json`;
		const archive = await packTar([
			{ header: { name: long, size: 3, type: 'file', mtime: new Date(0) }, body: 'abc' }
		]);
		const seen: string[] = [];
		for await (const entry of new Blob([archive])
			.stream()
			.pipeThrough(createTarDecoder({ strict: true }))) {
			seen.push(entry.header.name);
			expect(new TextDecoder().decode(await collect(entry.body))).toBe('abc');
		}
		expect(seen).toEqual([long]);
	});
});

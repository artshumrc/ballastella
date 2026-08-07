import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath, WritablePath } from '../store/project-store.js';
import { newAlignment, type Alignment, type ControlPoint } from './alignment.js';
import { writeAlignmentFile, type AlignmentFilePort } from './alignment-file.js';
import { parseAlignment, serialiseAlignment } from './georeference-annotation.js';

// Ticket 18's whole subject: `alignments/<image-id>.json` belongs to the Workspace and is shared by
// every Project that draws the map (ADR-0023), so a write that does not ask what is already there
// can destroy Control Points somebody placed in a Project nobody has open.
//
// **The unguarded direction is what is asserted here**, not merely the guarded one. A test that only
// checks "the starter is written when there is no file" passes just as happily against a blind
// overwrite, which is how two tickets in this epic shipped one.

const IMAGE = { width: 4000, height: 3000 };
const IMAGE_ID = 'floride-1657';

const path = `alignments/${IMAGE_ID}.json`;

const point = (ordinal: number): ControlPoint => ({
	id: `p${ordinal}`,
	ordinal,
	resource: { x: 100 * ordinal, y: 200 * ordinal },
	geo: { lng: 4.9 + ordinal / 100, lat: 52.37 + ordinal / 100 }
});

/** Somebody's afternoon: an Alignment with Control Points in it. */
const workedOn = (): Alignment => ({
	...newAlignment(IMAGE_ID, IMAGE),
	controlPoints: [point(1), point(2), point(3)]
});

/**
 * The port, with every commit counted.
 *
 * **Counted rather than compared**, which is the same discipline `editor-align-route.e2e.ts` keeps
 * and for the same reason: byte-identity cannot tell an idempotent rewrite from no write at all, and
 * for a file in a git or Dropbox Workspace the rewrite is the thing that is wrong.
 */
function port(store: MemoryProjectStore): AlignmentFilePort & { commits: StorePath[] } {
	const commits: StorePath[] = [];
	return {
		commits,
		read: (at: StorePath) => store.read(at),
		commit: async (at: WritablePath, bytes: Bytes) => {
			commits.push(at);
			await store.write(at, bytes);
		}
	};
}

const read = async (store: MemoryProjectStore): Promise<Alignment> =>
	parseAlignment(await store.read(path), { imageId: IMAGE_ID });

/** Put a document on disk without going through the writer, which is what a fixture is for. */
const seed = (store: MemoryProjectStore, bytes: Bytes): Promise<void> =>
	// alignment-write-is-the-fixture: the state each case starts from, which is the thing under test rather than a write the app makes
	store.write(path, bytes);

describe('create — write only if there is nothing worth keeping', () => {
	it('writes the starter when the map has no Alignment at all', async () => {
		const store = new MemoryProjectStore();
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'create' }
		});

		expect(outcome).toBe('written');
		expect(io.commits).toEqual([path]);
		expect((await read(store)).resourceMask).toHaveLength(4);
	});

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE DEFECT THIS TICKET EXISTS FOR
	 *
	 * A remote resource's image id is `generateId(uri)`, the same for everybody. Align a Library map
	 * in Project A and place Control Points; add the same map to Project B months later and accept
	 * the community Alignment Allmaps happens to have. Under a blind write, Project A's placement is
	 * gone — silently, from a gesture that said nothing about Project A.
	 */
	it('keeps Control Points somebody placed rather than writing a community offer over them', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(workedOn()));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			// The community offer: a different placement of the same sheet.
			alignment: { ...newAlignment(IMAGE_ID, IMAGE), controlPoints: [point(7), point(8)] },
			write: { intent: 'create' }
		});

		expect(outcome).toBe('kept over the offer');
		// Not one write, not an identical one. Nothing.
		expect(io.commits).toEqual([]);
		expect((await read(store)).controlPoints.map((p) => p.resource.x)).toEqual([100, 200, 300]);
	});

	it('writes the offer over a starter nobody has touched, because there is nothing to lose', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(newAlignment(IMAGE_ID, IMAGE)));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: workedOn(),
			write: { intent: 'create' }
		});

		expect(outcome).toBe('written');
		expect((await read(store)).controlPoints).toHaveLength(3);
	});

	/**
	 * The Resource Mask is editable without placing a single Control Point, so "untouched" cannot be
	 * `controlPoints.length === 0`: a count would read a carefully cropped sheet as untouched and
	 * throw the crop away.
	 */
	it('treats a cropped sheet with no Control Points as work, not as an untouched starter', async () => {
		const store = new MemoryProjectStore();
		const cropped: Alignment = {
			...newAlignment(IMAGE_ID, IMAGE),
			resourceMask: [
				{ x: 10, y: 10 },
				{ x: 3990, y: 10 },
				{ x: 3990, y: 2990 },
				{ x: 10, y: 2990 }
			]
		};
		await seed(store, serialiseAlignment(cropped));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: workedOn(),
			write: { intent: 'create' }
		});

		expect(outcome).toBe('kept over the offer');
		expect(io.commits).toEqual([]);
		expect((await read(store)).resourceMask[0]).toEqual({ x: 10, y: 10 });
	});

	it('re-adding a map that is already aligned writes nothing and says nothing happened', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(workedOn()));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'create' }
		});

		// The ordinary re-add. Not worth a word to anybody, and not a write.
		expect(outcome).toBe('left alone');
		expect(io.commits).toEqual([]);
	});

	it('rewrites nothing when the starter it would write is already there', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(newAlignment(IMAGE_ID, IMAGE)));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'create' }
		});

		expect(outcome).toBe('left alone');
		// An identical rewrite is still a diff in a git Workspace and a sync event in a Dropbox one.
		expect(io.commits).toEqual([]);
	});

	it('keeps the file when the store cannot say whether there is one', async () => {
		// A revoked folder grant or a backend that is down. `'worked on'` is the safe direction: the
		// cost of a false "there is one" is a starter Alignment the next add writes, and the cost of a
		// false "there is none" is somebody's afternoon.
		const store = new MemoryProjectStore();
		const io: AlignmentFilePort = {
			read: () => Promise.reject(new Error('the folder is no longer reachable')),
			commit: (at, bytes) => store.write(at, bytes)
		};

		const outcome = await writeAlignmentFile(io, {
			alignment: workedOn(),
			write: { intent: 'create' }
		});

		expect(outcome).toBe('kept over the offer');
		expect(store.snapshot().size).toBe(0);
	});
});

describe('update — the user is editing the Alignment in front of them', () => {
	it('writes over what is there, because that is what the user has open', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(newAlignment(IMAGE_ID, IMAGE)));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: workedOn(),
			write: { intent: 'update' }
		});

		expect(outcome).toBe('written');
		expect(io.commits).toEqual([path]);
		expect((await read(store)).controlPoints).toHaveLength(3);
	});
});

describe('replace — the user said to discard what is there, in words', () => {
	it('writes over an Alignment somebody worked on, having named what is lost', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(workedOn()));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'replace', discarding: '3 Control Points, used by Amsterdam 1625' }
		});

		expect(outcome).toBe('written');
		expect((await read(store)).controlPoints).toEqual([]);
	});
});

describe('the address the file names its image by (ADR-0007)', () => {
	it('goes through the one writer rather than being edited into its output', async () => {
		const store = new MemoryProjectStore();
		const io = port(store);

		await writeAlignmentFile(io, {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'create' },
			address: { imageService: 'https://iiif.library.example/iiif/3/plan' }
		});

		const document = JSON.parse(new TextDecoder().decode(await store.read(path)));
		expect(document.target.source.id).toBe('https://iiif.library.example/iiif/3/plan');
	});

	it('measures "untouched" against a starter at the same address, not a placeholder one', async () => {
		// Otherwise a referenced map's own starter never looks untouched, and the community offer the
		// user just accepted on the add is refused for protecting a file with nothing in it.
		const address = { imageService: 'https://iiif.library.example/iiif/3/plan' };
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(newAlignment(IMAGE_ID, IMAGE), address));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: workedOn(),
			write: { intent: 'create' },
			address
		});

		expect(outcome).toBe('written');
		expect((await read(store)).controlPoints).toHaveLength(3);
	});
});

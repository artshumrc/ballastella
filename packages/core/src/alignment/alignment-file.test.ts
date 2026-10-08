import { describe, expect, it } from 'vitest';

import { Autosave } from '../autosave/autosave.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { serialiseJson, type Bytes, type StorePath } from '../store/project-store.js';
import { decode } from '../test-support.js';
import { seedAlignmentFixture } from './alignment-fixture.js';
import { alignmentPath, newAlignment, type Alignment, type ControlPoint } from './alignment.js';
import {
	writeAlignmentFileReporting,
	type AlignmentFilePort,
	type AlignmentWrite
} from './alignment-file.js';
import {
	parseAlignment,
	serialiseAlignment,
	type AlignmentAddress
} from './georeference-annotation.js';

const IMAGE = { width: 4000, height: 3000 };
const IMAGE_ID = 'floride-1657';
const LIBRARY = { imageService: 'https://iiif.library.example/iiif/3/plan' };
const path = `alignments/${IMAGE_ID}.json`;

const point = (ordinal: number): ControlPoint => ({
	id: `p${ordinal}`,
	ordinal,
	resource: { x: 100 * ordinal, y: 200 * ordinal },
	geo: { lng: 4.9 + ordinal / 100, lat: 52.37 + ordinal / 100 }
});

const starter = (): Alignment => newAlignment(IMAGE_ID, IMAGE);
const workedOn = (): Alignment => ({ ...starter(), controlPoints: [point(1), point(2), point(3)] });

// Counts commits, because an identical rewrite is invisible in the file's bytes.
function port(store: MemoryProjectStore): AlignmentFilePort & { commits: StorePath[] } {
	const commits: StorePath[] = [];
	return {
		commits,
		read: (at) => store.read(at),
		commit: async (at, bytes) => {
			commits.push(at);
			await store.write(at, bytes);
		}
	};
}

const unreadable = (store: MemoryProjectStore, reason: string): AlignmentFilePort => ({
	read: () => Promise.reject(new Error(reason)),
	commit: (at, bytes) => store.write(at, bytes)
});

async function holding(bytes?: Bytes): Promise<MemoryProjectStore> {
	const store = new MemoryProjectStore();
	if (bytes) await seedAlignmentFixture(store, IMAGE_ID, bytes);
	return store;
}

const read = async (store: MemoryProjectStore): Promise<Alignment> =>
	parseAlignment(await store.read(path), { imageId: IMAGE_ID });

const write = (
	store: MemoryProjectStore | AlignmentFilePort,
	alignment: Alignment,
	intent: AlignmentWrite,
	address?: AlignmentAddress
) =>
	writeAlignmentFileReporting(store instanceof MemoryProjectStore ? port(store) : store, {
		alignment,
		write: intent,
		...(address ? { address } : {})
	});

const CREATE = { intent: 'create' } as const;

// The @ts-expect-error lines are the assertion: tsc fails if the brand is removed or widened.
describe('the type refuses a blind write', () => {
	const store = new MemoryProjectStore();
	const autosave = new Autosave(store);
	const bytes = new Uint8Array([1]) as Bytes;

	it('refuses an AlignmentPath at every verb that reaches the store', () => {
		// @ts-expect-error an Alignment is written through alignment-file.ts, never through the store
		void store.write(alignmentPath(IMAGE_ID), bytes);
		// @ts-expect-error `commit` is the editor's route to the store, and it is closed too
		void autosave.commit(alignmentPath(IMAGE_ID), bytes);
		// @ts-expect-error and so is `queue`, whose bytes reach `store.write` on the debounce
		void autosave.queue(alignmentPath(IMAGE_ID), bytes);

		expect(alignmentPath(IMAGE_ID)).toBe('alignments/floride-1657.json');
	});

	it('still allows every other path, which is what makes the brand affordable', () => {
		void store.write('amsterdam-1625/project.json', bytes);
		void store.write(`images/${IMAGE_ID}/info.json`, bytes);
		void autosave.queue('amsterdam-1625/annotations/l1.geojson', bytes);
		expect(true).toBe(true);
	});
});

describe('create — write only if there is nothing worth keeping', () => {
	it('writes the starter when the map has no Alignment at all', async () => {
		const store = await holding();
		expect((await write(store, starter(), CREATE)).outcome).toBe('written');
		expect([...store.snapshot().keys()]).toEqual([path]);
		expect((await read(store)).resourceMask).toHaveLength(4);
	});

	it('keeps Control Points somebody placed rather than writing a community offer over them', async () => {
		const store = await holding(serialiseAlignment(workedOn()));

		const report = await write(
			store,
			{ ...starter(), controlPoints: [point(7), point(8)] },
			CREATE
		);

		expect(report.outcome).toBe('kept over the offer');
		expect((await read(store)).controlPoints.map((p) => p.resource.x)).toEqual([100, 200, 300]);
		expect(store.snapshot().get(path)).toEqual(serialiseAlignment(workedOn()));
	});

	it('writes the offer over a starter nobody has touched, because there is nothing to lose', async () => {
		const store = await holding(serialiseAlignment(starter()));
		expect((await write(store, workedOn(), CREATE)).outcome).toBe('written');
		expect((await read(store)).controlPoints).toHaveLength(3);
	});

	it('treats a cropped sheet with no Control Points as work, not as an untouched starter', async () => {
		const cropped: Alignment = {
			...starter(),
			resourceMask: [
				{ x: 10, y: 10 },
				{ x: 3990, y: 10 },
				{ x: 3990, y: 2990 },
				{ x: 10, y: 2990 }
			]
		};
		const store = await holding(serialiseAlignment(cropped));
		expect((await write(store, workedOn(), CREATE)).outcome).toBe('kept over the offer');
		expect((await read(store)).resourceMask[0]).toEqual({ x: 10, y: 10 });
		expect(store.snapshot().get(path)).toEqual(serialiseAlignment(cropped));
	});

	it.each([
		['re-adding a map that is already aligned', workedOn()],
		['the starter it would write is already there', starter()]
	])('rewrites nothing, and says nothing happened, when %s', async (_, there) => {
		const store = await holding(serialiseAlignment(there));
		const io = port(store);
		expect((await write(io, starter(), CREATE)).outcome).toBe('left alone');
		expect(io.commits).toEqual([]);
		expect(store.snapshot().get(path)).toEqual(serialiseAlignment(there));
	});

	it('keeps the file when the store cannot say whether there is one', async () => {
		const store = await holding();

		const report = await write(
			unreadable(store, 'the folder is no longer reachable'),
			workedOn(),
			CREATE
		);

		expect(report.outcome).toBe('kept over the offer');
		expect(store.snapshot().size).toBe(0);
	});
});

describe('update and replace — the user is editing the Alignment in front of them', () => {
	it('update writes over what is there, because that is what the user has open', async () => {
		const store = await holding(serialiseAlignment(starter()));
		expect((await write(store, workedOn(), { intent: 'update' })).outcome).toBe('written');
		expect((await read(store)).controlPoints).toHaveLength(3);
	});

	it('replace writes over an Alignment somebody worked on, having named what is lost', async () => {
		const store = await holding(serialiseAlignment(workedOn()));

		const report = await write(store, starter(), {
			intent: 'replace',
			discarding: '3 Control Points, used by Amsterdam 1625'
		});

		expect(report.outcome).toBe('written');
		expect((await read(store)).controlPoints).toEqual([]);
	});
});

describe('the address the file names its image by (ADR-0007)', () => {
	it('goes through the one writer rather than being edited into its output', async () => {
		const store = await holding();

		await write(store, starter(), CREATE, LIBRARY);

		expect(JSON.parse(decode(await store.read(path))).target.source.id).toBe(LIBRARY.imageService);
	});

	it('measures "untouched" against a starter at the same address, not a placeholder one', async () => {
		const store = await holding(serialiseAlignment(starter(), LIBRARY));
		expect((await write(store, workedOn(), CREATE, LIBRARY)).outcome).toBe('written');
		expect((await read(store)).controlPoints).toHaveLength(3);
	});
});

describe('an Alignment that changed somewhere else while it was open', () => {
	it.each([
		[
			'a file that changed',
			serialiseAlignment({ ...starter(), controlPoints: [point(1), point(2)] }),
			serialiseAlignment(starter())
		],
		['a file that was absent and is now present', serialiseAlignment(starter()), null]
	])(
		'reports the displacement of %s, and hands back what it wrote over',
		async (_, theirs, basedOn) => {
			const store = await holding(theirs);
			const report = await write(store, workedOn(), { intent: 'update', basedOn });
			expect(report.outcome).toBe('written over a change');
			expect(report.displaced).toEqual(theirs);
			expect((await read(store)).controlPoints).toHaveLength(3);
		}
	);

	it('compares bytes rather than the model, so an unmodelled field is a real change', async () => {
		const basedOn = serialiseAlignment(starter());
		const document = JSON.parse(decode(basedOn));
		document['ballastella:theirAnnotation'] = 'a field this build does not model';
		const theirs = serialiseJson(document);
		const store = await holding(theirs);

		expect(parseAlignment(theirs, { imageId: IMAGE_ID }).controlPoints).toEqual(
			parseAlignment(basedOn, { imageId: IMAGE_ID }).controlPoints
		);

		const report = await write(store, workedOn(), { intent: 'update', basedOn });
		expect(report.outcome).toBe('written over a change');
		expect(report.displaced).toEqual(theirs);
	});

	it.each([
		[
			'the file is exactly as this session left it',
			serialiseAlignment(starter()),
			workedOn(),
			{ intent: 'update', basedOn: serialiseAlignment(starter()) }
		],
		[
			'the file was absent and still is',
			undefined,
			workedOn(),
			{ intent: 'update', basedOn: null }
		],
		[
			'the caller made no claim about what is on disk',
			serialiseAlignment(workedOn()),
			starter(),
			{ intent: 'update' }
		],
		[
			'replace: the user has already been told what they are discarding',
			serialiseAlignment(workedOn()),
			starter(),
			{ intent: 'replace', discarding: 'three Control Points' }
		]
	] as const)('says nothing when %s', async (_, seeded, alignment, intent) => {
		const store = await holding(seeded);
		const report = await write(store, alignment, intent);
		expect(report.outcome).toBe('written');
		expect(report.displaced).toBeNull();
		expect((await read(store)).controlPoints).toHaveLength(alignment.controlPoints.length);
	});

	it('returns the bytes it wrote, so a caller needs no second serialiser', async () => {
		const store = await holding();
		const report = await write(store, workedOn(), { intent: 'update', basedOn: null });
		expect(report.written).toEqual(await store.read(path));
		const next = await write(store, workedOn(), { intent: 'update', basedOn: report.written });
		expect(next.outcome).toBe('written');
	});

	it('does not raise a false alarm when the file cannot be read', async () => {
		const store = await holding();

		const report = await write(
			unreadable(store, 'the folder’s permission was revoked'),
			workedOn(),
			{ intent: 'update', basedOn: new Uint8Array([1, 2, 3]) as Bytes }
		);

		expect(report.outcome).toBe('written');
		expect(report.displaced).toBeNull();
		expect((await read(store)).controlPoints).toHaveLength(3);
	});
});

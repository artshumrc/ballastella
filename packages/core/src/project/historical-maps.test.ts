import { describe, expect, it, vi } from 'vitest';

import { alignmentPath } from '../alignment/alignment.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import {
	referencedImage,
	referencedImagePath,
	serialiseReferencedImage
} from '../remote-iiif/referenced-image.js';
import { buildImageManifest } from '../tiler/image-manifest.js';
import { buildImageInfo, serialiseJson } from '../tiler/pyramid.js';
import { imageDirectory, imageInfoPath, imageManifestPath } from './image-files.js';
import {
	HistoricalMapInUseError,
	HistoricalMapPartlyDeletedError,
	deleteHistoricalMap,
	historicalMapUsage,
	listWorkspaceHistoricalMaps,
	partitionByLocalCopy,
	referencedHistoricalMaps,
	tileLocation,
	unusedHistoricalMapBytes,
	unusedHistoricalMaps
} from './historical-maps.js';
import { newMapLayer, newAnnotationLayer } from './layer.js';
import { newProjectFile, projectFilePath, serialiseProjectFile } from './project-file.js';

// SPEC's Seam 1. "Which Historical Maps does this Workspace hold, who uses them, and what happens
// when one is deleted" is a question about which files exist, so the in-memory store is not standing
// in for anything: the folder is the product.

const bytes = (length: number): Bytes => new Uint8Array(length);

/**
 * Put an Alignment on disk as the *arrange* step of a deletion test.
 *
 * Ticket 18 made `alignmentPath` return an `AlignmentPath`, which `store.write` does not take — the
 * one writer is `alignment/alignment-file.ts` and it will not write arbitrary bytes. These tests are
 * about `deleteHistoricalMap` taking the Alignment with the pyramid, so what they need is a file of
 * a known size at the known path, not an Alignment anybody could read.
 *
 * One helper rather than the seven identical lines it replaces, so there is exactly one place in
 * this file that writes an Alignment and exactly one line for the fence to list.
 */
const seedAlignment = (store: MemoryProjectStore, imageId: string, length: number): Promise<void> =>
	// alignment-write-is-the-fixture: the arrange step of the deletion tests, which need a file of a known size at that path rather than a readable Alignment
	store.write(`alignments/${imageId}.json`, bytes(length));

const info = (imageId: string) => buildImageInfo({ imageId, width: 4000, height: 3000 });

/**
 * A complete local pyramid: an `info.json` of ours, a manifest carrying the label, and a tile.
 *
 * The tile is what makes the no-`read` assertion mean something — a pyramid with nothing in it is a
 * pyramid nothing could have opened.
 */
async function seedLocalMap(
	store: MemoryProjectStore,
	imageId: string,
	label: string,
	tileBytes = 4096
): Promise<void> {
	await store.write(imageInfoPath(imageId), bytes(300));
	await store.write(
		imageManifestPath(imageId),
		serialiseJson(buildImageManifest({ imageId, label, info: info(imageId) }))
	);
	await store.write(tilePath(imageId), bytes(tileBytes));
}

/** One tile of a pyramid, at the shape `planPyramid` writes. */
const tilePath = (imageId: string): string =>
	`${imageDirectory(imageId)}/0,0,256,256/256,256/0/default.jpg`;

/** A Historical Map whose tiles are on a Library's server: a `remote.json` and nothing else. */
async function seedReferencedMap(
	store: MemoryProjectStore,
	imageId: string,
	label: string,
	service = 'https://iiif.library.example/iiif/3/plan-1625'
): Promise<void> {
	await store.write(
		referencedImagePath(imageId),
		serialiseReferencedImage(
			referencedImage({ imageId, service, label, width: 4000, height: 3000 })
		)
	);
}

/** A Project whose map Layers name `imageIds`. */
async function seedProject(
	store: MemoryProjectStore,
	directory: string,
	name: string,
	imageIds: readonly string[]
): Promise<void> {
	const file = newProjectFile(name, new Date('2026-01-02T03:04:05.000Z'));
	await store.write(
		projectFilePath(directory),
		serialiseProjectFile({
			...file,
			layers: imageIds.map((imageId, index) => ({
				...newMapLayer({ id: `layer-${index}`, name: `${imageId} layer`, imageId }),
				order: index
			}))
		})
	);
}

describe('where a Historical Map’s tiles are', () => {
	// ADR-0023's rule, and this is now its only implementation. It used to have five: `publish.ts`,
	// `partitionByLocalCopy`, the viewer's 404 probe, and a derived set in each app's page. The rule
	// itself is what they disagreed about most cheaply, so it is the thing that got one home.
	it('is this Workspace when an info.json of ours is beside it', () => {
		expect(tileLocation({ infoJson: true, remoteJson: false })).toBe('in-workspace');
	});

	it('is a Library’s server when only a remote.json is', () => {
		expect(tileLocation({ infoJson: false, remoteJson: true })).toBe('referenced');
	});

	it('is this Workspace once a copy has been made, though the citation stays', () => {
		// A mirrored map keeps its `remote.json` — that record is the citation ADR-0007 protects — so
		// "both" is the offline copy, not an ambiguity. Reading it the other way is what made publishing
		// warn about a network dependency the Workspace no longer had.
		expect(tileLocation({ infoJson: true, remoteJson: true })).toBe('in-workspace');
	});

	it('is nothing at all for a directory holding neither', () => {
		// The tiles of an interrupted ingest. `info.json` is written last precisely so this is not yet a
		// Historical Map, and nothing may list it, delete it, or count it.
		expect(tileLocation({ infoJson: false, remoteJson: false })).toBeNull();
	});
});

describe('listWorkspaceHistoricalMaps', () => {
	it('lists every Historical Map in the Workspace with its label and its size', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Amsterdam 1625.tif', 40_000);
		await seedReferencedMap(store, 'bbb2', 'Plan de Paris');

		const maps = await listWorkspaceHistoricalMaps(store);

		expect(maps.map((map) => map.imageId)).toEqual(['aaa1', 'bbb2']);
		expect(maps[0]?.label).toBe('Amsterdam 1625.tif');
		expect(maps[1]?.label).toBe('Plan de Paris');
		// info.json + manifest + tile, and nothing from any other map.
		expect(maps[0]?.bytes).toBeGreaterThan(40_000);
		expect(maps[0]?.bytes).toBeLessThan(42_000);
	});

	it('says whether the tiles are in this Workspace or names the Library they are on', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Amsterdam 1625.tif');
		await seedReferencedMap(
			store,
			'bbb2',
			'Plan de Paris',
			'https://iiif.bnf.example/iiif/3/btv1b'
		);

		const maps = await listWorkspaceHistoricalMaps(store);

		// `library`, never `host`: CONTEXT.md reserves Library for the institution whose server a
		// referenced map's tiles stay on, and lists "host" among the words that must not stand for it.
		expect(maps[0]).toMatchObject({ tiles: 'in-workspace', library: '' });
		expect(maps[1]).toMatchObject({ tiles: 'referenced', library: 'iiif.bnf.example' });
	});

	it('names the Projects that use each map, and reports none when none do', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Shared map');
		await seedLocalMap(store, 'ccc3', 'Nobody’s map');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		await seedProject(store, 'boston-1775', 'Boston 1775', ['aaa1']);

		const maps = await listWorkspaceHistoricalMaps(store);
		const shared = maps.find((map) => map.imageId === 'aaa1');
		const unused = maps.find((map) => map.imageId === 'ccc3');

		expect(shared?.usedBy.map((project) => project.name)).toEqual([
			'Amsterdam 1625',
			'Boston 1775'
		]);
		expect(unused?.usedBy).toEqual([]);
	});

	it('counts a Project once however many of its Layers draw the same map', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Shared map');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1', 'aaa1']);

		const [map] = await listWorkspaceHistoricalMaps(store);

		expect(map?.usedBy).toEqual([{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }]);
	});

	it('opens no pyramid: the sizes come from ProjectStore#size', async () => {
		// ADR-0001 put `size` in the interface for exactly this, and `workspace-size.ts` keeps the
		// discipline. A version of this written with `read` returns the same numbers and is unusable on a
		// Workspace holding a mirrored pyramid — tens of thousands of tiles — so the absence of the read
		// is the claim, and no assertion about the numbers could carry it.
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Amsterdam 1625.tif');
		await seedReferencedMap(store, 'bbb2', 'Plan de Paris');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		const read = vi.spyOn(store, 'read');

		const maps = await listWorkspaceHistoricalMaps(store);

		// Not "nothing is read": the Projects' documents are how used-by is answered, and one small
		// record per map is how it is named. What must never be opened is the pyramid — a tile or the
		// `info.json` that describes it.
		expect(read.mock.calls.map(([path]) => path).sort()).toEqual([
			'amsterdam-1625/project.json',
			imageManifestPath('aaa1'),
			referencedImagePath('bbb2')
		]);
		// And it did weigh them, so this is not passing because nothing happened.
		expect(maps.every((map) => map.bytes > 0)).toBe(true);
	});

	it('ignores an image directory that is neither: a half-written ingest is not a Historical Map', async () => {
		const store = new MemoryProjectStore();
		await store.write('images/half/0,0,256,256/256,256/0/default.jpg', bytes(4096));

		expect(await listWorkspaceHistoricalMaps(store)).toEqual([]);
	});
});

describe('historicalMapUsage', () => {
	it('skips a Project whose document will not parse rather than failing the list', async () => {
		const store = new MemoryProjectStore();
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		await store.write('broken/project.json', new TextEncoder().encode('{ not json'));

		const usage = await historicalMapUsage(store);

		expect([...usage.byMap]).toEqual([
			['aaa1', [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }]]
		]);
		// A corrupt file is not a Project from the future: nothing can be said about its Layers because
		// there is nothing there to read, so it stays skipped in silence.
		expect(usage.fromANewerVersion).toEqual([]);
	});

	it('ignores Layers that are not maps', async () => {
		const store = new MemoryProjectStore();
		const file = newProjectFile('Amsterdam 1625', new Date('2026-01-02T03:04:05.000Z'));
		await store.write(
			projectFilePath('amsterdam-1625'),
			serialiseProjectFile({
				...file,
				layers: [newAnnotationLayer({ id: 'notes', name: 'Notes' })]
			})
		);

		expect((await historicalMapUsage(store)).byMap.size).toBe(0);
	});

	it('reports a Project from a newer version rather than skipping it', async () => {
		const store = new MemoryProjectStore();
		await seedFutureProject(store, 'from-the-future');

		const usage = await historicalMapUsage(store);

		expect(usage.byMap.size).toBe(0);
		// Named by its directory, exactly as `listProjects` names the same Project on the hub.
		expect(usage.fromANewerVersion).toEqual([
			{ directory: 'from-the-future', name: 'from-the-future' }
		]);
	});
});

/**
 * A Project this build cannot read but which is emphatically not damaged (ADR-0010).
 *
 * `formatVersion: 2` is refused by `parseProjectFile` *because the file is intact* — SPEC story 114
 * wants refusal rather than partial loading. Its Layer stack is right there and certainly names
 * Historical Maps; this build simply cannot say which.
 */
async function seedFutureProject(store: MemoryProjectStore, directory: string): Promise<void> {
	await store.write(
		projectFilePath(directory),
		new TextEncoder().encode(
			JSON.stringify({
				formatVersion: 2,
				name: 'Tomorrow',
				updatedAt: '2027-01-02T03:04:05.000Z',
				layers: [{ kind: 'something-new' }]
			})
		)
	);
}

// The whole of this describe is one defect: a Historical Map drawn only by a Project from a newer
// build was reported as "No Project uses this map" and offered for deletion, on the same hub that had
// just said that Project could not be opened. Swallowing every parse failure alike is what did it.
describe('a Historical Map whose only user is a Project from a newer version', () => {
	it('is not reported as unused, and names the Project that cannot be read', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Might be in use', 100_000);
		await seedFutureProject(store, 'from-the-future');

		const [map] = await listWorkspaceHistoricalMaps(store);

		expect(map?.usedBy).toEqual([]);
		expect(map?.mightBeUsedBy).toEqual([{ directory: 'from-the-future', name: 'from-the-future' }]);
	});

	it('is refused deletion, and the pyramid survives', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Might be in use', 100_000);
		await seedAlignment(store, 'aaa1', 120);
		await seedFutureProject(store, 'from-the-future');
		const before = [...store.snapshot().keys()];

		const refusal = await deleteHistoricalMap(store, 'aaa1', { label: 'Might be in use' }).catch(
			(cause: unknown) => cause
		);

		expect(refusal).toBeInstanceOf(HistoricalMapInUseError);
		expect((refusal as HistoricalMapInUseError).message).toContain('from-the-future');
		expect((refusal as HistoricalMapInUseError).message).toContain('newer version of Ballastella');
		// The claim that must not pass vacuously: the tiles and the Alignment are still on disk. A
		// refusal that deleted anyway would satisfy the two assertions above it.
		expect([...store.snapshot().keys()]).toEqual(before);
	});

	it('is not counted in the weight of maps no Project uses', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Might be in use', 500_000);
		await seedFutureProject(store, 'from-the-future');

		// Publishing's warning would otherwise invite the user to reclaim half a gigabyte that a Project
		// they cannot open today is drawing.
		expect(await unusedHistoricalMapBytes(store)).toEqual({ bytes: 0, maps: 0 });
	});

	it('still lets a map a readable Project has stopped using be deleted, when nothing is unreadable', async () => {
		// The other side of the rule: this is not "any parse failure freezes the Workspace". A corrupt
		// document is still skipped, so a map only it might have used is still deletable.
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Going', 100_000);
		await store.write('broken/project.json', new TextEncoder().encode('{ not json'));

		await deleteHistoricalMap(store, 'aaa1');

		expect(await listWorkspaceHistoricalMaps(store)).toEqual([]);
	});
});

describe('referencedHistoricalMaps', () => {
	it('is the maps whose tiles are on somebody else’s server, and only those', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Mine');
		await seedReferencedMap(store, 'bbb2', 'Theirs');
		// Mirrored: a copy was made and the citation stayed.
		await seedLocalMap(store, 'ccc3', 'Copied');
		await seedReferencedMap(store, 'ccc3', 'Copied');

		expect([...(await referencedHistoricalMaps(store))]).toEqual(['bbb2']);
	});
});

describe('deleting a Historical Map', () => {
	it('is refused when two Projects use it, and the refusal names both', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Shared map');
		await seedAlignment(store, 'aaa1', 120);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);
		await seedProject(store, 'boston-1775', 'Boston 1775', ['aaa1']);
		const before = [...store.snapshot().keys()];

		const refusal = await deleteHistoricalMap(store, 'aaa1').catch((cause: unknown) => cause);

		expect(refusal).toBeInstanceOf(HistoricalMapInUseError);
		expect((refusal as HistoricalMapInUseError).message).toContain('Amsterdam 1625');
		expect((refusal as HistoricalMapInUseError).message).toContain('Boston 1775');
		expect((refusal as HistoricalMapInUseError).projects.map((p) => p.directory)).toEqual([
			'amsterdam-1625',
			'boston-1775'
		]);
		// The claim that must not pass vacuously: the pyramid is still on disk, not merely that a
		// sentence appeared. A refusal that had already deleted half the tiles would satisfy every
		// assertion above it.
		expect([...store.snapshot().keys()]).toEqual(before);
	});

	it('removes the pyramid, the remote.json, and the Alignment, and nothing else', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Going');
		await seedReferencedMap(store, 'aaa1', 'Going');
		await seedAlignment(store, 'aaa1', 120);
		await seedLocalMap(store, 'bbb2', 'Staying');
		await seedAlignment(store, 'bbb2', 120);
		await seedProject(store, 'boston-1775', 'Boston 1775', ['bbb2']);

		await deleteHistoricalMap(store, 'aaa1');

		expect([...store.snapshot().keys()].sort()).toEqual(
			[
				'boston-1775/project.json',
				alignmentPath('bbb2'),
				imageInfoPath('bbb2'),
				imageManifestPath('bbb2'),
				tilePath('bbb2')
			].sort()
		);
	});

	it('is allowed once the last Project that used it has stopped', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Was used');
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', []);

		await deleteHistoricalMap(store, 'aaa1');

		expect(await listWorkspaceHistoricalMaps(store)).toEqual([]);
	});

	// A `delete` can refuse anywhere in the sequence — a lock, a folder grant revoked mid-way, a disk
	// that filled while a temporary file was open. What that must not produce is a Workspace holding
	// tiles no listing mentions and no total explains, under a message saying nothing happened.
	describe('when the Workspace refuses partway through', () => {
		/** Fail on the nth `delete`, counting from one, and succeed on the others. */
		const refuseOn = (store: MemoryProjectStore, nth: number) => {
			let seen = 0;
			return vi.spyOn(store, 'delete').mockImplementation(async function (this: void, path) {
				seen += 1;
				if (seen === nth) throw new Error('The Workspace is locked');
				return MemoryProjectStore.prototype.delete.call(store, path);
			});
		};

		it('leaves the map listed, so the next render explains the leftover rather than hiding it', async () => {
			const store = new MemoryProjectStore();
			await seedLocalMap(store, 'aaa1', 'Half gone', 40_000);
			await seedAlignment(store, 'aaa1', 120);
			// The third delete: the Alignment and one file have gone, and `info.json` has not — which is
			// the ordering claim. Written last by the ingest, deleted last here.
			refuseOn(store, 3);

			const failure = await deleteHistoricalMap(store, 'aaa1', { label: 'Half gone' }).catch(
				(cause: unknown) => cause
			);

			expect(failure).toBeInstanceOf(HistoricalMapPartlyDeletedError);
			expect((failure as Error).message).toContain('only partly deleted');
			expect((failure as Error).message).toContain('The Workspace is locked');
			// The claim that must not pass vacuously: the map is still *listed*, holding the bytes it
			// still holds. Deleting `info.json` first would have left the same tiles on disk with nothing
			// in the Workspace admitting they exist.
			const listed = await listWorkspaceHistoricalMaps(store);
			expect(listed.map((map) => map.imageId)).toEqual(['aaa1']);
			expect(listed[0]?.bytes).toBeGreaterThan(0);
		});

		it('takes the Alignment first, so no orphan placement can outlive the map', async () => {
			const store = new MemoryProjectStore();
			await seedLocalMap(store, 'aaa1', 'Half gone', 40_000);
			await seedAlignment(store, 'aaa1', 120);
			refuseOn(store, 3);

			await deleteHistoricalMap(store, 'aaa1').catch(() => undefined);

			// `alignments/<id>.json` is what a later import deduplicates against, so a leftover would make
			// a colleague's copy of this map arrive without its own placement.
			expect([...store.snapshot().keys()]).not.toContain(alignmentPath('aaa1'));
		});

		it('reports the failure as itself when nothing was removed', async () => {
			const store = new MemoryProjectStore();
			await seedLocalMap(store, 'aaa1', 'Untouched', 40_000);
			await seedAlignment(store, 'aaa1', 120);
			const before = [...store.snapshot().keys()];
			refuseOn(store, 1);

			const failure = await deleteHistoricalMap(store, 'aaa1', { label: 'Untouched' }).catch(
				(cause: unknown) => cause
			);

			// No half state to describe, so "partly deleted" would be its own false story.
			expect(failure).not.toBeInstanceOf(HistoricalMapPartlyDeletedError);
			expect((failure as Error).message).toBe('The Workspace is locked');
			expect([...store.snapshot().keys()]).toEqual(before);
		});
	});
});

describe('unusedHistoricalMaps', () => {
	// One definition of the ticket's headline figure. The hub used to reduce this itself, so the
	// reclaim list and publishing's hosting warning were two answers to one question.
	const map = (imageId: string, bytes: number, users: number, unreadable = 0) => ({
		imageId,
		bytes,
		usedBy: Array.from({ length: users }, (_, i) => ({ directory: `p${i}`, name: `P${i}` })),
		mightBeUsedBy: Array.from({ length: unreadable }, () => ({
			directory: 'from-the-future',
			name: 'from-the-future'
		}))
	});

	it('is the maps nothing draws, and what they weigh together', () => {
		const unused = unusedHistoricalMaps([map('aaa1', 100, 1), map('bbb2', 500, 0)]);

		expect(unused.maps.map((entry) => entry.imageId)).toEqual(['bbb2']);
		expect(unused.bytes).toBe(500);
	});

	it('counts a map a Project this build cannot read might draw as used', () => {
		expect(unusedHistoricalMaps([map('aaa1', 500, 0, 1)])).toEqual({ maps: [], bytes: 0 });
	});
});

describe('unusedHistoricalMapBytes', () => {
	it('weighs the maps no Project uses, and only those', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Used', 100_000);
		await seedLocalMap(store, 'bbb2', 'Unused', 500_000);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);

		const unused = await unusedHistoricalMapBytes(store);

		expect(unused.maps).toBe(1);
		expect(unused.bytes).toBeGreaterThan(500_000);
		expect(unused.bytes).toBeLessThan(502_000);
	});

	it('is zero when every map is in use', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Used', 100_000);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', ['aaa1']);

		expect(await unusedHistoricalMapBytes(store)).toEqual({ bytes: 0, maps: 0 });
	});

	it('opens nothing but the Projects’ own documents', async () => {
		const store = new MemoryProjectStore();
		await seedLocalMap(store, 'aaa1', 'Unused', 100_000);
		await seedProject(store, 'amsterdam-1625', 'Amsterdam 1625', []);
		const read = vi.spyOn(store, 'read');

		await unusedHistoricalMapBytes(store);

		expect(read.mock.calls.map(([path]) => path)).toEqual(['amsterdam-1625/project.json']);
	});
});

describe('partitionByLocalCopy', () => {
	// Moved here from `referenced-image.ts` so that it and `referencedHistoricalMaps` answer through
	// one rule rather than two. Its behaviour is unchanged, and `referenced-image.test.ts` still
	// asserts it end to end from the records on disk.
	const record = (imageId: string) =>
		referencedImage({
			imageId,
			service: 'https://iiif.library.example/iiif/3/plan',
			width: 100,
			height: 100
		});

	it('calls an image with a pyramid of ours mirrored, and one without referenced', () => {
		const split = partitionByLocalCopy([record('aaa1'), record('bbb2')], [{ imageId: 'aaa1' }]);

		expect(split.mirrored.map((image) => image.imageId)).toEqual(['aaa1']);
		expect(split.referenced.map((image) => image.imageId)).toEqual(['bbb2']);
	});
});

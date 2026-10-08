import {
	DeletedProjects,
	SynchronizationMetadata,
	ManagedProjectStore,
	WriteAheadJournal,
	alignmentPath,
	annotationPath,
	acceptRemoteImageService,
	emptyAnnotationCollection,
	fingerprintOf,
	gitBlobSha,
	fullImageResourceMask,
	newAnnotationLayer,
	newAnnotation,
	newMapLayer,
	imageInfoPath,
	newAlignment,
	newProjectFile,
	projectFilePath,
	serialiseAlignment,
	readHeldCopies,
	readJournal,
	serialiseProjectFile,
	type Alignment,
	type Bytes,
	type ProjectFile,
	type RemoteRepository,
	type StorePath
} from '@ballastella/core';
import {
	FakeJournalStorage,
	FakeMetadataStorage,
	MemoryProjectStore,
	createFakeGitHub,
	type FakeGitHub
} from '@ballastella/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	EditorSession,
	trackLocalChanges,
	type EditorSessionOptions
} from './editor-session.svelte.js';
import { Remote } from './remote.svelte.js';
import { folderWorkspaceKey, opfsWorkspaceKey, workspaceIdentityOf } from './workspace-key.js';

const DIRECTORY = 'amsterdam-1625';
const JOURNALLED = 'opfs:My Workspace';
const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const decoded = (bytes: Bytes | undefined): string => new TextDecoder().decode(bytes);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const projectText = async (store: MemoryProjectStore) =>
	decoded(await store.read(projectFilePath(DIRECTORY)));
const present = <T>(value: T | null | undefined): T => {
	if (value === null || value === undefined) throw new Error('expected a value');
	return value;
};
const journalPaths = (storage: FakeJournalStorage) =>
	readJournal(storage, JOURNALLED).entries.map((entry) => entry.path);
const undoLabel = (session: EditorSession, subject = DIRECTORY) =>
	session.historyFor(subject).undoable?.label;
const layerIdsOf = (session: EditorSession): string[] =>
	(session.openProject?.layers ?? []).map((layer) => layer.id);

const refuseWrites = (store: MemoryProjectStore): (() => void) => {
	const write = store.write.bind(store);
	store.write = () => Promise.reject(new Error('the drive is not there'));
	return () => {
		store.write = write;
	};
};

const seedProject = (store: MemoryProjectStore, extra: Partial<ProjectFile> = {}) =>
	store.write(
		projectFilePath(DIRECTORY),
		serialiseProjectFile({
			...newProjectFile('Amsterdam 1625', new Date('2026-08-08T00:00:00Z')),
			...extra
		})
	);

const seedImageInfo = async (store: MemoryProjectStore, maps: string[], size: object) => {
	for (const map of maps) await store.write(imageInfoPath(map), encode(JSON.stringify(size)));
};

async function shareEverything(
	store: MemoryProjectStore,
	metadataStorage: FakeMetadataStorage,
	workspaceKey: string,
	remote: RemoteRepository
): Promise<Map<string, Bytes>> {
	const held = new Map<string, Bytes>();
	for (const path of await store.list('')) held.set(path, await store.read(path));
	const shared = new Map<string, string>();
	for (const [path, bytes] of held) shared.set(path, await gitBlobSha(bytes));
	await new SynchronizationMetadata(metadataStorage, workspaceKey).writeBaseline({
		remote,
		commit: 'shared',
		files: shared
	});
	return held;
}

class ImagesGoAway extends MemoryProjectStore {
	failing = false;
	afterWrite: ((path: StorePath) => void) | undefined;
	afterRead: ((path: StorePath) => void) | undefined;
	refuseWrite: ((path: StorePath) => boolean) | undefined;

	override async list(prefix: string): Promise<StorePath[]> {
		if (this.failing && prefix.startsWith('images/')) {
			throw new Error('the images folder could not be read');
		}
		return super.list(prefix);
	}

	override async write(path: StorePath, bytes: Bytes): Promise<void> {
		if (this.refuseWrite?.(path)) throw new Error(`the Workspace refused to write ${path}`);
		await super.write(path, bytes);
		this.afterWrite?.(path);
	}

	override async read(path: StorePath): Promise<Bytes> {
		const bytes = await super.read(path);
		this.afterRead?.(path);
		return bytes;
	}
}

async function openOn(
	store: MemoryProjectStore,
	options: EditorSessionOptions = {}
): Promise<EditorSession> {
	await seedProject(store);
	const opened = new EditorSession(store, options);
	await opened.open(DIRECTORY);
	return opened;
}

async function stepped(
	session: EditorSession,
	way: 'undo' | 'redo',
	subject = DIRECTORY
): Promise<void> {
	expect(await session.historyFor(subject)[way]()).toBe(true);
	await session.flush();
}

let store: ImagesGoAway;
let opened: EditorSession;
const openFresh = async () => {
	store = new ImagesGoAway();
	opened = await openOn(store);
};

describe('the picker behind “Add a Map Image”', () => {
	beforeEach(openFresh);

	it('refuses a map whose record does not say how big it is, in words', async () => {
		expect(await opened.addWorkspaceMap('no-such-map')).toBeNull();
		expect(opened.addMapError).toContain('images/no-such-map/');
		expect(opened.addMapError).toContain('nothing to place an Alignment over');
		expect(opened.openProject?.layers).toEqual([]);
	});

	it('says a Workspace it cannot look through, without taking the Project off the screen', async () => {
		expect(opened.status).toBe('ready');
		store.failing = true;

		await opened.refreshAddableMapImages();

		expect(opened.status).toBe('ready');
		expect(opened.openProject).not.toBeNull();
		expect(opened.addMapError).toContain('could not be looked through');
		expect(opened.mapImagesLoading).toBe(false);
	});

	it('still takes the hub’s own walk to the unreachable state', async () => {
		store.failing = true;

		await opened.refreshMapImages();

		expect(opened.status).toBe('unreachable');
		expect(opened.unreachableDetail).toContain('could not be read');
	});
});

describe('deleting a Project, at the unit seam', () => {
	const STRANDED = 'A name that did not reach the disk';

	async function sessionWithJournal() {
		const store = new MemoryProjectStore();
		await seedProject(store);
		const storage = new FakeJournalStorage();
		const session = new EditorSession(store, {
			journalStorage: storage,
			workspaceKey: JOURNALLED
		});
		await session.refresh();
		return { session, storage, store };
	}

	async function strandAnEdit(session: EditorSession, store: MemoryProjectStore) {
		await session.open(DIRECTORY);
		const restore = refuseWrites(store);
		await session.updateProjectDetails(DIRECTORY, { name: STRANDED }).catch(() => undefined);
		restore();
	}

	const heldFor = (storage: FakeJournalStorage, path: string) =>
		readJournal(storage, JOURNALLED).entries.find((entry) => entry.path === path)?.held;

	it('retires every journalled edit belonging to the Project it deletes', async () => {
		const { session, storage } = await sessionWithJournal();
		const journal = new WriteAheadJournal(storage, JOURNALLED);
		journal.record(`${DIRECTORY}/annotations/one.geojson` as StorePath, new Uint8Array([1]));
		journal.record(`${DIRECTORY}/project.json` as StorePath, new Uint8Array([2]));
		journal.record('boston-1775/project.json' as StorePath, new Uint8Array([3]));

		await session.deleteProject(DIRECTORY);

		expect(journalPaths(storage)).toEqual(['boston-1775/project.json']);
	});

	it('gives up the pending bytes too, so a pagehide capture cannot re-journal them', async () => {
		const { session, storage, store } = await sessionWithJournal();

		store.write = () => new Promise<never>(() => undefined);
		void session.updateProjectDetails(DIRECTORY, { name: 'Renamed and never landed' });

		await tick();
		expect(journalPaths(storage)).toEqual([`${DIRECTORY}/project.json`]);

		void session.deleteProject(DIRECTORY);
		session.capture();

		expect(readJournal(storage, JOURNALLED).entries).toEqual([]);
	});

	it('waits out a write it could not call back, so the manifest is not written back behind it', async () => {
		const { session, store } = await sessionWithJournal();

		let land = (): void => undefined;
		const write = store.write.bind(store);
		store.write = (path, bytes) =>
			new Promise<void>((resolve, reject) => {
				land = () => void write(path, bytes).then(resolve, reject);
			});
		void session.updateProjectDetails(DIRECTORY, { name: 'Renamed and still in flight' });
		await tick();

		const deletion = session.deleteProject(DIRECTORY);
		await tick();
		land();
		await deletion;

		expect(await store.list('')).toEqual([]);
	});

	it('forgets the note behind a refusal, and takes the panel with the last one', async () => {
		const { session, storage } = await sessionWithJournal();
		new DeletedProjects(storage, JOURNALLED).record(DIRECTORY, {
			name: 'Amsterdam 1625',
			updatedAt: 'a time this Project no longer says'
		});
		await session.finishInterruptedDeletions();
		expect(session.deletionReport?.refused.map((entry) => entry.directory)).toEqual([DIRECTORY]);

		session.forgetDeletion(DIRECTORY);

		expect(new DeletedProjects(storage, JOURNALLED).has(DIRECTORY)).toBe(false);
		expect(session.deletionReport).toBeNull();
		expect(await session.store.list('')).toEqual([projectFilePath(DIRECTORY)]);
	});

	it('throws away one refused entry’s kept copy, and takes the panel with the last one', async () => {
		const { session, storage, store } = await sessionWithJournal();
		const path = `${DIRECTORY}/annotations/one.geojson` as StorePath;
		const journal = new WriteAheadJournal(storage, JOURNALLED);

		await store.write(path, encode('v1'));
		journal.record(path, encode('v1'));
		journal.forget(path);
		journal.record(path, encode('the edit that stranded'));
		await store.write(path, encode('v2-NEWER'));

		await session.replayJournalledEdits();
		const skip = session.replayReport?.skipped[0];
		expect([skip?.reason, skip?.copy]).toEqual(['superseded', expect.any(String)]);
		const twin = `${DIRECTORY}/annotations/twin.geojson` as StorePath;
		journal.hold(twin, encode('the edit that stranded'), '', 'superseded');
		await session.replayJournalledEdits();
		const rows = session.replayReport?.skipped ?? [];
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((row) => row.copy)).size).toBe(1);

		session.forgetReplaySkip(path, skip?.copy ?? '');

		expect(session.replayReport?.skipped.map((row) => row.path)).toEqual([twin]);
		expect(readHeldCopies(storage, JOURNALLED).copies.map((copy) => copy.path)).toEqual([twin]);
		expect(decoded(await store.read(path))).toBe('v2-NEWER');
	});

	it('puts a stranded edit back at the next startup, because opening the Project said what was on disk', async () => {
		const { session, storage, store } = await sessionWithJournal();
		const path = projectFilePath(DIRECTORY);
		const onDisk = await store.read(path);

		await strandAnEdit(session, store);
		expect(readJournal(storage, JOURNALLED).entries[0]?.held).toBe(fingerprintOf(onDisk));

		await session.replayJournalledEdits();

		expect(session.replayReport?.restored).toEqual([path]);
		expect(session.replayReport?.skipped).toEqual([]);
		expect(decoded(await store.read(path))).toContain(STRANDED);
	});

	it('says what an Annotation collection held, from readAnnotations', async () => {
		const { session, storage, store } = await sessionWithJournal();
		const layer = newAnnotationLayer({ id: 'one', name: 'Warehouses' });
		const path = `${DIRECTORY}/${layer.geojsonRef}` as StorePath;
		const onDisk = encode('{"type":"FeatureCollection","features":[],"note":"last week"}');
		await store.write(path, onDisk);
		await seedProject(store, { layers: [layer] });
		await session.open(DIRECTORY);

		await session.readAnnotations(layer);

		refuseWrites(store);
		await session
			.writeAnnotations(layer, { ...emptyAnnotationCollection(), annotations: [] })
			.catch(() => undefined);

		expect(heldFor(storage, path)).toBe(fingerprintOf(onDisk));
	});

	it.each([
		[
			'readAlignment',
			(sn: EditorSession, image: { width: number; height: number }) =>
				sn.readAlignment('floride-1657', image)
		],
		[
			'readLayerAlignment',
			(sn: EditorSession) =>
				sn.readLayerAlignment(newMapLayer({ id: 'l', name: 'La Floride', imageId: 'floride-1657' }))
		]
	])('says what an Alignment held, from %s', async (_name, read) => {
		const { session, storage, store } = await sessionWithJournal();
		const image = { width: 400, height: 300 };
		const point = (id: string, ordinal: number, x: number, lng: number) => ({
			id,
			ordinal,
			resource: { x, y: x + 10 },
			geo: { lng, lat: lng + 47.4 }
		});
		const onDisk = serialiseAlignment({
			...newAlignment('floride-1657', image),
			controlPoints: [point('p0', 1, 10, 4.9)]
		});
		await store.write(alignmentPath('floride-1657') as StorePath, onDisk);
		await session.open(DIRECTORY);

		const alignment = present(await read(session, image));

		refuseWrites(store);
		await session
			.writeAlignment({
				...alignment,
				controlPoints: [...alignment.controlPoints, point('p1', 2, 30, 5.0)]
			})
			.catch(() => undefined);

		expect(heldFor(storage, alignmentPath('floride-1657'))).toBe(fingerprintOf(onDisk));
	});

	it('still refuses to put that edit back over something written after it', async () => {
		const { session, storage, store } = await sessionWithJournal();
		const path = projectFilePath(DIRECTORY);

		await strandAnEdit(session, store);

		const colleague = serialiseProjectFile(
			newProjectFile('The colleague’s name', new Date('2026-08-09T00:00:00Z'))
		);
		await store.write(path, colleague);

		await session.replayJournalledEdits();

		expect(session.replayReport?.restored).toEqual([]);
		expect(session.replayReport?.skipped.map((entry) => entry.reason)).toEqual(['superseded']);
		expect(await store.read(path)).toEqual(colleague);
		expect(readJournal(storage, JOURNALLED).entries).toEqual([]);
		expect(readHeldCopies(storage, JOURNALLED).copies.map((held) => held.path)).toEqual([path]);
	});

	it('takes a declined Alignment copy with the Map Image it belonged to', async () => {
		const { session, storage, store } = await sessionWithJournal();
		const path = alignmentPath('floride-1657') as StorePath;
		await store.write(
			path,
			serialiseAlignment(newAlignment('floride-1657', { width: 4, height: 3 }))
		);
		await store.write(imageInfoPath('floride-1657'), encode('{}'));
		new WriteAheadJournal(storage, JOURNALLED).hold(
			path,
			encode('the control points that stranded'),
			'',
			'cannot-tell-which-is-newer'
		);
		expect(readHeldCopies(storage, JOURNALLED).copies).toHaveLength(1);

		await session.deleteMapImage('floride-1657');

		expect(readHeldCopies(storage, JOURNALLED).copies).toEqual([]);
	});

	it('records the Project’s identity, not only its folder name', async () => {
		const { session, storage } = await sessionWithJournal();
		const store = new MemoryProjectStore();
		store.list = () => new Promise<never>(() => undefined);
		const stalled = new EditorSession(store, {
			journalStorage: storage,
			workspaceKey: JOURNALLED
		});
		stalled.projects = session.projects;

		void stalled.deleteProject(DIRECTORY);

		expect(new DeletedProjects(storage, JOURNALLED).pending()).toEqual([
			{
				directory: DIRECTORY,
				was: { name: 'Amsterdam 1625', updatedAt: '2026-08-08T00:00:00.000Z' }
			}
		]);
	});
});

describe('deleting a Map Image, at the unit seam', () => {
	const IMAGE = 'amsterdam-plate-1';
	const INFO = imageInfoPath(IMAGE);
	const ALIGNMENT = alignmentPath(IMAGE) as StorePath;

	async function overAMap(files: StorePath[] = []) {
		const store = new MemoryProjectStore();
		await seedProject(store);
		for (const path of files) await store.write(path, encode('{}'));
		const storage = new FakeJournalStorage();
		const session = new EditorSession(store, {
			journalStorage: storage,
			workspaceKey: JOURNALLED
		});
		return { store, session, storage };
	}

	function holdOneWriteOpen(
		store: MemoryProjectStore,
		target: string,
		options: { thenFail?: boolean } = {}
	): () => void {
		const write = store.write.bind(store);
		let land = (): void => undefined;
		let held = false;
		store.write = async (path, bytes) => {
			if (held || (path as string) !== target) return write(path, bytes);
			held = true;
			return new Promise<void>((resolve, reject) => {
				land = () =>
					void write(path, bytes).then(
						() => (options.thenFail ? reject(new Error('the folder grant went away')) : resolve()),
						reject
					);
			});
		};
		return () => land();
	}

	const journalTheAlignment = (storage: FakeJournalStorage) =>
		new WriteAheadJournal(storage, JOURNALLED).record(ALIGNMENT, new Uint8Array([1, 2, 3]));

	it('does not throw the unsaved Alignment away before the deletion has happened', async () => {
		const { store, session, storage } = await overAMap();
		journalTheAlignment(storage);
		store.list = () => new Promise<never>(() => undefined);

		void session.deleteMapImage(IMAGE);

		expect(journalPaths(storage)).toEqual([ALIGNMENT]);
	});

	it('keeps the unsaved Alignment when the deletion is refused because a Project draws the map', async () => {
		const { store, session, storage } = await overAMap();
		await seedImageInfo(store, [IMAGE], { width: 1000, height: 800 });
		await session.open(DIRECTORY);
		expect(await session.addWorkspaceMap(IMAGE)).not.toBeNull();
		await session.flush();
		journalTheAlignment(storage);

		expect(await session.deleteMapImage(IMAGE)).toBe(false);
		expect(session.mapImageError).not.toBe('');
		expect(journalPaths(storage)).toEqual([ALIGNMENT]);
	});

	it('gives up the Alignment’s pending bytes, not only its journal entry', async () => {
		const { store, session, storage } = await overAMap([INFO]);
		await session.open(DIRECTORY);

		const write = store.write.bind(store);
		store.write = (path, bytes) =>
			path === ALIGNMENT ? new Promise<never>(() => undefined) : write(path, bytes);
		void session.writeAlignment(newAlignment(IMAGE, { width: 10, height: 10 }));
		await tick();
		store.write = write;
		expect(journalPaths(storage)).toEqual([ALIGNMENT]);

		expect(await session.deleteMapImage(IMAGE)).toBe(true);
		session.capture();

		expect(readJournal(storage, JOURNALLED).entries).toEqual([]);
		expect(await store.list('')).toEqual([projectFilePath(DIRECTORY)]);
	});

	it('lets an in-flight Alignment write land before deleting the map', async () => {
		const { store, session } = await overAMap([INFO, ALIGNMENT]);
		await session.open(DIRECTORY);
		const land = holdOneWriteOpen(store, ALIGNMENT);
		void session.writeAlignment(newAlignment(IMAGE, { width: 10, height: 10 }));
		await tick();

		const deletion = session.deleteMapImage(IMAGE);
		await tick();
		land();

		expect(await deletion).toBe(true);
		expect(await store.list('')).toEqual([projectFilePath(DIRECTORY)]);
	});

	it('lets an in-flight write under images/<id>/ land before deleting the map', async () => {
		const { store, session } = await overAMap();
		await session.open(DIRECTORY);
		const base = 'https://static.example.test/iiif/plate-1';
		const service = await acceptRemoteImageService(
			{
				'@context': 'http://iiif.io/api/image/3/context.json',
				id: base,
				type: 'ImageService3',
				protocol: 'http://iiif.io/api/image',
				profile: 'level2',
				width: 1024,
				height: 1024,
				tiles: [{ width: 256, scaleFactors: [1, 2, 4] }]
			},
			{ requestedUrl: `${base}/info.json`, fallbackUri: base }
		);

		const land = holdOneWriteOpen(store, `images/${service.imageId}/remote.json`, {
			thenFail: true
		});
		void session.addReferencedMap({
			service,
			label: 'Plate 1',
			partOf: '',
			canvas: '',
			rights: '',
			attribution: '',
			alignment: null
		});
		await tick();

		const deletion = session.deleteMapImage(service.imageId);
		await tick();
		land();

		expect(await deletion).toBe(true);
		expect(await store.list('')).toEqual([projectFilePath(DIRECTORY)]);
	});

	it.each([
		['once the files are actually gone', 0, true, ''],
		['of a map the Workspace only half deleted', 2, false, 'only partly deleted']
	])('retires the journalled bytes %s', async (_, failingDelete, deleted, error) => {
		const { store, session, storage } = await overAMap([INFO, ALIGNMENT]);
		journalTheAlignment(storage);
		let seen = 0;
		const remove = store.delete.bind(store);
		store.delete = async (path) => {
			seen += 1;
			if (seen === failingDelete) throw new Error('The Workspace is locked');
			return remove(path);
		};

		expect(await session.deleteMapImage(IMAGE)).toBe(deleted);
		expect(session.mapImageError).toContain(error);
		expect(readJournal(storage, JOURNALLED).entries).toEqual([]);
	});
});

describe('what a Workspace key says about which directory it is', () => {
	it.each([
		[
			'a named browser Workspace, because this origin owns it',
			opfsWorkspaceKey('Marking 2026'),
			'this-browser'
		],
		[
			'a picked folder, because two drives may both hold one',
			folderWorkspaceKey('workspace:d3a1'),
			'a-name-anywhere'
		],
		['an empty key', '', 'a-name-anywhere'],
		['an unrecognised scheme', 'sharepoint:Teaching', 'a-name-anywhere'],
		['a scheme that merely contains opfs', 'mirror-of-opfs:Teaching', 'a-name-anywhere']
	])('places %s', (_, key, identity) => {
		expect(workspaceIdentityOf(key)).toBe(identity);
	});
});

describe('two folder Workspaces whose directories share a name', () => {
	const ONE = folderWorkspaceKey('workspace:9a0f4c1e');
	const OTHER = folderWorkspaceKey('workspace:41c7bd02');

	it('keep separate journals and unfinished deletions', () => {
		const storage = new FakeJournalStorage();
		const path = 'amsterdam-1625/project.json' as StorePath;
		const held = (key: string) =>
			readJournal(storage, key).entries.map((entry) => decoded(entry.bytes));

		new WriteAheadJournal(storage, ONE).record(path, encode('{"in":"one"}'));
		new WriteAheadJournal(storage, OTHER).record(path, encode('{"in":"other"}'));
		new DeletedProjects(storage, ONE).record('rotterdam-1690', null);

		expect(held(ONE)).toEqual(['{"in":"one"}']);
		expect(held(OTHER)).toEqual(['{"in":"other"}']);
		expect(new DeletedProjects(storage, OTHER).has('rotterdam-1690')).toBe(false);
		expect(new DeletedProjects(storage, ONE).has('rotterdam-1690')).toBe(true);
	});

	it('keep separate Remote bindings and Baselines', async () => {
		const storage = new FakeMetadataStorage();
		const atlas = { owner: 'ada', repository: 'atlas', branch: 'main' };
		const charts = { owner: 'grace', repository: 'charts', branch: 'main' };
		const one = new SynchronizationMetadata(storage, ONE);
		await one.bindRemote(atlas);
		await one.writeBaseline({ remote: atlas, commit: 'c0ffee', files: new Map() });
		const other = new SynchronizationMetadata(storage, OTHER);
		await other.bindRemote(charts);

		expect((await other.readRemote())?.repository).toBe('charts');
		expect(await other.readBaseline(charts)).toBeNull();
		expect((await one.readBaseline(atlas))?.commit).toBe('c0ffee');
	});
});

describe('the record of what is on disk for an Alignment', () => {
	const IMAGE = { width: 700, height: 500 };
	const IMAGE_ID = 'a-library-sheet';
	const THEIRS = '{"type":"Annotation","from":"a colleague"}\n';
	let alignment: Alignment;
	beforeEach(async () => {
		await openFresh();
		alignment = await opened.readAlignment(IMAGE_ID, IMAGE);
	});

	const aColleagueWrites = (document: string): Promise<void> =>
		store.write(`alignments/${IMAGE_ID}.json` as StorePath, encode(document));
	const readBack = async () =>
		decoded(await store.read(`alignments/${IMAGE_ID}.json` as StorePath));
	const save = (count: number) =>
		opened.writeAlignment({
			...alignment,
			controlPoints: Array.from({ length: count }, (_, index) => ({
				id: `p${index}`,
				ordinal: index + 1,
				resource: { x: 10 * index, y: 20 * index },
				geo: { lng: 4.9 + index / 100, lat: 52.3 + index / 100 }
			}))
		});

	async function displacedBy(theirs = THEIRS) {
		await save(1);
		await aColleagueWrites(theirs);
		await save(2);
		expect(opened.alignmentChangedElsewhere?.imageId).toBe(IMAGE_ID);
	}

	async function restoreDuringSave(count: number) {
		let restored: Promise<boolean> | undefined;
		store.afterRead = (path) => {
			if (!path.startsWith('alignments/') || restored) return;
			restored = opened.restoreAlignmentChangedElsewhere();
		};
		await save(count);
		return restored;
	}

	it('does not raise a concurrent-edit alarm on a session’s own successive saves', async () => {
		for (const count of [1, 2, 3]) {
			await save(count);
			expect(opened.saveError).toBe('');
			expect(opened.alignmentChangedElsewhere).toBeNull();
		}
	});

	it('raises it when the file really changed underneath, offers the displaced version back, and stops warning once it is restored', async () => {
		await displacedBy();
		expect(decoded(opened.alignmentChangedElsewhere?.displaced)).toContain('a colleague');

		await opened.restoreAlignmentChangedElsewhere();

		expect(await readBack()).toBe(THEIRS);
		expect(opened.alignmentChangedElsewhere).toBeNull();
		await save(3);
		expect(opened.alignmentChangedElsewhere).toBeNull();
	});

	it('puts their version back even when a save is mid-flight over it', async () => {
		await displacedBy();
		await restoreDuringSave(3);

		expect(
			await readBack(),
			'the save the user had already made came back over the version they asked to restore'
		).toBe(THEIRS);
		expect(opened.alignmentChangedElsewhere).toBeNull();
	});

	it('does not blank a warning that arrived while it was waiting its turn', async () => {
		const first = '{"type":"Annotation","from":"the first colleague"}\n';
		await displacedBy(first);
		expect(decoded(opened.alignmentChangedElsewhere?.displaced)).toContain('the first colleague');
		await aColleagueWrites('{"type":"Annotation","from":"the second colleague"}\n');

		expect(await restoreDuringSave(3)).toBe(true);
		expect(await readBack()).toBe(first);
		expect(
			decoded(opened.alignmentChangedElsewhere?.displaced),
			'a warning the user had not seen was cleared by an answer to a different one'
		).toContain('the second colleague');
	});

	it('says it did not put their version back, and leaves the warning standing', async () => {
		await displacedBy();

		store.refuseWrite = (path) => path.startsWith('alignments/');
		expect(await opened.restoreAlignmentChangedElsewhere()).toBe(false);
		expect(opened.saveError).toContain('refused to write');
		expect(opened.alignmentChangedElsewhere).not.toBeNull();
	});

	it('leaves an unrelated save failure on screen when it succeeds', async () => {
		await displacedBy();

		opened.saveError = 'the Project could not be saved';
		expect(await opened.restoreAlignmentChangedElsewhere()).toBe(true);
		expect(
			opened.saveError,
			'a failure the user could see was taken off the screen by an unrelated success'
		).toBe('the Project could not be saved');
	});

	it('keeps a gesture ending inside the previous write, and a third behind the second, unalarmed', async () => {
		await save(1);

		const queued: Promise<void>[] = [];
		let landed = 0;
		store.afterWrite = (path) => {
			if (!path.startsWith('alignments/')) return;
			landed += 1;
			if (landed <= 2) queued.push(save(landed + 2));
		};
		await save(2);
		while (queued.length > 0) await queued.shift();

		expect(opened.saveError).toBe('');
		expect(
			opened.alignmentChangedElsewhere,
			'a write that started before the one ahead of it had recorded its bytes'
		).toBeNull();
		expect(JSON.parse(await readBack()).body.features).toHaveLength(4);
	});

	it('is dismissible, and stays dismissed across the next save', async () => {
		await displacedBy('{"from":"a colleague"}\n');

		opened.dismissAlignmentChangedElsewhere();
		expect(opened.alignmentChangedElsewhere).toBeNull();

		await save(3);
		expect(opened.alignmentChangedElsewhere).toBeNull();
	});
});

describe('typing an Annotation’s words costs one write, not one per keystroke (ADR-0017 rule 2)', () => {
	beforeEach(openFresh);

	it('collapses nine keystrokes’ worth of debounced writes into one store write', async () => {
		const layer = newAnnotationLayer({ id: 'one', name: 'Warehouses' });
		const path = `${DIRECTORY}/${layer.geojsonRef}` as StorePath;
		const written: StorePath[] = [];
		store.afterWrite = (path) => written.push(path);
		const geometry = { type: 'Point', coordinates: [4.9, 52.37] } as const;

		const word = 'Zuiderzee';
		for (let typed = 1; typed <= word.length; typed += 1) {
			const title = word.slice(0, typed);
			await opened.writeAnnotations(
				layer,
				{ annotations: [newAnnotation({ id: 'a1', geometry, title })] },
				{ debounce: true }
			);
		}
		expect(written).toEqual([]);

		await opened.flush();

		expect(written).toEqual([path]);
		expect(decoded(await store.read(path))).toContain('Zuiderzee');
	});
});

describe('the Project’s map settings, which travel with it', () => {
	beforeEach(openFresh);
	const appearance = (relief: boolean, streets = true) => ({
		streets,
		relief,
		highContrast: false,
		imagery: false
	});

	it('writes the author’s boundary choice into project.json, at once rather than on a timer', async () => {
		await opened.updateProject({ borders: 'national' });

		expect(JSON.parse(await projectText(store)).borders).toBe('national');
		expect(opened.openProject?.borders).toBe('national');
	});

	it('writes the four Base Map switches into project.json at once, not on a timer', async () => {
		await opened.updateProject({ baseMapAppearance: appearance(true, false) });

		expect(JSON.parse(await projectText(store)).baseMapAppearance).toEqual(appearance(true, false));
		expect(opened.openProject?.baseMapAppearance.relief).toBe(true);
	});

	it.each([
		['borders', { borders: 'none' }, { borders: 'all' }],
		[
			'baseMapAppearance',
			{ baseMapAppearance: appearance(true) },
			{ baseMapAppearance: appearance(false) }
		]
	] as const)(
		'leaves no %s field behind for a Project drawn the ordinary way',
		async (field, chosen, ordinary) => {
			expect(await projectText(store)).not.toContain(field);

			await opened.updateProject(chosen);
			expect(await projectText(store)).toContain(field);

			await opened.updateProject(ordinary);
			expect(await projectText(store)).not.toContain(field);
		}
	);
});

describe('how the borders are drawn, which travels with the Project', () => {
	beforeEach(openFresh);
	type Patch = Parameters<EditorSession['chooseBorderStyle']>[0];
	const borderStyle = async () => JSON.parse(await projectText(store)).borderStyle;

	it.each<[string, Patch[], Patch]>([
		[
			'writes a chosen colour at once, because a swatch is one choice',
			[{ color: '#c1272d' }],
			{ color: '#c1272d' }
		],
		[
			'writes only what the author chose, so an automatic property leaves no key',
			[{ width: 3 }],
			{ width: 3 }
		],
		[
			'is a patch, so setting one property does not clear the one beside it',
			[{ color: '#c1272d' }, { width: 3 }],
			{ color: '#c1272d', width: 3 }
		]
	])('%s', async (_, patches, expected) => {
		for (const patch of patches) await opened.chooseBorderStyle(patch);

		expect(await borderStyle()).toEqual(expected);
	});

	it('takes the field back out when every property is handed back to the derivation', async () => {
		await opened.chooseBorderStyle({ color: '#c1272d', lineStyle: 'dotted', width: 3 });
		expect(await projectText(store)).toContain('borderStyle');

		await opened.chooseBorderStyle({ color: null, lineStyle: null, width: null });

		expect(await projectText(store)).not.toContain('borderStyle');
	});

	it('writes nothing on a release that followed no change, and a dragged width on the release', async () => {
		const written: StorePath[] = [];
		store.afterWrite = (path) => written.push(path);

		await opened.commitProject();
		expect(written).toEqual([]);

		await opened.chooseBorderStyle({ width: 2 }, { debounce: true });
		expect(written).toEqual([]);

		await opened.commitProject();

		expect(written).toEqual([projectFilePath(DIRECTORY)]);
		expect(await borderStyle()).toEqual({ width: 2 });
	});

	it('keeps the styling when the boundary level is turned off', async () => {
		await opened.chooseBorderStyle({ color: '#c1272d' });
		await opened.updateProject({ borders: 'none' });

		const document = JSON.parse(await projectText(store));
		expect(document.borderStyle).toEqual({ color: '#c1272d' });
		expect(document.borders).toBe('none');
	});
});

describe('tracking a Workspace’s own changes', () => {
	const KEY = opfsWorkspaceKey('Marking 2026');

	it('installs the same tracker for browser storage and for a chosen folder', async () => {
		const storage = new FakeMetadataStorage();
		const browser = trackLocalChanges(new MemoryProjectStore(), KEY, storage);
		const folder = trackLocalChanges(new MemoryProjectStore(), folderWorkspaceKey('maps'), storage);
		expect(browser).toBeInstanceOf(ManagedProjectStore);
		expect(folder).toBeInstanceOf(ManagedProjectStore);
		expect(trackLocalChanges(browser, KEY, storage)).toBe(browser);
	});

	it('leaves the store alone where there is nowhere durable to keep marks, and has no index then', () => {
		const store = new MemoryProjectStore();
		expect(trackLocalChanges(store, KEY, null)).toBe(store);
		expect(new EditorSession(store).localChanges).toBeNull();
	});

	it('records what an ordinary authoring action wrote, without any of it knowing', async () => {
		const storage = new FakeMetadataStorage();
		const store = trackLocalChanges(new MemoryProjectStore(), KEY, storage);
		const session = new EditorSession(store, { metadataStorage: storage, workspaceKey: KEY });
		const project = present(await session.createProject('Marking'));
		const changes = present(session.localChanges);
		expect((await changes.localChanges()).written).toEqual([projectFilePath(project.directory)]);
	});
});

describe('the Project screen’s Edit History (ADR-0039)', () => {
	async function withAnnotationLayers(count: number) {
		const store = new MemoryProjectStore();
		const session = await openOn(store);
		const layerIds: string[] = [];
		for (let at = 0; at < count; at += 1) {
			layerIds.push(present(await session.addAnnotationLayer(`Layer ${at + 1}`)).id);
		}
		await session.flush();
		return { store, session, layerIds };
	}

	it.each([
		[null, 'Undo delete of the Layer “Layer 1”'],
		['', 'Undo delete of the Layer with no name']
	])(
		'names the deleted Layer typed as %j in the sentence the bar will say',
		async (typed, label) => {
			const { session, layerIds } = await withAnnotationLayers(1);
			const [id] = layerIds as [string];
			if (typed !== null) {
				await session.typeLayerName(id, typed);
				await session.flush();
			}

			expect(await session.deleteLayer(id)).toBe(true);
			expect(undoLabel(session)).toBe(label);
		}
	);

	it('puts the stack entry and the Layer’s file back byte-identically, and deletes it again on redo', async () => {
		const { store, session, layerIds } = await withAnnotationLayers(2);
		const [doomed, kept] = layerIds as [string, string];
		const path = `${DIRECTORY}/${annotationPath(doomed)}`;
		const fileBefore = await store.read(path);
		const stackBefore = session.openProject?.layers;

		await session.deleteLayer(doomed);
		await session.flush();

		expect(await store.list(path)).toEqual([]);
		expect(layerIdsOf(session)).toEqual([kept]);

		await stepped(session, 'undo');

		expect(await store.read(path)).toEqual(fileBefore);
		expect(session.openProject?.layers).toEqual(stackBefore);

		await stepped(session, 'redo');

		expect(layerIdsOf(session)).toEqual([kept]);
		expect(await store.list(path)).toEqual([]);
	});

	it('walks back five deletions in order, and a sixth forgets the first', async () => {
		const { session, layerIds } = await withAnnotationLayers(6);
		const history = session.historyFor(DIRECTORY);
		let afterTheFirstDeletion: string[] = [];
		for (const [at, id] of layerIds.entries()) {
			await session.deleteLayer(id);
			if (at === 0) afterTheFirstDeletion = layerIdsOf(session);
		}
		await session.flush();
		expect(layerIdsOf(session)).toEqual([]);

		for (let step = 0; step < 5; step += 1) expect(await history.undo()).toBe(true);
		await session.flush();

		expect(layerIdsOf(session)).toEqual(afterTheFirstDeletion);
		expect(history.undoable).toBeNull();
	});

	it('keeps the history while the same Project stays open, and drops it when opened afresh', async () => {
		const { session, layerIds } = await withAnnotationLayers(1);
		await session.deleteLayer(layerIds[0] as string);

		await session.open(DIRECTORY);
		expect(session.historyFor(DIRECTORY).undoable).not.toBeNull();

		await session.open(null);
		await session.open(DIRECTORY);
		expect(session.historyFor(DIRECTORY).undoable).toBeNull();
	});

	it('keeps its place and says so when the write does not land', async () => {
		const { store, session, layerIds } = await withAnnotationLayers(1);
		await session.deleteLayer(layerIds[0] as string);
		await session.flush();

		refuseWrites(store);
		const history = session.historyFor(DIRECTORY);
		expect(await history.undo()).toBe(false);
		expect(history.undoable?.label).toBe('Undo delete of the Layer “Layer 1”');
		expect(history.redoable).toBeNull();
		expect(session.saveError).toContain('the drive is not there');
	});

	it('gives one subject the same history every time it is asked', async () => {
		const { session } = await withAnnotationLayers(0);

		expect(session.historyFor(DIRECTORY)).toBe(session.historyFor(DIRECTORY));
		expect(session.historyFor('another-project')).not.toBe(session.historyFor(DIRECTORY));
	});
});

describe('the rest of the Layer stack, as Steps of the Project’s Edit History (ADR-0039)', () => {
	const MAP = 'floride-1657';
	let session: EditorSession;
	let store: MemoryProjectStore;
	beforeEach(async () => {
		store = new MemoryProjectStore();
		await seedImageInfo(store, [MAP], { width: 1000, height: 800 });
		session = await openOn(store);
	});

	const addAnnotationLayer = async (name: string) =>
		present(await session.addAnnotationLayer(name));
	const addMap = async () => {
		const layer = present(await session.addWorkspaceMap(MAP));
		await session.flush();
		return layer;
	};
	const opacityOf = (id: string): number => {
		const layer = (session.openProject?.layers ?? []).find((one) => one.id === id);
		if (layer?.kind !== 'map') throw new Error('expected a map Layer');
		return layer.opacity;
	};

	it('undoes adding a Map Image, leaving its Alignment and its record exactly where they are', async () => {
		const layer = await addMap();
		const alignment = await store.read(alignmentPath(MAP));
		const info = await store.read(imageInfoPath(MAP));
		expect(undoLabel(session)).toBe(`Undo adding the Map Image “${layer.name}”`);

		await stepped(session, 'undo');

		expect(layerIdsOf(session)).toEqual([]);
		expect(await store.read(alignmentPath(MAP))).toEqual(alignment);
		expect(await store.read(imageInfoPath(MAP))).toEqual(info);

		await stepped(session, 'redo');
		expect(layerIdsOf(session)).toEqual([layer.id]);
	});

	it('undoes adding an Annotation Layer, taking its FeatureCollection with it', async () => {
		const layer = await addAnnotationLayer('Trade routes');
		await session.flush();
		const path = `${DIRECTORY}/${annotationPath(layer.id)}`;
		expect(await store.list(path)).toEqual([path]);
		expect(undoLabel(session)).toBe('Undo adding the Layer “Trade routes”');

		await stepped(session, 'undo');

		expect(layerIdsOf(session)).toEqual([]);
		expect(await store.list(path)).toEqual([]);

		await stepped(session, 'redo');
		expect(layerIdsOf(session)).toEqual([layer.id]);
		expect(await store.list(path)).toEqual([path]);
	});

	it('undoes hiding a Layer, and says which way it went', async () => {
		const layer = await addAnnotationLayer('Trade routes');
		const visible = () => session.openProject?.layers[0]?.visible;

		await session.showLayer(layer.id, false);
		await session.flush();
		expect(visible()).toBe(false);
		expect(undoLabel(session)).toBe('Undo hiding the Layer “Trade routes”');

		await stepped(session, 'undo');
		expect(visible()).toBe(true);

		await stepped(session, 'redo');
		expect(visible()).toBe(false);
		await stepped(session, 'undo');

		await session.showLayer(layer.id, false);
		await session.showLayer(layer.id, true);
		await session.flush();
		expect(visible()).toBe(true);
		expect(undoLabel(session)).toBe('Undo showing the Layer “Trade routes”');
	});

	it('makes a whole opacity drag one Step, back to where it started', async () => {
		const layer = await addMap();

		for (const opacity of [0.9, 0.7, 0.5, 0.4]) await session.dragLayerOpacity(layer.id, opacity);
		await session.commitLayerEdit();
		await session.flush();
		expect(opacityOf(layer.id)).toBeCloseTo(0.4, 5);
		expect(undoLabel(session)).toBe(`Undo the opacity of the Layer “${layer.name}”`);
		await stepped(session, 'undo');
		expect(opacityOf(layer.id)).toBeCloseTo(1, 5);
		await stepped(session, 'redo');
		expect(opacityOf(layer.id)).toBeCloseTo(0.4, 5);
		await stepped(session, 'undo');

		expect(undoLabel(session)).toBe(`Undo adding the Map Image “${layer.name}”`);
	});

	it('undoes moving a Layer in the stack', async () => {
		const first = await addAnnotationLayer('Trade routes');
		const second = await addAnnotationLayer('Hinterland');
		const order = layerIdsOf(session);

		await session.moveLayerTo(second.id, 1);
		await session.flush();
		expect(layerIdsOf(session)).toEqual([first.id, second.id]);
		expect(undoLabel(session)).toBe('Undo moving the Layer “Hinterland”');

		await stepped(session, 'undo');
		expect(layerIdsOf(session)).toEqual(order);

		await stepped(session, 'redo');
		expect(layerIdsOf(session)).toEqual([first.id, second.id]);
	});

	it('spends no Step on a rename, and keeps the history across one', async () => {
		const layer = await addAnnotationLayer('Trade routes');
		await session.deleteLayer(layer.id);
		await session.flush();
		const history = session.historyFor(DIRECTORY);
		const label = history.undoable?.label;
		const other = await addAnnotationLayer('Hinterland');
		await session.typeLayerName(other.id, 'Hinterland roads');
		await session.commitLayerEdit();
		await session.flush();

		expect(history.undoable?.label).toBe('Undo adding the Layer “Hinterland”');
		expect(await history.undo()).toBe(true);
		expect(history.undoable?.label).toBe(label);
	});

	it('carries a name typed after a Step across the undo of that Step', async () => {
		const doomed = await addAnnotationLayer('Trade routes');
		const kept = await addAnnotationLayer('Hinterland');
		await session.flush();

		expect(await session.deleteLayer(doomed.id)).toBe(true);
		await session.typeLayerName(kept.id, 'Hinterland roads');
		await session.commitLayerEdit();
		await session.flush();

		await stepped(session, 'undo');

		const names = (session.openProject?.layers ?? []).map((layer) => layer.name);
		expect(names).toEqual(['Hinterland roads', 'Trade routes']);
	});
});

const MAP = 'floride-1657';
const OTHER_MAP = 'nieuw-amsterdam-1660';
const IMAGE = { width: 1000, height: 800 };

const withPair = (alignment: Alignment, at: number): Alignment => ({
	...alignment,
	controlPoints: [
		...alignment.controlPoints,
		{
			id: `p${at}`,
			ordinal: alignment.controlPoints.length + 1,
			resource: { x: 10 * at, y: 20 * at },
			geo: { lng: 4.9 + at / 100, lat: 52.3 + at / 100 }
		}
	]
});

const gesture = (session: EditorSession, label: string, next: Alignment): Promise<void> =>
	session
		.historyFor(next.imageId)
		.step(label, [alignmentPath(next.imageId)], () => session.writeAlignment(next));

describe('the Alignment’s Edit History (ADR-0039)', () => {
	async function overAnAlignment() {
		const store = new MemoryProjectStore();
		await seedImageInfo(store, [MAP, OTHER_MAP], IMAGE);
		const session = await openOn(store);
		await session.addWorkspaceMap(MAP);
		await session.flush();
		return { store, session, alignment: await session.readAlignment(MAP, IMAGE) };
	}

	const nudgedCorner = (alignment: Alignment, at: number): Alignment => ({
		...alignment,
		resourceMask: alignment.resourceMask.map((vertex, index) =>
			index === at ? { x: vertex.x + 1, y: vertex.y + 1 } : vertex
		)
	});

	it.each([
		['Undo placing Control Point 2', (ground: Alignment) => withPair(ground, 2)],
		[
			'Undo move of Control Point 1',
			(ground: Alignment) => ({
				...ground,
				controlPoints: ground.controlPoints.map((point) => ({
					...point,
					resource: { x: 99, y: 99 }
				}))
			})
		],
		['Undo delete of Control Point 1', (ground: Alignment) => ({ ...ground, controlPoints: [] })],
		['Undo the Crop of “La Floride”', (ground: Alignment) => nudgedCorner(ground, 0)],
		[
			'Undo the Crop reset of “La Floride”',
			(ground: Alignment) => ({ ...ground, resourceMask: fullImageResourceMask(IMAGE) })
		],
		[
			'Undo the transformation of “La Floride”',
			(ground: Alignment) => ({ ...ground, transformationType: 'thinPlateSpline' as const })
		]
	])('undoes and redoes %s, byte for byte', async (label, edit) => {
		const { store, session, alignment } = await overAnAlignment();
		const onDisk = () => store.read(alignmentPath(MAP));

		await gesture(session, 'Undo placing Control Point 1', withPair(alignment, 1));
		await gesture(
			session,
			'Undo the Crop of “La Floride”',
			nudgedCorner(withPair(alignment, 1), 2)
		);
		const ground = await session.readAlignment(MAP, IMAGE);
		const before = await onDisk();

		await gesture(session, label, edit(ground));
		await session.flush();
		expect(await onDisk()).not.toEqual(before);
		expect(undoLabel(session, MAP)).toBe(label);
		await stepped(session, 'undo', MAP);
		expect(await onDisk()).toEqual(before);
		await stepped(session, 'redo', MAP);
		expect(await onDisk()).not.toEqual(before);
	});

	it('says an undone Alignment has been written back, and leaves the next ordinary save with nothing to report', async () => {
		const { session, alignment } = await overAnAlignment();
		await gesture(session, 'Undo placing Control Point 1', withPair(alignment, 1));
		await session.flush();
		const quiet = session.alignmentsWrittenBack;

		await stepped(session, 'undo', MAP);
		expect(session.alignmentsWrittenBack).toBe(quiet + 1);

		await session.writeAlignment(withPair(alignment, 2));
		await session.flush();

		expect(session.alignmentChangedElsewhere).toBeNull();
	});

	it('makes four Crop corner moves four Steps', async () => {
		const { session, alignment } = await overAnAlignment();
		const history = session.historyFor(MAP);
		let cropped = alignment;
		for (let corner = 0; corner < 4; corner += 1) {
			cropped = nudgedCorner(cropped, corner);
			await gesture(session, 'Undo the Crop of “La Floride”', cropped);
		}
		await session.flush();

		for (let back = 0; back < 4; back += 1) {
			expect(history.undoable?.label).toBe('Undo the Crop of “La Floride”');
			expect(await history.undo()).toBe(true);
		}
		await session.flush();

		expect(history.undoable).toBeNull();
		expect((await session.readAlignment(MAP, IMAGE)).resourceMask).toEqual(alignment.resourceMask);
		expect(cropped.resourceMask).not.toEqual(alignment.resourceMask);
	});

	it('bounds one history by bytes and not only by depth', async () => {
		const { session, alignment } = await overAnAlignment();
		const history = session.historyFor(MAP);

		for (let mark = 1; mark <= 3; mark += 1) {
			await gesture(session, `Undo edit ${mark}`, {
				...withPair(alignment, 1),
				unmodelled: { bulk: String(mark).repeat(9 * 1024 * 1024) }
			});
		}
		await session.flush();

		expect(history.undoable?.label).toBe('Undo edit 3');
		expect(await history.undo()).toBe(true);
		expect(history.undoable).toBeNull();
	});

	it('gives each Map Image its own history, and keeps the first’s intact', async () => {
		const { session, alignment } = await overAnAlignment();
		await session.addWorkspaceMap(OTHER_MAP);
		await session.flush();
		const other = await session.readAlignment(OTHER_MAP, IMAGE);
		const transformed = 'Undo the transformation of “Nieuw Amsterdam”';

		await gesture(session, 'Undo placing Control Point 1', withPair(alignment, 1));
		await gesture(session, transformed, { ...other, transformationType: 'polynomial2' });
		await session.flush();

		expect(undoLabel(session, OTHER_MAP)).toBe(transformed);
		expect(undoLabel(session, MAP)).toBe('Undo placing Control Point 1');

		await session.open(null);
		await session.open(DIRECTORY);
		expect(undoLabel(session, MAP)).toBe('Undo placing Control Point 1');
	});
});

function anonymously(github: FakeGitHub): () => void {
	const wasFetching = globalThis.fetch;
	globalThis.fetch = github.fetch as typeof globalThis.fetch;
	const storage = Object.getOwnPropertyDescriptor(navigator, 'storage');
	Object.defineProperty(navigator, 'storage', {
		configurable: true,
		value: { estimate: () => Promise.resolve({ quota: 2 ** 40, usage: 0 }) }
	});
	return () => {
		globalThis.fetch = wasFetching;
		if (storage) Object.defineProperty(navigator, 'storage', storage);
		else Reflect.deleteProperty(navigator, 'storage');
	};
}

describe('an Edit History and the writes it did not make', () => {
	const ADDED_LAYER = 'Undo adding the Layer “Warehouses”';
	const PLACED = 'Undo placing Control Point 1';

	async function withStepsOnBothScreens(options: EditorSessionOptions = {}) {
		const store = new MemoryProjectStore();
		await seedImageInfo(store, [MAP, OTHER_MAP], IMAGE);
		const session = await openOn(store, options);
		await session.addWorkspaceMap(MAP);
		await session.addAnnotationLayer('Warehouses');
		await session.flush();
		await placeAPair(session, MAP);
		return { store, session };
	}

	async function placeAPair(
		session: EditorSession,
		map: string,
		options: { label?: string; base?: Alignment } = {}
	): Promise<void> {
		const alignment = options.base ?? (await session.readAlignment(map, IMAGE));
		await gesture(
			session,
			options.label ?? PLACED,
			withPair(alignment, alignment.controlPoints.length)
		);
		await session.flush();
	}

	const aColleagueWrites = (store: MemoryProjectStore, map: string): Promise<void> =>
		store.write(
			`alignments/${map}.json` as StorePath,
			encode('{"type":"Annotation","from":"a colleague"}\n')
		);

	const forgotten = (session: EditorSession, subject: string) => {
		expect(session.historyFor(subject).undoable).toBeNull();
		expect(session.historyFor(subject).redoable).toBeNull();
	};

	it('goes when a concurrent write is reported, and the Project’s does not', async () => {
		const { store, session } = await withStepsOnBothScreens();
		const mine = await session.readAlignment(MAP, IMAGE);
		await aColleagueWrites(store, MAP);

		await placeAPair(session, MAP, { label: 'Undo placing Control Point 2', base: mine });

		expect(session.alignmentChangedElsewhere?.imageId).toBe(MAP);
		expect(undoLabel(session, MAP)).toBe('Undo placing Control Point 2');
		expect(await session.historyFor(MAP).undo()).toBe(true);
		expect(session.historyFor(MAP).undoable).toBeNull();
		expect(undoLabel(session)).toBe(ADDED_LAYER);
	});

	it('goes when a colleague’s Alignment is put back', async () => {
		const { store, session } = await withStepsOnBothScreens();
		const mine = await session.readAlignment(MAP, IMAGE);
		await aColleagueWrites(store, MAP);
		await placeAPair(session, MAP, { base: mine });
		expect(session.alignmentChangedElsewhere).not.toBeNull();

		await placeAPair(session, MAP);
		expect(session.historyFor(MAP).undoable).not.toBeNull();
		expect(await session.restoreAlignmentChangedElsewhere()).toBe(true);
		forgotten(session, MAP);
	});

	it('goes when its Map Image is deleted, and the Project’s does not', async () => {
		const { session } = await withStepsOnBothScreens();

		await placeAPair(session, OTHER_MAP);
		expect(session.historyFor(OTHER_MAP).undoable).not.toBeNull();
		expect(await session.deleteMapImage(OTHER_MAP)).toBe(true);
		forgotten(session, OTHER_MAP);
		expect(undoLabel(session, MAP)).toBe(PLACED);
		expect(undoLabel(session)).toBe(ADDED_LAYER);
	});

	it('is not discarded by its own write-back, and raises no notice', async () => {
		const { session } = await withStepsOnBothScreens();
		await placeAPair(session, MAP);

		await stepped(session, 'undo', MAP);

		expect(session.alignmentChangedElsewhere).toBeNull();
		expect(session.historyFor(MAP).redoable?.label).toBe(PLACED);
		expect(undoLabel(session, MAP)).toBe(PLACED);
	});

	it('goes for every subject when a get from a Remote lands', async () => {
		const remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		const metadataStorage = new FakeMetadataStorage();
		const workspaceKey = 'opfs:Amsterdam';
		const { store, session } = await withStepsOnBothScreens({ workspaceKey, metadataStorage });
		expect(session.historyFor(DIRECTORY).undoable).not.toBeNull();
		expect(session.historyFor(MAP).undoable).not.toBeNull();
		const held = await shareEverything(store, metadataStorage, workspaceKey, remote);

		const github = await createFakeGitHub({
			owner: remote.owner,
			repository: remote.repository,
			tree: {
				...Object.fromEntries(held),
				'delft/project.json': serialiseProjectFile(
					newProjectFile('Delft', new Date('2026-08-08T00:00:00Z'))
				),
				'delft/annotations/spare.geojson': '{"type":"FeatureCollection","features":[]}'
			}
		});
		const restore = anonymously(github);
		try {
			const { update } = await session.updateFromRemote({ remote, token: null });
			expect(update.added).toContain('delft/project.json');
		} finally {
			restore();
		}

		forgotten(session, DIRECTORY);
		forgotten(session, MAP);
	});
});

describe('checking a private Remote', () => {
	const REMOTE = { owner: 'ada', repository: 'atlas', branch: 'main' };
	const WORKSPACE = 'opfs:Amsterdam';

	it('is Cannot tell while signed out, rather than the agreement it last found', async () => {
		const store = new MemoryProjectStore();
		await seedProject(store);
		const metadataStorage = new FakeMetadataStorage();
		const held = await shareEverything(store, metadataStorage, WORKSPACE, REMOTE);
		const github = await createFakeGitHub({
			owner: REMOTE.owner,
			repository: REMOTE.repository,
			tree: Object.fromEntries(held)
		});
		github.privateRepository = true;
		await new SynchronizationMetadata(metadataStorage, WORKSPACE).bindRemote(REMOTE);
		const session = new EditorSession(trackLocalChanges(store, WORKSPACE, metadataStorage), {
			metadataStorage,
			workspaceKey: WORKSPACE
		});

		const restore = anonymously(github);
		try {
			for (const [credential, status] of [
				['ghp_a-token', 'in-sync'],
				[null, 'cannot-tell']
			] as const) {
				const remote = new Remote(session, {
					name: () => 'Amsterdam',
					github: { credential } as never
				});
				await remote.load();
				await remote.check();
				remote.close();
				expect(remote.status).toMatchObject({
					status,
					failure: '',
					publishedSiteStale: [],
					shareLinks: false
				});
			}
		} finally {
			restore();
		}
	});
});

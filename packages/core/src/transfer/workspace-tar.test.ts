import { createTarPacker, unpackTar } from 'modern-tar';
import { describe, expect, it } from 'vitest';

import { imageInfoPath } from '../project/image-files.js';
import { ProjectFormatTooNewError } from '../project/project-file.js';
import {
	REVIEW_MARK_FORMAT_VERSION,
	REVIEW_MARK_PATH,
	ReviewWorkspaceError,
	serialiseReviewMark
} from '../project/review-workspace.js';
import { Workspace } from '../project/workspace.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { toWorkspaceName } from '../store/opfs-workspaces.js';
import { collect, decode, encode, rejection, streamOf } from '../test-support.js';
import { archivePathFor, BackupRejectedError, TAR_ENTRY_MTIME } from './archive.js';
import { exportWorkspaceTar } from './export-workspace-tar.js';
import { restoreWorkspaceTar } from './restore-workspace-tar.js';
import {
	PLAN_LAYER,
	contents,
	destination as openInto,
	planted,
	projectJson as bundleProjectJson,
	tarOf
} from './test-fixtures.js';
import type { TransferProgress } from './transfer.js';

const projectJson = (overrides: Record<string, unknown> = {}): string =>
	bundleProjectJson({ layers: [PLAN_LAYER], ...overrides });

const EMPTY_FC = '{"type":"FeatureCollection","features":[]}';
const twoProjectsOneMap = (): Record<string, string> => ({
	'amsterdam-1625/project.json': projectJson({ name: 'Amsterdam 1625' }),
	'amsterdam-1625/annotations/warehouses.geojson': EMPTY_FC,
	'the-canal-ring/project.json': projectJson({ name: 'The Canal Ring' }),
	'the-canal-ring/annotations/bridges.geojson': EMPTY_FC,
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'not really a jpeg, but bytes',
	'images/amsterdam-1625/256,0,256,256/256,256/0/default.jpg': 'nor is this one'
});

const archiveOf = async (
	store: MemoryProjectStore,
	workspaceName: string,
	options?: Parameters<typeof exportWorkspaceTar>[2]
) => collect((await exportWorkspaceTar(store, workspaceName, options)).body);

const names = async (archive: Uint8Array) =>
	(await unpackTar(archive, { strict: true })).map((entry) => entry.header.name);

const destination = (name = 'Restored') => openInto(name, {});

const restoreFrom = async (store: MemoryProjectStore, name = 'W', as?: string) => {
	const there = destination(as);
	const restored = await restoreWorkspaceTar(streamOf(await archiveOf(store, name)), there.open);
	return { there, restored };
};

describe('a Workspace backs up to one tar anyone can open', () => {
	it('carries two Projects and the Map Image they share, under a constant-time Workspace folder', async () => {
		const seen: TransferProgress[] = [];
		const backup = await exportWorkspaceTar(planted(twoProjectsOneMap()), 'Marking 2026', {
			onProgress: (progress) => seen.push(progress)
		});
		expect([backup.fileName, backup.totalFiles]).toEqual(['Marking 2026.tar', 8]);
		const entries = await unpackTar(await collect(backup.body), { strict: true });
		expect(entries.map((entry) => entry.header.name)).toEqual([
			'Marking 2026/',
			'Marking 2026/alignments/amsterdam-1625.json',
			'Marking 2026/amsterdam-1625/annotations/warehouses.geojson',
			'Marking 2026/amsterdam-1625/project.json',
			'Marking 2026/images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg',
			'Marking 2026/images/amsterdam-1625/256,0,256,256/256,256/0/default.jpg',
			'Marking 2026/images/amsterdam-1625/info.json',
			'Marking 2026/the-canal-ring/annotations/bridges.geojson',
			'Marking 2026/the-canal-ring/project.json'
		]);
		expect(entries[0]?.header.type).toBe('directory');
		expect(entries.map((entry) => entry.header.mtime?.getTime())).toEqual(
			entries.map(() => TAR_ENTRY_MTIME.getTime())
		);
		expect(seen.at(-1)).toEqual({
			files: 8,
			totalFiles: 8,
			bytes: backup.totalBytes,
			totalBytes: backup.totalBytes,
			path: null
		});
	});

	it('leaves out the published viewer files', async () => {
		const store = planted({
			...twoProjectsOneMap(),
			'index.html': '<!doctype html>',
			'robots.txt': 'User-agent: *',
			'ballastella-site.json': '{"projects":[]}',
			'_app/immutable/chunks/abc123.js': 'export{}',
			'base-map/tiles/protomaps/0/0/0.mvt': 'tile bytes'
		});

		const listed = await names(await archiveOf(store, 'W'));

		expect(
			listed.filter((name) =>
				/^W\/(index\.html|robots\.txt|ballastella-site|_app\/|base-map\/)/.test(name)
			)
		).toEqual([]);
		expect(listed).toContain(archivePathFor('W', 'amsterdam-1625/project.json'));
		expect(listed).toContain(archivePathFor('W', imageInfoPath('amsterdam-1625')));
	});

	it('holds an empty Workspace’s name, and nothing else', async () => {
		expect(await names(await archiveOf(new MemoryProjectStore(), 'Empty'))).toEqual(['Empty/']);
	});

	it('produces identical bytes twice, whatever order the store lists files in', async () => {
		const forwards = planted(twoProjectsOneMap());
		const backwards = planted(Object.fromEntries(Object.entries(twoProjectsOneMap()).reverse()));
		const first = await archiveOf(forwards, 'W');
		expect([await archiveOf(forwards, 'W'), await archiveOf(backwards, 'W')]).toEqual([
			first,
			first
		]);
	});

	it('reads back an archive another packer wrote', async () => {
		const { readable, controller } = createTarPacker();
		const mtime = TAR_ENTRY_MTIME;
		const producing = (async () => {
			await controller.add({ name: 'Handmade/', size: 0, type: 'directory', mtime }).close();
			const manifest = encode(projectJson());
			const name = 'Handmade/a-project/project.json';
			const writer = controller
				.add({ name, size: manifest.length, type: 'file', mtime })
				.getWriter();
			await writer.write(manifest);
			await writer.close();
			controller.finalize();
		})();

		const restored = await restoreWorkspaceTar(readable, destination().open);
		await producing;

		expect([restored.backupName, restored.projects]).toEqual(['Handmade', ['a-project']]);
	});
});

describe('restoring reproduces the Workspace', () => {
	it('brings back every file byte for byte, into a new Workspace, touching none other', async () => {
		const files = twoProjectsOneMap();
		const mine = planted({
			'my-project/project.json': projectJson({ name: 'My own work' }),
			'alignments/amsterdam-1625.json': '{"mine":true}'
		});
		const before = contents(mine);
		const original = await archiveOf(planted(files), 'Marking 2026');
		const there = destination('Marking 2026 (2)');

		const restored = await restoreWorkspaceTar(streamOf(original), there.open);

		expect(contents(there.store)).toEqual(files);
		expect(await archiveOf(there.store, 'Marking 2026')).toEqual(original);
		expect(there.asked).toEqual(['Marking 2026']);
		expect(restored).toMatchObject({
			backupName: 'Marking 2026',
			workspaceName: 'Marking 2026 (2)',
			totalFiles: 8,
			totalBytes: Object.values(files).reduce((sum, content) => sum + encode(content).length, 0),
			declined: []
		});
		expect(restored.projects.toSorted()).toEqual(['amsterdam-1625', 'the-canal-ring']);
		expect(restored.notice).not.toContain('not restored');
		expect(contents(mine)).toEqual(before);

		const workspace = new Workspace(there.store);
		const projects = await workspace.listProjects();
		expect(projects.map(({ directory, problem }) => [directory, problem]).toSorted()).toEqual([
			['amsterdam-1625', null],
			['the-canal-ring', null]
		]);
		expect((await workspace.readProject('amsterdam-1625')).name).toBe('Amsterdam 1625');
	});

	it('says that Share Links are needed before the Workspace is a site again', async () => {
		const store = planted({ 'a/project.json': projectJson(), 'index.html': '<!doctype html>' });
		const { restored } = await restoreFrom(store, 'W', 'Marking 2026');
		expect(restored.notice).toMatch(/Share Links/i);
		expect(restored.notice).toMatch(/offline/i);
		expect(restored.notice).toContain('Marking 2026');
	});

	it('does not count an Alignment it declined, and says so', async () => {
		const store = planted({
			'alignments/m.json': '{"from":"the backup"}',
			'a/project.json': projectJson()
		});
		const there = destination();
		there.store.plant('alignments/m.json', encode('{"already":"here"}'));

		const restored = await restoreWorkspaceTar(streamOf(await archiveOf(store, 'W')), there.open);
		expect(decode(await there.store.read('alignments/m.json'))).toBe('{"already":"here"}');
		expect(restored).toMatchObject({
			declined: ['alignments/m.json'],
			totalFiles: 1,
			totalBytes: encode(projectJson()).length
		});
		expect(restored.notice).toContain('not restored');
		expect(restored.notice).toContain('alignments/m.json');
	});

	it('round-trips more than 65,535 files, past the zip’s ceiling, with the count intact', async () => {
		const count = 70_000;
		const store = new MemoryProjectStore();
		store.plant('a-project/project.json', encode(projectJson()));
		for (let i = 0; i < count; i += 1) store.plant(`images/big/${i}.jpg`, encode('t'));
		const backup = await exportWorkspaceTar(store, 'Huge');
		const there = destination();
		const restored = await restoreWorkspaceTar(backup.body, there.open);
		expect([backup.totalFiles, restored.totalFiles, (await there.store.list('')).length]).toEqual([
			count + 1,
			count + 1,
			count + 1
		]);
		expect((await there.store.list('images/big/')).length).toBe(count);
	}, 300_000);

	it('round-trips a 64-character Project directory and Workspace name past tar’s 100 bytes', async () => {
		const sixtyFour = 'a-project-name-at-the-sixty-four-character-limit-exactly-aaaaaaa';
		const workspaceName = 'A Workspace Name At The Sixty Four Code Point Limit Exactly aaaa';
		expect([sixtyFour.length, [...workspaceName].length]).toEqual([64, 64]);
		const files: Record<string, string> = { [`${sixtyFour}/project.json`]: projectJson() };
		for (const uuid of [
			'0189a4c3-1c2f-7f1e-9b3a-0f2e5d6c7a8b',
			'0189a4c3-1c2f-7f1e-9b3a-0f2e5d6c7a8c'
		]) {
			files[`${sixtyFour}/annotations/${uuid}.geojson`] = `{"uuid":"${uuid}"}`;
		}
		const archive = await archiveOf(planted(files), workspaceName);

		const lengths = (await names(archive)).map((name) => new TextEncoder().encode(name).length);
		expect(Math.max(...lengths)).toBeGreaterThan(100);
		const there = destination();
		await restoreWorkspaceTar(streamOf(archive), there.open);
		expect(contents(there.store)).toEqual(files);
	});

	it.for(['अंकन २०२६', '標記二〇二六', 'ترميز ٢٠٢٦', 'Markierung Grün'])(
		'round-trips the non-Latin Workspace name %j',
		async (name) => {
			const files = { [`${'p'.repeat(64)}/annotations/a.geojson`]: '{}' };
			const { there, restored } = await restoreFrom(planted(files), name);
			expect([restored.backupName, there.asked, contents(there.store)]).toEqual([
				name,
				[name],
				files
			]);
		}
	);
});

describe('an interrupted restore leaves no Project on the hub', () => {
	it('writes project.json last, so the manifests arrive after everything they name', async () => {
		const there = destination();
		const order: string[] = [];
		await restoreWorkspaceTar(
			streamOf(await archiveOf(planted(twoProjectsOneMap()), 'W')),
			there.open,
			{ onProgress: ({ path }) => void (path !== null && order.push(path)) }
		);

		const manifests = order.filter((path) => path.endsWith('/project.json'));
		expect(manifests).toEqual(['amsterdam-1625/project.json', 'the-canal-ring/project.json']);
		expect(order.slice(-manifests.length)).toEqual(manifests);
	});

	it.each([
		['the archive is truncated part way through', true, /truncated/i],
		['a write fails part way through', false, /./]
	] as const)('lists nothing on the hub when %s', async (_when, truncate, thrown) => {
		const archive = await archiveOf(planted(twoProjectsOneMap()), 'W');
		const there = destination();
		if (!truncate) there.store.failNextWrite('rename');
		const source = truncate ? archive.subarray(0, Math.floor(archive.length / 2)) : archive;

		await expect(restoreWorkspaceTar(streamOf(source), there.open)).rejects.toThrow(thrown);

		expect(await new Workspace(there.store).listProjects()).toEqual([]);
		expect(there.discarded()).toBe(true);
		expect(await there.store.list('')).toEqual([]);
	});
});

describe('a backup that is not one is refused', () => {
	const refuse = async (archive: Uint8Array): Promise<BackupRejectedError> => {
		const there = destination();
		const cause = await rejection(
			BackupRejectedError,
			restoreWorkspaceTar(streamOf(archive), there.open)
		);
		expect(await there.store.list('')).toEqual([]);
		expect(cause.message).toMatch(/Nothing has been restored/);
		return cause;
	};

	it('refuses one from a newer version of the app before its manifest, naming where to get that version', async () => {
		const store = planted({
			'a-project/project.json': projectJson({ formatVersion: 99 }),
			'images/amsterdam-1625/info.json': '{"width":1,"height":1}'
		});
		const there = destination();
		let sawManifest = false;
		const refusal = restoreWorkspaceTar(streamOf(await archiveOf(store, 'W')), there.open, {
			onProgress: ({ path }) => void (sawManifest ||= path?.endsWith('project.json') ?? false)
		});
		await expect(refusal).rejects.toBeInstanceOf(ProjectFormatTooNewError);
		await expect(refusal).rejects.toThrow(/Nothing has been restored/);
		await expect(refusal).rejects.toThrow(/ballastella/i);

		expect(sawManifest).toBe(false);
		expect(there.discarded()).toBe(true);
		expect(await there.store.list('')).toEqual([]);
	});

	it.each([
		['an empty file', new Uint8Array(0)],
		['a file that is not an archive at all', encode('this is a JPEG, or a shopping list')]
	])('refuses %s, in words rather than in the parser’s', async (_what, archive) => {
		const error = await refuse(archive);
		expect(error.reason).toBe('not-a-tar');
		expect(error.message).toMatch(/downloaded completely/);
	});

	it.each([
		['does not open with a Workspace folder', [['project.json', '{}']]],
		['is well-formed but empty', []],
		['names its Workspace folder with a path rather than a name', [['has/a/slash/']]],
		['names its Workspace folder Marking#2026', [['Marking#2026/']]],
		['names its Workspace folder Café Notes', [['Café Notes/']]]
	] as const)('says an archive that %s holds no Workspace', async (_what, entries) => {
		expect((await refuse(await tarOf(entries))).reason).toBe('no-workspace-directory');
	});

	it.each([
		['climbs out of the Workspace', 'W/../../elsewhere.txt', 'elsewhere.txt'],
		['is outside the folder the archive names', 'Another Workspace/x.txt', 'Another Workspace'],
		['claims the store’s reserved temporary suffix', 'W/a/secret.ballastella-tmp', 'secret'],
		['is longer than any Workspace path needs', `W/${'d/'.repeat(600)}file.json`, '1024 bytes']
	])('refuses an entry that %s', async (_what, name, named) => {
		const error = await refuse(await tarOf([['W/'], [name, 'x']]));
		expect(error.reason).toBe('path-traversal');
		expect(error.message).toContain(named);
	});

	it.each([
		[
			'more Projects than a Workspace is',
			Array.from(
				{ length: 1001 },
				(_unused, i) => [`W/p${i}/project.json`, projectJson()] as const
			),
			'1000'
		],
		[
			'a project.json far larger than a manifest',
			[['W/a/project.json', 'x'.repeat(5 * 1024 * 1024)] as const],
			'project.json'
		]
	])('refuses a backup claiming %s', async (_what, entries, named) => {
		const error = await refuse(await tarOf([['W/'], ...entries]));
		expect(error.reason).toBe('too-large');
		expect(error.message).toContain(named);
	});
});

describe('quota is checked before restoring, not discovered at eighty per cent', () => {
	const backupOf = async (): Promise<Uint8Array> =>
		archiveOf(planted(twoProjectsOneMap()), 'Marking 2026');

	it('refuses beforehand with the numbers, and writes nothing', async () => {
		const there = destination();

		const refusal = restoreWorkspaceTar(streamOf(await backupOf()), there.open, {
			archiveBytes: 900_000_000,
			estimateStorage: async () => ({ quota: 1_000_000_000, usage: 950_000_000 })
		});

		await expect(refusal).rejects.toBeInstanceOf(BackupRejectedError);
		for (const amount of [/900 MB/, /50 MB/, /1.0 GB/])
			await expect(refusal).rejects.toThrow(amount);
		expect([there.asked, there.discarded(), await there.store.list('')]).toEqual([[], false, []]);
	});

	it.each([
		['there is room', 1000, async () => ({ quota: 1_000_000_000, usage: 0 })],
		['the browser has no estimate', 900_000_000, async () => null],
		['the browser’s estimate is empty', 900_000_000, async () => ({})],
		['the browser gives no usage', 900_000_000, async () => ({ quota: 1_000_000_000 })],
		[
			'the browser’s estimate throws',
			900_000_000,
			async () => {
				throw new Error('no');
			}
		]
	])('restores when %s', async (_when, archiveBytes, estimate) => {
		const restored = await restoreWorkspaceTar(streamOf(await backupOf()), destination().open, {
			archiveBytes,
			estimateStorage: estimate as never
		});
		expect(restored.totalFiles).toBe(8);
	});
});

describe('restoring does not hold the archive in memory', () => {
	const OVER_THE_BUFFER = 32 * 1024 * 1024;
	const STREAM_BUFFER_CEILING = 16 * 1024 * 1024;
	const CHUNK = 64 * 1024;

	it('writes files while most of the archive is unread, never letting more than the stream chain’s buffer go unwritten', async () => {
		const store = new MemoryProjectStore();
		store.plant('a-project/project.json', encode(projectJson()));
		const tile = encode('x'.repeat(CHUNK));
		for (let i = 0; i < OVER_THE_BUFFER / CHUNK; i += 1) store.plant(`images/big/${i}.jpg`, tile);
		const archive = await archiveOf(store, 'W');
		expect(archive.length).toBeGreaterThan(OVER_THE_BUFFER);
		let fed = 0;
		let written = 0;
		let maxOutstanding = 0;
		let fedAtFirstFile = -1;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (fed >= archive.length) return controller.close();
				const end = Math.min(fed + CHUNK, archive.length);
				controller.enqueue(archive.subarray(fed, end));
				fed = end;
				maxOutstanding = Math.max(maxOutstanding, fed - written);
			}
		});
		const there = destination();

		await restoreWorkspaceTar(source, there.open, {
			onProgress: (progress) => {
				written = progress.bytes;
				if (progress.files === 1 && fedAtFirstFile < 0) fedAtFirstFile = fed;
			}
		});

		expect(fedAtFirstFile).toBeGreaterThan(0);
		expect(fedAtFirstFile).toBeLessThan(STREAM_BUFFER_CEILING);
		expect(maxOutstanding).toBeLessThan(STREAM_BUFFER_CEILING);
		expect(maxOutstanding).toBeLessThan(archive.length / 2);
		expect(await there.store.list('images/big/')).toHaveLength(OVER_THE_BUFFER / CHUNK);
	}, 120_000);
});

describe('a folder Workspace’s name is not a Workspace name, and a backup survives that', () => {
	it.for([
		"Dave's maps",
		'maps, 1625',
		'maps & plans',
		'2026-08-08 backup!',
		'Café Notes',
		`a very long folder name ${'x'.repeat(80)}`
	])('backs up and restores a folder called %j', async (folderName) => {
		const legal = toWorkspaceName(folderName);
		expect(legal).not.toBe(folderName);
		const backup = await exportWorkspaceTar(planted(twoProjectsOneMap()), folderName);
		expect([backup.workspaceName, backup.fileName, backup.displayName]).toEqual([
			legal,
			`${legal}.tar`,
			folderName
		]);
		const archive = await collect(backup.body);
		const listed = await names(archive);
		expect(listed[0]).toBe(`${legal}/`);
		expect(listed.every((name) => name.startsWith(`${legal}/`))).toBe(true);
		const there = destination(legal);
		const restored = await restoreWorkspaceTar(streamOf(archive), there.open);
		expect(contents(there.store)).toEqual(twoProjectsOneMap());
		expect([restored.backupName, there.asked, restored.backupDirectoryName]).toEqual([
			folderName,
			[folderName],
			legal
		]);
	});

	it('writes no extra record when the name is already a legal one', async () => {
		const text = async (name: string) =>
			new TextDecoder('latin1').decode(await archiveOf(planted(twoProjectsOneMap()), name));
		expect(await text('Marking 2026')).not.toContain('BALLASTELLA.workspace');
		expect(await text("Dave's maps")).toContain('BALLASTELLA.workspace');
	});

	it.for(['../../elsewhere', 'a\\b', 'x'.repeat(1000), ''])(
		'ignores the display-name record %j, which is not a name',
		async (hostile) => {
			const archive = await tarOf([['W/'], ['W/a/project.json', projectJson()]], {
				'BALLASTELLA.workspace': hostile
			});
			const there = destination();
			const restored = await restoreWorkspaceTar(streamOf(archive), there.open);
			expect([restored.backupName, there.asked]).toEqual(['W', ['W']]);
		}
	);
});

describe('a Review Workspace is never backed up', () => {
	it('refuses, naming what it holds and the way out, having read the mark and nothing else', async () => {
		const store = planted(twoProjectsOneMap());
		store.plant(
			REVIEW_MARK_PATH,
			serialiseReviewMark({
				formatVersion: REVIEW_MARK_FORMAT_VERSION,
				project: 'Amsterdam 1625',
				directory: 'amsterdam-1625',
				openedAt: '2026-08-08T09:00:00.000Z',
				origin: null
			})
		);
		let listed = 0;
		const reads: string[] = [];
		const list = store.list.bind(store);
		const read = store.read.bind(store);
		store.list = async (prefix: string) => (listed++, list(prefix));
		store.read = async (path: string) => (reads.push(path), read(path));

		const cause = await rejection(
			ReviewWorkspaceError,
			exportWorkspaceTar(store, 'amsterdam-1625')
		);

		expect(cause.message).toContain('“Amsterdam 1625”');
		expect(cause.message).toContain('cannot be backed up');
		expect([listed, reads]).toEqual([0, [REVIEW_MARK_PATH]]);
	});
});

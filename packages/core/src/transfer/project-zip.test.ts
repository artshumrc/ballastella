import { zipSync, type Zippable } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';

import { ProjectFormatTooNewError, ProjectFileUnreadableError } from '../project/project-file.js';
import { ProjectDirectoryCollisionError, Workspace } from '../project/workspace.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { InvalidPathError, type Bytes, type StorePath } from '../store/project-store.js';
import { MAX_ZIP_ENTRIES, exportProjectZip } from './export-project-zip.js';
import {
	PROJECT_ZIP_LIMITS,
	ProjectZipRejectedError,
	readProjectZip,
	type ReadProjectZipOptions
} from './import-project-zip.js';
import type { TransferProgress } from './transfer.js';
import { createViewerFileFilter } from './viewer-files.js';

// SPEC's Seam 1. Export and import are file-level behaviours end to end — "the zip contains
// exactly these bytes", "after importing, the Workspace holds exactly these files" — so the
// in-memory ProjectStore is not standing in for anything. The one thing this seam cannot see is
// the UI, which `e2e/editor-transfer.e2e.ts` covers.

const encode = (text: string): Bytes => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A `project.json` a scholar's Project would really have, with two Layers that point at files. */
const projectJson = (overrides: Record<string, unknown> = {}) =>
	`${JSON.stringify(
		{
			formatVersion: 1,
			name: 'Amsterdam 1625',
			updatedAt: '2025-03-04T11:22:33.000Z',
			layers: [
				{
					id: 'l1',
					name: 'The 1625 plan',
					visible: true,
					order: 0,
					kind: 'map',
					opacity: 0.8,
					alignmentRef: 'alignments/amsterdam-1625.json',
					imageMode: 'mirrored'
				},
				{
					id: 'l2',
					name: 'Warehouses',
					visible: true,
					order: 1,
					kind: 'annotation',
					geojsonRef: 'annotations/warehouses.geojson',
					defaultStyle: {}
				}
			],
			baseMap: 'protomaps-light',
			...overrides
		},
		null,
		'\t'
	)}\n`;

/** The files of a Project that is a bit more than a manifest: an Alignment, GeoJSON, a pyramid. */
const projectFiles = (): Record<string, string> => ({
	'project.json': projectJson(),
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'not really a jpeg, but bytes',
	'images/amsterdam-1625/256,0,256,256/256,256/0/default.jpg': 'nor is this one'
});

async function seed(
	store: MemoryProjectStore,
	directory: string,
	files: Record<string, string>
): Promise<void> {
	for (const [path, text] of Object.entries(files)) {
		await store.write(`${directory}/${path}` as StorePath, encode(text));
	}
}

/** Everything under a prefix as text, keyed by the path relative to it. */
async function contents(
	store: MemoryProjectStore,
	prefix: string
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const path of await store.list(prefix)) {
		out[path.slice(prefix.length)] = decode(await store.read(path));
	}
	return out;
}

const collect = async (body: ReadableStream<Uint8Array>): Promise<Bytes> => {
	const chunks: Uint8Array[] = [];
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const archive = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		archive.set(chunk, at);
		at += chunk.length;
	}
	return archive;
};

/** Export a Project and hand back the archive bytes. */
async function exportArchive(store: MemoryProjectStore, directory: string): Promise<Bytes> {
	const { body } = await exportProjectZip(store, directory);
	return collect(body);
}

/** A zip built by something other than us, so import is tested against arbitrary archives. */
const buildZip = (files: Record<string, string | Uint8Array>, level?: 0): Bytes => {
	const zippable: Zippable = {};
	for (const [name, content] of Object.entries(files)) {
		zippable[name] = typeof content === 'string' ? encode(content) : content;
	}
	return zipSync(zippable, level === 0 ? { level: 0 } : undefined);
};

// A zip's central directory is the index an importer reads before it inflates anything, and it is
// the part an attacker or a damaged sync rewrites: every field below — declared uncompressed size,
// declared compressed size, checksum — is a claim the archive makes about itself. These two helpers
// let a test rewrite one of those claims and leave everything else intact, which is the only way to
// assert that import checks them rather than trusting them.

const read32 = (bytes: Uint8Array, at: number): number =>
	((bytes[at] as number) |
		((bytes[at + 1] as number) << 8) |
		((bytes[at + 2] as number) << 16) |
		((bytes[at + 3] as number) << 24)) >>>
	0;

const write32 = (bytes: Uint8Array, at: number, value: number): void => {
	bytes[at] = value & 0xff;
	bytes[at + 1] = (value >>> 8) & 0xff;
	bytes[at + 2] = (value >>> 16) & 0xff;
	bytes[at + 3] = (value >>> 24) & 0xff;
};

/** The offset of `name`'s central-directory record. */
function centralRecord(archive: Uint8Array, name: string): number {
	let end = archive.length - 22;
	while (read32(archive, end) !== 0x06054b50) end -= 1;
	let at = read32(archive, end + 16);
	for (;;) {
		const nameLength = (archive[at + 28] as number) | ((archive[at + 29] as number) << 8);
		const extraLength = (archive[at + 30] as number) | ((archive[at + 31] as number) << 8);
		const commentLength = (archive[at + 32] as number) | ((archive[at + 33] as number) << 8);
		const found = decode(archive.subarray(at + 46, at + 46 + nameLength));
		if (found === name) return at;
		at += 46 + nameLength + extraLength + commentLength;
	}
}

/** A copy of `archive` with one of `name`'s central-directory fields rewritten. */
const patchCentralDirectory = (
	archive: Bytes,
	name: string,
	field: 'crc' | 'compressedSize' | 'uncompressedSize',
	value: number
): Bytes => {
	const patched = new Uint8Array(archive) as Bytes;
	const at = centralRecord(patched, name);
	write32(patched, at + { crc: 16, compressedSize: 20, uncompressedSize: 24 }[field], value);
	return patched;
};

describe('exporting a Project as a zip', () => {
	let store: MemoryProjectStore;

	beforeEach(async () => {
		store = new MemoryProjectStore();
		await seed(store, 'amsterdam-1625', projectFiles());
		// A second Project, so "export one Project" is a claim and not a coincidence.
		await seed(store, 'boston-1775', { 'project.json': projectJson({ name: 'Boston 1775' }) });
	});

	it('is named for the Project directory and rooted there, not at the Workspace', async () => {
		const exported = await exportProjectZip(store, 'amsterdam-1625');

		expect(exported.fileName).toBe('amsterdam-1625.zip');
		const zip = await readProjectZip(await collect(exported.body));
		// Relative to the Project directory: `project.json` at the root, no `amsterdam-1625/` prefix,
		// and nothing at all from the other Project.
		expect([...zip.paths].sort()).toEqual(Object.keys(projectFiles()).sort());
	});

	it('refuses a directory that holds no Project rather than exporting an empty zip', async () => {
		await expect(exportProjectZip(store, 'not-a-project')).rejects.toThrow(
			'Nothing is stored at not-a-project/project.json'
		);
	});

	it('reports progress that reaches the totals it announced up front', async () => {
		const seen: TransferProgress[] = [];
		const exported = await exportProjectZip(store, 'amsterdam-1625', {
			onProgress: (progress) => seen.push(progress)
		});
		await collect(exported.body);

		expect(exported.totalFiles).toBe(6);
		expect(exported.totalBytes).toBeGreaterThan(0);
		expect(seen[0]).toEqual({
			files: 0,
			totalFiles: 6,
			bytes: 0,
			totalBytes: exported.totalBytes,
			path: null
		});
		expect(seen.at(-1)).toEqual({
			files: 6,
			totalFiles: 6,
			bytes: exported.totalBytes,
			totalBytes: exported.totalBytes,
			path: null
		});
		// Every file named, once, and the counts only ever go up.
		expect(seen.map((p) => p.path).filter((path) => path !== null)).toHaveLength(6);
		expect(seen.map((p) => p.files)).toEqual([...seen.map((p) => p.files)].sort((a, b) => a - b));
	});

	it('does not hold the whole archive in memory: bytes leave before the last file is read', async () => {
		// The claim in the acceptance criteria is about memory, and memory is not directly
		// assertable — but its cause is. If the archive were assembled first and streamed second,
		// every read would precede every chunk. Interleaving is the observable form of "one file at
		// a time", and it is also what makes backpressure real: `pull` is what triggers the next read.
		const log: string[] = [];
		const watched = new (class extends MemoryProjectStore {
			override async read(path: StorePath): Promise<Bytes> {
				log.push(`read ${path}`);
				return super.read(path);
			}
		})();
		await seed(watched, 'amsterdam-1625', projectFiles());

		const { body } = await exportProjectZip(watched, 'amsterdam-1625');
		const reader = body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			log.push(`chunk ${value.length}`);
		}

		const firstChunk = log.findIndex((line) => line.startsWith('chunk'));
		const lastRead = log.findLastIndex((line) => line.startsWith('read'));
		expect(firstChunk).toBeGreaterThanOrEqual(0);
		expect(firstChunk).toBeLessThan(lastRead);
		// And only one file has been read by the time the first bytes are out.
		expect(log.slice(0, firstChunk).filter((line) => line.startsWith('read'))).toHaveLength(1);
	});

	it('excludes whatever is on the viewer-file list', async () => {
		await seed(store, 'amsterdam-1625', {
			'index.html': '<!doctype html>',
			'_app/immutable/entry/start.js': 'export {}'
		});

		const { body } = await exportProjectZip(store, 'amsterdam-1625', {
			// Ticket 16 populates `VIEWER_FILE_PATHS`; the mechanism is what exists now, so it is
			// exercised with the shape of list ticket 16 will record.
			excluded: createViewerFileFilter(['index.html', '_app/'])
		});

		const zip = await readProjectZip(await collect(body));
		expect(zip.paths).not.toContain('index.html');
		expect(zip.paths.filter((path) => path.startsWith('_app/'))).toEqual([]);
		expect(zip.paths).toContain('annotations/warehouses.geojson');
	});

	it('refuses a Project with more files than a zip can index, rather than losing most of them', async () => {
		// A zip's entry count is a sixteen-bit field, and going past it needs the zip64 records fflate's
		// writer does not emit. Measured: exporting 70,000 entries produces an archive whose index
		// claims 70000 & 0xffff = 4,464 of them, and unzipping it — with fflate or anything else —
		// returns 4,464 files with no error anywhere. Silent, on the only way out for a Firefox, Safari,
		// or iPad user (ADR-0001) and on the deposit path (SPEC story 94), so a legible refusal is the
		// only honest answer until the archive can be written as zip64.
		//
		// SPEC puts "tens of thousands of files" on a single 2 GB pyramid, so this is reachable by a
		// Project with a few large archival scans in it, not only by a pathological one.
		const many: Record<string, string> = { 'project.json': projectJson() };
		for (let tile = 0; tile <= MAX_ZIP_ENTRIES; tile += 1) {
			many[`images/amsterdam-1625/${tile}/default.jpg`] = 't';
		}
		many['images/amsterdam-1625/info.json'] = '{}';
		const crowded = new MemoryProjectStore();
		await seed(crowded, 'amsterdam-1625', many);

		await expect(exportProjectZip(crowded, 'amsterdam-1625')).rejects.toThrow(
			/too many files|65,?535/
		);
	});

	it('leaves the Project untouched, including one from a newer version of the app', async () => {
		// The Project a user most needs to get out of a browser they cannot see into is the one this
		// build refuses to open, so export must not parse `project.json` at all (ADR-0010).
		await seed(store, 'from-the-future', {
			'project.json': projectJson({ formatVersion: 99 })
		});
		const before = await contents(store, 'from-the-future/');

		const archive = await exportArchive(store, 'from-the-future');

		expect(archive.length).toBeGreaterThan(0);
		expect(await contents(store, 'from-the-future/')).toEqual(before);
	});
});

describe('a round trip through export and import', () => {
	let source: MemoryProjectStore;
	let destination: MemoryProjectStore;
	let target: Workspace;

	beforeEach(async () => {
		source = new MemoryProjectStore();
		await seed(source, 'amsterdam-1625', projectFiles());
		destination = new MemoryProjectStore();
		// A different Workspace with a different clock, which is what makes the `updatedAt`
		// assertion below mean something.
		target = new Workspace(destination, { now: () => new Date('2030-12-25T00:00:00.000Z') });
	});

	it('reproduces every file byte for byte in the new Workspace', async () => {
		const zip = await readProjectZip(await exportArchive(source, 'amsterdam-1625'));
		const imported = await target.importProject('amsterdam-1625', zip);

		expect(imported).toEqual({
			directory: 'amsterdam-1625',
			name: 'Amsterdam 1625',
			updatedAt: '2025-03-04T11:22:33.000Z',
			problem: null
		});
		// Byte identity, every file, not "the Layers look the same": the Alignment and the GeoJSON are
		// the portable scholarship (ADR-0002) and the pyramid is what the reader actually sees.
		expect(await contents(destination, 'amsterdam-1625/')).toEqual(projectFiles());
	});

	it('keeps updatedAt, which is the only record of it that survives a zip', async () => {
		// `updatedAt` lives inside `project.json` rather than being taken from the file's
		// modification time precisely because zipping and unzipping destroy those. If import stamped
		// its own clock — as every other write in the Workspace does — a Project handed to a
		// colleague would claim to have been last touched the moment they received it, and the hub
		// sorts on this field.
		const zip = await readProjectZip(await exportArchive(source, 'amsterdam-1625'));
		await target.importProject('amsterdam-1625', zip);

		expect(await target.readProject('amsterdam-1625')).toMatchObject({
			updatedAt: '2025-03-04T11:22:33.000Z'
		});
		expect(decode(await destination.read('amsterdam-1625/project.json'))).toBe(projectJson());
	});

	it('is still identical after a second export and import', async () => {
		const first = await exportArchive(source, 'amsterdam-1625');
		await target.importProject('amsterdam-1625', await readProjectZip(first));

		const second = await exportArchive(destination, 'amsterdam-1625');
		const third = new MemoryProjectStore();
		await new Workspace(third).importProject('amsterdam-1625', await readProjectZip(second));

		expect(await contents(third, 'amsterdam-1625/')).toEqual(projectFiles());
		// And the archives themselves match. Nothing requires that — ADR-0006's format claim is about
		// the files, and the ticket asks only for semantic equivalence — but it holds because every
		// entry carries a fixed timestamp, and it is the strongest available statement that the round
		// trip adds and loses nothing at all.
		//
		// **If only this line fails after a dependency bump, read it as a change in fflate rather than
		// as a regression here.** Byte identity additionally depends on fflate's deflate producing the
		// same output for the same input, which nothing promises: `fflate` is `^0.8.3` in the catalog,
		// and CONTRIBUTING pins only `@allmaps/*` exactly. The assertion above it — that the files come
		// back identical — is the one the ticket actually asks for and is unaffected by deflate output.
		expect([...second]).toEqual([...first]);
	});

	it('does not touch a Project that is already in the destination Workspace', async () => {
		await seed(destination, 'boston-1775', {
			'project.json': projectJson({ name: 'Boston 1775' })
		});
		const untouched = await contents(destination, 'boston-1775/');

		const zip = await readProjectZip(await exportArchive(source, 'amsterdam-1625'));
		await target.importProject('amsterdam-1625', zip);

		expect(await contents(destination, 'boston-1775/')).toEqual(untouched);
	});

	it('reports progress up to the totals it announced', async () => {
		const zip = await readProjectZip(await exportArchive(source, 'amsterdam-1625'));
		const seen: TransferProgress[] = [];

		await target.importProject('amsterdam-1625', zip, {
			onProgress: (progress) => seen.push(progress)
		});

		expect(seen[0]).toMatchObject({ files: 0, totalFiles: 6, path: null });
		expect(seen.at(-1)).toMatchObject({ files: 6, totalFiles: 6, path: null });
		expect(seen.at(-1)?.bytes).toBe(zip.totalBytes);
	});

	it('undoes what it wrote when a write fails part way through', async () => {
		// A closed laptop, a full disk, a lapsed folder grant. Without a rollback the leftover files
		// are invisible — `project.json` is written last, so the hub does not list the directory — and
		// the name is taken forever: retrying the same zip meets "this Workspace already has a folder
		// called amsterdam-1625" while the user looks at a hub listing no such Project.
		const failing = new (class extends MemoryProjectStore {
			override async write(path: StorePath, bytes: Bytes): Promise<void> {
				if (path.endsWith('/info.json')) throw new Error('the disk is full');
				return super.write(path, bytes);
			}
		})();
		const workspace = new Workspace(failing);
		const zip = await readProjectZip(await exportArchive(source, 'amsterdam-1625'));

		await expect(workspace.importProject('amsterdam-1625', zip)).rejects.toThrow(
			'the disk is full'
		);

		expect(await failing.list('')).toEqual([]);
		// Not merely absent from `list`: nothing at all, including the temporary files a failed write
		// leaves behind, which `list` hides and only `reclaimAbandonedWrites` can reach.
		expect([...failing.snapshot().keys()]).toEqual([]);
		// And so the name is free again, which is the whole point: the user can fix the disk and retry.
		await expect(workspace.suggestDirectory('amsterdam-1625')).resolves.toBe('amsterdam-1625');
	});

	it('writes project.json last, so an interrupted import is not a listed Project', async () => {
		// The Workspace's Project list *is* whichever directories hold a `project.json` (ADR-0008).
		// Written first, a half-finished import would appear on the hub and open with its Layers
		// pointing at files that are not there yet.
		const zip = await readProjectZip(await exportArchive(source, 'amsterdam-1625'));

		expect(zip.paths.at(-1)).toBe('project.json');
	});
});

describe('importing into a directory name that is taken (SPEC story 14)', () => {
	let destination: MemoryProjectStore;
	let target: Workspace;
	let archive: Bytes;

	beforeEach(async () => {
		const source = new MemoryProjectStore();
		await seed(source, 'amsterdam-1625', projectFiles());
		archive = await exportArchive(source, 'amsterdam-1625');

		destination = new MemoryProjectStore();
		target = new Workspace(destination);
	});

	it('refuses, offers a free name, and writes nothing', async () => {
		await seed(destination, 'amsterdam-1625', {
			'project.json': projectJson({ name: 'My own Amsterdam' }),
			'annotations/mine.geojson': '{"type":"FeatureCollection","features":["mine"]}'
		});
		const before = await contents(destination, 'amsterdam-1625/');
		const zip = await readProjectZip(archive);

		const failure = await target.importProject('amsterdam-1625', zip).catch((cause) => cause);

		expect(failure).toBeInstanceOf(ProjectDirectoryCollisionError);
		expect(failure.suggestion).toBe('amsterdam-1625-2');
		expect(failure.message).toContain('or cancel');
		// Not one byte of the Project that was already there, and no partial directory beside it.
		expect(await contents(destination, 'amsterdam-1625/')).toEqual(before);
		expect(await destination.list('')).toEqual([
			'amsterdam-1625/annotations/mine.geojson',
			'amsterdam-1625/project.json'
		]);
	});

	it('collides on any existing top-level name, not only on another Project', async () => {
		// A directory that is there for some other reason is still a name the import cannot have.
		await destination.write('amsterdam-1625/stray.txt', encode('not a Project'));

		await expect(
			target.importProject('amsterdam-1625', await readProjectZip(archive))
		).rejects.toBeInstanceOf(ProjectDirectoryCollisionError);
	});

	it('imports under the offered name, leaving the existing Project alone', async () => {
		await seed(destination, 'amsterdam-1625', {
			'project.json': projectJson({ name: 'My own Amsterdam' })
		});
		const mine = await contents(destination, 'amsterdam-1625/');
		const zip = await readProjectZip(archive);

		const suggestion = await target.suggestDirectory('amsterdam-1625');
		const imported = await target.importProject(suggestion, zip);

		expect(imported.directory).toBe('amsterdam-1625-2');
		expect(await contents(destination, 'amsterdam-1625/')).toEqual(mine);
		expect(await contents(destination, 'amsterdam-1625-2/')).toEqual(projectFiles());
		// Two Projects, both listed, identity carried by the directory (ADR-0008).
		expect((await target.listProjects()).map((p) => `${p.directory}: ${p.name}`)).toEqual([
			'amsterdam-1625: My own Amsterdam',
			'amsterdam-1625-2: Amsterdam 1625'
		]);
	});

	it('does not block on a display name that is already in use', async () => {
		// Identity is the directory, never the display name (ADR-0008). A colleague's "Amsterdam
		// 1625" must arrive alongside the user's own Project of the same name.
		await seed(destination, 'my-amsterdam', { 'project.json': projectJson() });

		const imported = await target.importProject('amsterdam-1625', await readProjectZip(archive));

		expect(imported.name).toBe('Amsterdam 1625');
		expect((await target.listProjects()).map((p) => p.name)).toEqual([
			'Amsterdam 1625',
			'Amsterdam 1625'
		]);
	});

	it.each([
		['a different case', 'amsterdam-1625', 'Amsterdam-1625'],
		['a decomposed accent', 'amsterdam-café', 'amsterdam-café'],
		['a precomposed accent', 'amsterdam-café', 'amsterdam-café']
	])(
		'reports the collision when the name differs only by %s (SPEC story 14)',
		async (_how, existing, typed) => {
			// The collision test was an exact string match, and the rename field handed it whatever the
			// user typed. On macOS/APFS and on Windows the filesystem is case-insensitive — and APFS
			// folds Unicode — so `getDirectoryHandle(typed, { create: true })` resolves to the directory
			// that is already there. No collision was reported, and `project.json`, the GeoJSON, and
			// every same-named tile of the user's own Project were overwritten with the colleague's:
			// story 14's forbidden outcome, reached through the affordance built to prevent it.
			await seed(destination, existing, {
				'project.json': projectJson({ name: 'My own Amsterdam' }),
				'annotations/mine.geojson': '{"type":"FeatureCollection","features":["mine"]}'
			});
			const mine = await contents(destination, `${existing}/`);

			const failure = await target
				.importProject(typed, await readProjectZip(archive))
				.catch((c) => c);

			expect(failure).toBeInstanceOf(ProjectDirectoryCollisionError);
			// And the free name it offers is genuinely free, not another spelling of the taken one.
			expect(failure.suggestion).not.toBe(typed);
			expect(await contents(destination, `${existing}/`)).toEqual(mine);
		}
	);

	it.each([
		['a nested name', 'nested/name'],
		['nothing at all', ''],
		['a parent traversal', '..'],
		['a current directory', '.'],
		['a backslash separator', 'amsterdam\\1625']
	])('refuses %s as a directory name, naming what the user gave it', async (_how, directory) => {
		// Checked against the name itself rather than left to `assertStorePath`, which sees each path
		// only as it is written. Left to the store, `..` and `\` failed on the *first entry inside* the
		// Project — so the complaint named `../alignments/amsterdam-1625.json`, a file the user has
		// never heard of, about a folder name they typed. It also failed after that entry had landed,
		// which the rollback now undoes but should not have to.
		const zip = await readProjectZip(archive);

		const failure = await target.importProject(directory, zip).catch((c) => c);

		expect(failure).toBeInstanceOf(InvalidPathError);
		expect(failure.path).toBe(directory);
		expect(await destination.list('')).toEqual([]);
	});
});

describe('rejecting a zip before writing anything', () => {
	let destination: MemoryProjectStore;
	let target: Workspace;

	/**
	 * The whole import, exactly as the app performs it: validate, then write.
	 *
	 * Every case below goes through this rather than calling `readProjectZip` alone, because the
	 * claim being tested is "nothing was written", and a test that never offers the implementation a
	 * store would pass just as happily against one that writes first and complains afterwards.
	 */
	const attemptImport = (
		archive: Bytes,
		directory = 'amsterdam-1625',
		options?: ReadProjectZipOptions
	) => readProjectZip(archive, options).then((zip) => target.importProject(directory, zip));

	/** Every rejection has to leave the Workspace exactly as it was, so each case asserts this. */
	const nothingWritten = async () => expect(await destination.list('')).toEqual([]);

	beforeEach(() => {
		destination = new MemoryProjectStore();
		target = new Workspace(destination);
	});

	it('rejects bytes that are not a zip at all', async () => {
		const failure = await attemptImport(encode('this is a JPEG, honestly')).catch((c) => c);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.reason).toBe('not-a-zip');
		expect(failure.message).toContain('Nothing has been imported.');
		await nothingWritten();
	});

	it('rejects a zip with no project.json, naming what a Project zip looks like', async () => {
		const failure = await attemptImport(buildZip({ 'annotations/warehouses.geojson': '{}' })).catch(
			(c) => c
		);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.reason).toBe('no-project-file');
		expect(failure.message).toContain('no project.json at its root');
		await nothingWritten();
	});

	it('rejects a project.json that is not parseable, saying so specifically', async () => {
		const failure = await attemptImport(buildZip({ 'project.json': '{ not json' })).catch((c) => c);

		expect(failure).toBeInstanceOf(ProjectFileUnreadableError);
		expect(failure.message).toContain("This Project's project.json could not be read");
		await nothingWritten();
	});

	it('rejects a project.json nested under a directory rather than at the root', async () => {
		// A zip of the Workspace, or one made by dragging the folder in a file manager that adds a
		// wrapping directory. It is not a Project zip, and saying so is better than importing a
		// Project whose every path is one level deeper than it should be.
		const failure = await attemptImport(
			buildZip({ 'amsterdam-1625/project.json': projectJson() })
		).catch((c) => c);

		expect(failure.reason).toBe('no-project-file');
		await nothingWritten();
	});

	it('refuses a formatVersion from the future, naming the remedy (ADR-0010)', async () => {
		// The refusal a user is most likely to meet through import rather than in their own
		// Workspace, since a zip is how a Project from a newer build reaches an older one at all.
		const failure = await attemptImport(
			buildZip({ 'project.json': projectJson({ formatVersion: 2 }) })
		).catch((c) => c);

		expect(failure).toBeInstanceOf(ProjectFormatTooNewError);
		expect(failure.message).toContain('newer version of Ballastella');
		expect(failure.message).toContain('update your copy');
		expect(failure.message).toContain('https://');
		// Ends the way every other refusal on this path ends. "It has been left untouched" is the right
		// reassurance for a Project sitting in the Workspace and the wrong one here, where the thing the
		// reader needs to know is that nothing arrived.
		expect(failure.message).toContain('Nothing has been imported.');
		expect(failure.message).not.toContain('left untouched');
		await nothingWritten();
	});

	it('rejects a missing geojsonRef, naming the file that is not there', async () => {
		const files = projectFiles();
		delete files['annotations/warehouses.geojson'];

		const failure = await attemptImport(buildZip(files)).catch((c) => c);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.reason).toBe('missing-reference');
		expect(failure.message).toContain('annotations/warehouses.geojson');
		await nothingWritten();
	});

	it('rejects a missing alignmentRef, naming the file that is not there', async () => {
		const files = projectFiles();
		delete files['alignments/amsterdam-1625.json'];

		const failure = await attemptImport(buildZip(files)).catch((c) => c);

		expect(failure.reason).toBe('missing-reference');
		expect(failure.message).toContain('alignments/amsterdam-1625.json');
		await nothingWritten();
	});

	it('rejects an image directory with no info.json, naming it', async () => {
		const files = projectFiles();
		delete files['images/amsterdam-1625/info.json'];

		const failure = await attemptImport(buildZip(files)).catch((c) => c);

		expect(failure.reason).toBe('missing-reference');
		expect(failure.message).toContain('images/amsterdam-1625/info.json');
		await nothingWritten();
	});

	// The case the structural check above cannot see, and the one that actually loses a reader's
	// map: not an incomplete pyramid but a Layer pointing at an image directory the archive does not
	// carry at all. Followed from `alignmentRef`, because that is where an Alignment's identity
	// lives — **no Annotation is opened to find it** (see `layerReferences`).
	it('rejects a map Layer whose image the zip does not carry at all, naming it', async () => {
		const files = projectFiles();
		for (const path of Object.keys(files)) if (path.startsWith('images/')) delete files[path];

		const failure = await attemptImport(buildZip(files)).catch((c) => c);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.reason).toBe('missing-reference');
		expect(failure.message).toContain('images/amsterdam-1625/info.json');
		// Named by the Layer the reader would find blank, not only by the path.
		expect(failure.message).toContain('The 1625 plan');
		await nothingWritten();
	});

	// `imageMode` comes out of a `project.json` another person wrote, so it must not be able to waive
	// the image check. It used to: `mapLayerImageInfoPath` answers `null` for a `'referenced'` image —
	// correctly, its tiles are on somebody else's server (ADR-0007) — and on its own that let the author
	// of an archive decide the check did not apply to them. A zip with `project.json`, an Alignment, no
	// `images/` directory at all and one word changed imported cleanly and then drew nothing, because
	// the renderer never consults `imageMode` and asks for every map Layer's tiles out of `images/<id>/`.
	const referencedLayer = {
		id: 'l1',
		name: 'A map on somebody else’s server',
		visible: true,
		order: 0,
		kind: 'map',
		opacity: 1,
		alignmentRef: 'alignments/amsterdam-1625.json',
		imageMode: 'referenced'
	};

	it('rejects a referenced image whose directory the zip does not carry at all', async () => {
		const files = projectFiles();
		for (const path of Object.keys(files)) if (path.startsWith('images/')) delete files[path];
		files['project.json'] = projectJson({ layers: [referencedLayer] });

		const failure = await attemptImport(buildZip(files)).catch((c) => c);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.reason).toBe('missing-reference');
		expect(failure.message).toContain('images/amsterdam-1625/');
		// Named by the Layer the reader would find blank, not only by the path.
		expect(failure.message).toContain('A map on somebody else’s server');
		await nothingWritten();
	});

	// And the check is about presence rather than about the word: the same Layer with its image really
	// in the archive is accepted. *What* a referenced image keeps in that directory is ticket 14's
	// contract, which is why this asks for the directory and not for a named file.
	it('accepts a referenced image whose directory the zip does carry', async () => {
		const files = projectFiles();
		files['project.json'] = projectJson({ layers: [referencedLayer] });

		await expect(attemptImport(buildZip(files))).resolves.toMatchObject({
			directory: 'amsterdam-1625'
		});
	});

	// The honest limit of following the link by path. An `alignmentRef` that does not follow the
	// Alignment's own naming names no image id, so nothing local is claimed and nothing is looked
	// for — rather than a guess about which directory it meant.
	it('claims no image for an alignmentRef that names none', async () => {
		const files = projectFiles();
		for (const path of Object.keys(files)) if (path.startsWith('images/')) delete files[path];
		files['alignments/somewhere/else.json'] = '{"type":"Annotation"}';
		files['project.json'] = projectJson({
			layers: [
				{
					id: 'l1',
					name: 'Hand-wired',
					visible: true,
					order: 0,
					kind: 'map',
					opacity: 1,
					alignmentRef: 'alignments/somewhere/else.json',
					imageMode: 'mirrored'
				}
			]
		});

		await expect(attemptImport(buildZip(files))).resolves.toMatchObject({
			directory: 'amsterdam-1625'
		});
	});

	it('tolerates a Layer kind it has never heard of, so long as its references are there', async () => {
		// ADR-0014 expects a third Layer kind. An importer that only understood today's two would
		// refuse next year's Projects, which is the failure ADR-0010's version check exists to make
		// explicit rather than accidental.
		const zip = await readProjectZip(
			buildZip({
				...projectFiles(),
				'project.json': projectJson({
					layers: [
						{
							id: 'l3',
							name: 'The cartouche',
							visible: true,
							order: 0,
							kind: 'something-new',
							geojsonRef: 'annotations/warehouses.geojson'
						}
					]
				})
			})
		);

		await expect(target.importProject('amsterdam-1625', zip)).resolves.toMatchObject({
			directory: 'amsterdam-1625'
		});
	});

	// The reference names this application owns mean the same thing on a kind this build cannot
	// draw, so they are still checked — nothing else about such a Layer is interpreted.
	it('still checks the references a Layer of an unknown kind carries', async () => {
		const files = projectFiles();
		delete files['annotations/warehouses.geojson'];
		files['project.json'] = projectJson({
			layers: [
				{
					id: 'l3',
					name: 'The cartouche',
					visible: true,
					order: 0,
					kind: 'something-new',
					geojsonRef: 'annotations/warehouses.geojson'
				}
			]
		});

		const failure = await attemptImport(buildZip(files)).catch((c) => c);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.message).toContain('annotations/warehouses.geojson');
		await nothingWritten();
	});

	it.each([
		['../../etc/passwd', 'climbs out'],
		['alignments/../../escape.json', 'climbs out'],
		['/etc/passwd', 'absolute path'],
		['C:/Windows/system32/x', 'drive letter'],
		['alignments\\amsterdam.json', 'backslash'],
		['./project-notes.txt', '“.” segment'],
		['annotations//warehouses.geojson', 'empty path segment']
	])('rejects the entry %s and writes nothing', async (name, because) => {
		const failure = await attemptImport(buildZip({ ...projectFiles(), [name]: 'payload' })).catch(
			(c) => c
		);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.reason).toBe('path-traversal');
		expect(failure.message).toContain(because);
		// Not merely "an error was shown": the whole archive is refused, so the Project that would
		// otherwise have been perfectly importable is not on disk either.
		await nothingWritten();
	});

	it('rejects a traversal entry even when it is the only thing wrong', async () => {
		const failure = await attemptImport(
			buildZip({ 'project.json': projectJson({ layers: [] }), '../outside.txt': 'x' })
		).catch((c) => c);

		expect(failure.reason).toBe('path-traversal');
		await nothingWritten();
	});

	it.each([
		['sneaky.ballastella-tmp', "the store's reserved suffix"],
		['sneaky.ballastella-tmp.crswap', "Chromium's swap file for one"]
	])('refuses %s, which the store would hide rather than store', async (name) => {
		// The store refuses the reserved suffix, but at the moment of *writing* — which on an import
		// means after the entries that sort before it have landed. So this has to be a validation
		// refusal like any other traversal: a zip is another person's file, and the alternative is a
		// directory holding five of six files, invisible on the hub because `project.json` is written
		// last, and holding the name for good.
		const failure = await attemptImport(buildZip({ ...projectFiles(), [name]: 'x' })).catch(
			(c) => c
		);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.reason).toBe('path-traversal');
		expect(failure.message).toContain(name);
		// The assertion the previous version of this test was missing, which is why it passed against
		// exactly the behaviour its own comment forbids.
		await nothingWritten();
		expect((await target.listProjects()).map((p) => p.directory)).toEqual([]);
	});

	it('refuses an archive that declares more bytes than a Project could hold', async () => {
		// Deflate reaches nearly 1000:1 on runs of zeros — a megabyte of them compresses to about a
		// kilobyte, measured — so a ten-megabyte archive can declare ten gigabytes. Nothing bounded the
		// declared total, and `importProject` wrote every byte of it: on OPFS the quota eventually
		// throws part way through, and on ticket 12's File System Access backend there is no quota at
		// all, so a zip a student was handed fills the disk from a folder granted for one purpose.
		// Seventeen tiles each declaring just under the per-entry bound: no single entry is out of
		// order, and together they claim more than four gigabytes. That is the shape of the attack —
		// the total is what a disk runs out of, and nothing was summing it.
		const tiles: Record<string, string> = { ...projectFiles() };
		const claimed = PROJECT_ZIP_LIMITS.entryBytes - 1;
		const names: string[] = [];
		for (let tile = 0; tile < 17; tile += 1) {
			const name = `images/amsterdam-1625/${tile},0,256,256/256,256/0/default.jpg`;
			tiles[name] = 'a tile';
			names.push(name);
		}
		let archive = buildZip(tiles);
		for (const name of names) {
			archive = patchCentralDirectory(archive, name, 'uncompressedSize', claimed);
		}

		const failure = await attemptImport(archive).catch((c) => c);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.reason).toBe('too-large');
		// The message has to say what is wrong and what the number is, not merely "too large".
		expect(failure.message).toMatch(/gigabyte|GB/i);
		expect(failure.message).toContain('Nothing has been imported.');
		await nothingWritten();
	});

	it('refuses a single entry that declares more bytes than any Project file has', async () => {
		// This is the allocation, not only the disk: fflate builds the output buffer from the declared
		// size, so a forty-kilobyte archive whose one entry claims four gigabytes asks the browser for
		// four gigabytes. The bound is what makes the "one batch" memory claim true for a hostile
		// archive as well as an honest one.
		const archive = patchCentralDirectory(
			buildZip(projectFiles()),
			'annotations/warehouses.geojson',
			'uncompressedSize',
			PROJECT_ZIP_LIMITS.entryBytes + 1
		);

		const failure = await attemptImport(archive).catch((c) => c);

		expect(failure.reason).toBe('too-large');
		expect(failure.message).toContain('annotations/warehouses.geojson');
		await nothingWritten();
	});

	it('refuses an archive with more entries than it will accept', async () => {
		// The count is checked before the entries are walked, so an archive claiming millions of them
		// costs one comparison rather than a million.
		const failure = await attemptImport(buildZip(projectFiles()), 'amsterdam-1625', {
			limits: { entries: 3 }
		}).catch((c) => c);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.reason).toBe('too-large');
		expect(failure.message).toContain('3');
		await nothingWritten();
	});

	it('accepts an archive inside every bound, so the bounds are not simply refusing everything', async () => {
		await expect(
			attemptImport(buildZip(projectFiles()), 'amsterdam-1625', {
				limits: { entries: 6, entryBytes: 1024, totalBytes: 4096 }
			})
		).resolves.toMatchObject({ directory: 'amsterdam-1625' });
	});

	it('rejects a deflated entry whose bytes do not match the checksum the zip carries', async () => {
		// The archive claims this file is 100 bytes long when it is really 5000. Nothing in fflate
		// notices: the declared size becomes the output buffer, the buffer is not resized because the
		// caller supplied it, and what comes back is the first 100 bytes with no error at all. So the
		// length of what was inflated is exactly what was declared, and a length check cannot see this
		// — only the CRC-32 the zip already carries can.
		const honest = buildZip({
			...projectFiles(),
			'annotations/warehouses.geojson': `{"type":"FeatureCollection","features":[${'0,'.repeat(2500)}0]}`
		});
		const damaged = patchCentralDirectory(
			honest,
			'annotations/warehouses.geojson',
			'uncompressedSize',
			100
		);

		const failure = await attemptImport(damaged).catch((c) => c);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.reason).toBe('damaged-entry');
		expect(failure.message).toContain('annotations/warehouses.geojson');
		expect(failure.message).toContain('Nothing has been imported.');
		// The whole import fails and rolls back, so the user is not left with a Project whose GeoJSON
		// is the first hundred bytes of a file — unparseable, and nothing said.
		await nothingWritten();
	});

	it('rejects a stored entry whose bytes do not match the checksum, which tiles rely on', async () => {
		// Tiles are JPEG, so export stores them rather than deflating them (deflate saves nothing on
		// already-compressed bytes). A stored entry has no deflate stream to fail, which makes CRC-32
		// the *only* integrity check the zip format offers for the bulk of a real Project.
		const files = projectFiles();
		const archive = buildZip(files, 0);
		const tile = 'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg';
		const truncated = patchCentralDirectory(
			patchCentralDirectory(archive, tile, 'compressedSize', 5),
			tile,
			'uncompressedSize',
			5
		);

		const failure = await attemptImport(truncated).catch((c) => c);

		expect(failure.reason).toBe('damaged-entry');
		expect(failure.message).toContain(tile);
		await nothingWritten();
	});

	it('rejects a project.json whose checksum does not match, before parsing it', async () => {
		// `project.json` is the one file validation reads the contents of, so its checksum is verified
		// where it is inflated rather than being left to the write pass.
		const damaged = patchCentralDirectory(buildZip(projectFiles()), 'project.json', 'crc', 0);

		const failure = await attemptImport(damaged).catch((c) => c);

		expect(failure).toBeInstanceOf(ProjectZipRejectedError);
		expect(failure.reason).toBe('damaged-entry');
		expect(failure.message).toContain('project.json');
		await nothingWritten();
	});

	it('accepts an undamaged archive, so the checksum check is not simply refusing everything', async () => {
		// The counterpart every integrity check needs: proof that it passes on good bytes. Without it
		// a check that rejected unconditionally would satisfy all three tests above.
		await expect(attemptImport(buildZip(projectFiles()))).resolves.toMatchObject({
			directory: 'amsterdam-1625'
		});
		await expect(attemptImport(buildZip(projectFiles(), 0), 'stored')).resolves.toMatchObject({
			directory: 'stored'
		});
	});

	it('imports a zip whose annotation description carries an XSS payload, inert', async () => {
		// Ticket 10 owns the sanitising, and this is the reason it is required rather than
		// theoretical (ADR-0009): the `description` in this file was written by somebody else and
		// will be rendered on the user's own domain. What import owes is to treat the file as bytes —
		// never to parse, interpret, or re-serialise it — so the payload arrives byte-identical and
		// the decision about rendering it stays with the code that renders it.
		const payload =
			'{"type":"FeatureCollection","features":[{"type":"Feature","properties":' +
			'{"description":"<img src=x onerror=\\"window.pwned=1\\"><script>alert(1)</script>"},' +
			'"geometry":null}]}';
		const zip = await readProjectZip(
			buildZip({ ...projectFiles(), 'annotations/warehouses.geojson': payload })
		);

		await target.importProject('amsterdam-1625', zip);

		expect(decode(await destination.read('amsterdam-1625/annotations/warehouses.geojson'))).toBe(
			payload
		);
	});
});

describe('the viewer-file list (ADR-0006)', () => {
	it('is empty until ticket 16 writes the files it would name', async () => {
		const { VIEWER_FILE_PATHS, isViewerFile } = await import('./viewer-files.js');

		expect(VIEWER_FILE_PATHS).toEqual([]);
		expect(isViewerFile('project.json')).toBe(false);
	});

	it('matches an exact path and a whole directory, and nothing adjacent', async () => {
		const excluded = createViewerFileFilter(['index.html', '_app/', 'viewer.js']);

		expect(['index.html', '_app/immutable/x.js', 'viewer.js'].map(excluded)).toEqual([
			true,
			true,
			true
		]);
		expect(['index.html.bak', 'images/_app/x', 'my_app/x', 'project.json'].map(excluded)).toEqual([
			false,
			false,
			false,
			false
		]);
	});
});

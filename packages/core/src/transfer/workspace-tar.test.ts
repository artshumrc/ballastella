import { createTarPacker, packTar, unpackTar } from 'modern-tar';
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
import type { Bytes, StorePath } from '../store/project-store.js';
import { exportWorkspaceTar } from './export-workspace-tar.js';
import {
	restoreWorkspaceTar,
	type RestoreDestination,
	type WorkspaceRestore
} from './restore-workspace-tar.js';
import type { TransferProgress } from './transfer.js';
import { archivePathFor, BackupRejectedError, TAR_ENTRY_MTIME } from './workspace-tar.js';
import { createViewerFileFilter } from './viewer-files.js';

// CONTRIBUTING.md's Seam 1, for the same reason `project-zip.test.ts` is: "the archive holds exactly
// these entries" and "after restoring, the Workspace holds exactly these files" are not proxies for
// the behaviour, they *are* it. The in-memory ProjectStore stands in for nothing.
//
// The premise this suite is built on — that `modern-tar` really streams and really carries long and
// non-ASCII paths — is measured separately in `tar-format.test.ts`, which imports nothing from this
// package. Keep the two apart: that file is about the library, this one is about us.

const encode = (text: string): Bytes => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const projectJson = (overrides: Record<string, unknown> = {}): string =>
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
					imageId: 'amsterdam-1625'
				}
			],
			baseMap: 'protomaps-light',
			...overrides
		},
		null,
		'\t'
	)}\n`;

/**
 * A Workspace with **two Projects sharing one Map Image**, which is the shape ADR-0023 made
 * possible: one map prepared and aligned once, used by any number of Projects.
 */
const twoProjectsOneMap = (): Record<string, string> => ({
	'amsterdam-1625/project.json': projectJson({ name: 'Amsterdam 1625' }),
	'amsterdam-1625/annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	'the-canal-ring/project.json': projectJson({ name: 'The Canal Ring' }),
	'the-canal-ring/annotations/bridges.geojson': '{"type":"FeatureCollection","features":[]}',
	// Shared, at the Workspace root, referenced by both Projects' map Layers.
	// alignment-write-is-the-fixture: the Alignment already on disk that a backup has to carry out and bring back verbatim; nothing here writes one through the app
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'not really a jpeg, but bytes',
	'images/amsterdam-1625/256,0,256,256/256,256/0/default.jpg': 'nor is this one'
});

function seed(files: Record<string, string>): MemoryProjectStore {
	const store = new MemoryProjectStore();
	for (const [path, content] of Object.entries(files)) {
		store.plant(path as StorePath, encode(content));
	}
	return store;
}

/** Everything in a store, as plain strings, for whole-Workspace equality assertions. */
function contents(store: MemoryProjectStore): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, bytes] of store.snapshot()) out[path] = decode(bytes);
	return out;
}

async function archiveOf(
	store: MemoryProjectStore,
	workspaceName: string,
	options?: Parameters<typeof exportWorkspaceTar>[2]
): Promise<Uint8Array<ArrayBuffer>> {
	const backup = await exportWorkspaceTar(store, workspaceName, options);
	return collect(backup.body);
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const out = new Uint8Array(new ArrayBuffer(chunks.reduce((n, c) => n + c.length, 0)));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

// `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, matching the store's own `Bytes`: a
// `Blob` will not take a view that might be over a `SharedArrayBuffer`, and neither will the store.
const streamOf = (bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> =>
	new Blob([bytes]).stream();

/**
 * A destination that records whether it was discarded.
 *
 * `discarded` is asserted rather than inferred from the store being empty, because "the Workspace was
 * thrown away" and "nothing was written into it" are different claims and only the first one makes
 * the refusals' closing sentence true.
 */
function destination(name = 'Restored'): {
	open: (preferred: string) => Promise<RestoreDestination>;
	store: MemoryProjectStore;
	asked: string[];
	discarded: () => boolean;
} {
	const store = new MemoryProjectStore();
	const asked: string[] = [];
	let discarded = false;
	return {
		store,
		asked,
		discarded: () => discarded,
		open: async (preferred: string) => {
			asked.push(preferred);
			return {
				name,
				store,
				discard: async () => {
					discarded = true;
					for (const path of await store.list('')) await store.delete(path);
				}
			};
		}
	};
}

describe('a Workspace backs up to one tar', () => {
	it('carries two Projects and the Map Image they share', async () => {
		const store = seed(twoProjectsOneMap());
		const backup = await exportWorkspaceTar(store, 'Marking 2026');

		expect(backup.fileName).toBe('Marking 2026.tar');
		expect(backup.totalFiles).toBe(8);

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
	});

	it('leaves out the published viewer files', async () => {
		// ADR-0006's staleness warning: a restored viewer bundle may be older than the app it lands
		// beside.
		const store = seed({
			...twoProjectsOneMap(),
			'index.html': '<!doctype html>',
			'robots.txt': 'User-agent: *',
			'ballastella-site.json': '{"projects":[]}',
			'_app/immutable/chunks/abc123.js': 'export{}',
			'base-map/tiles/protomaps/0/0/0.mvt': 'tile bytes'
		});

		const names = (await unpackTar(await archiveOf(store, 'W'), { strict: true })).map(
			(entry) => entry.header.name
		);

		expect(names).not.toContain('W/index.html');
		expect(names).not.toContain('W/ballastella-site.json');
		expect(names.filter((name) => name.startsWith('W/_app/'))).toEqual([]);
		expect(names.filter((name) => name.startsWith('W/base-map/'))).toEqual([]);
		expect(names).not.toContain('W/robots.txt');
		// And the user's own work is still all there — an exclusion that took the Workspace with it
		// would pass every assertion above.
		//
		// Composed through `archivePathFor` and `imageInfoPath` rather than written as a literal. Two
		// reasons, and the second is the one that matters: a hand-written `W/images/<id>/info.json`
		// reads exactly like the Project-rooted path ADR-0023 forbids — `check-workspace-rooted-paths`
		// flagged this very line — and the shape is only legitimate here because `W` is the
		// *Workspace's* name rather than a Project directory. Saying that in code rather than in a
		// pragma also means the assertion cannot drift from what the exporter actually composes.
		expect(names).toContain(archivePathFor('W', 'amsterdam-1625/project.json'));
		expect(names).toContain(archivePathFor('W', imageInfoPath('amsterdam-1625')));
	});

	it('applies whatever exclusion it is given, rather than a hard-coded list', async () => {
		const store = seed({ 'a/project.json': '{}', 'keep-me.txt': 'x', 'drop-me.txt': 'y' });
		const names = (
			await unpackTar(
				await archiveOf(store, 'W', { excluded: createViewerFileFilter(['drop-me.txt']) }),
				{ strict: true }
			)
		).map((entry) => entry.header.name);

		expect(names).toContain('W/keep-me.txt');
		expect(names).not.toContain('W/drop-me.txt');
	});

	it('holds an empty Workspace’s name, and nothing else', async () => {
		// Otherwise an empty backup carries no entries at all, and restore could only guess the name.
		const entries = await unpackTar(await archiveOf(new MemoryProjectStore(), 'Empty'), {
			strict: true
		});
		expect(entries.map((entry) => entry.header.name)).toEqual(['Empty/']);
	});

	it('reports progress that reaches its totals', async () => {
		const store = seed(twoProjectsOneMap());
		const seen: TransferProgress[] = [];
		const backup = await exportWorkspaceTar(store, 'W', {
			onProgress: (progress) => seen.push(progress)
		});
		await collect(backup.body);

		expect(seen.at(-1)).toEqual({
			files: 8,
			totalFiles: 8,
			bytes: backup.totalBytes,
			totalBytes: backup.totalBytes,
			path: null
		});
	});
});

describe('a backup is byte-reproducible', () => {
	it('produces identical bytes for the same Workspace twice', async () => {
		const store = seed(twoProjectsOneMap());
		expect(await archiveOf(store, 'Marking 2026')).toEqual(await archiveOf(store, 'Marking 2026'));
	});

	it('produces identical bytes after a round trip through restore', async () => {
		// The strongest form of "lossless": not that the files match, but that re-exporting the
		// restored Workspace under the same name gives back the same archive, byte for byte.
		const store = seed(twoProjectsOneMap());
		const original = await archiveOf(store, 'Marking 2026');

		const there = destination('Marking 2026');
		await restoreWorkspaceTar(streamOf(original), there.open);

		expect(await archiveOf(there.store, 'Marking 2026')).toEqual(original);
	});

	it('does not depend on the order the store happens to list files in', async () => {
		// A store that listed in insertion order would otherwise make reproducibility an accident of
		// how the Workspace was built rather than a property of the exporter.
		const forwards = seed(twoProjectsOneMap());
		const entries = Object.entries(twoProjectsOneMap()).reverse();
		const backwards = seed(Object.fromEntries(entries));

		expect(await archiveOf(backwards, 'W')).toEqual(await archiveOf(forwards, 'W'));
	});

	it('stamps every entry with the constant time rather than the clock', async () => {
		const store = seed({ 'a/project.json': '{}' });
		const entries = await unpackTar(await archiveOf(store, 'W'), { strict: true });
		for (const entry of entries) {
			expect(entry.header.mtime?.getTime()).toBe(TAR_ENTRY_MTIME.getTime());
		}
	});
});

describe('restoring reproduces the Workspace', () => {
	it('brings back every file, byte for byte', async () => {
		const files = twoProjectsOneMap();
		const store = seed(files);
		const there = destination();

		const restored = await restoreWorkspaceTar(
			streamOf(await archiveOf(store, 'Marking 2026')),
			there.open
		);

		expect(contents(there.store)).toEqual(files);
		expect(restored.totalFiles).toBe(8);
		expect(restored.projects.toSorted()).toEqual(['amsterdam-1625', 'the-canal-ring']);
	});

	it('lists both Projects on the hub, with one pyramid and one Alignment', async () => {
		// Asserted through `Workspace` rather than by reading paths, because "appears on the hub" is
		// `listProjects`' answer and nothing else. A restore that put the files in the right places but
		// left them unreadable would pass a path comparison and fail here.
		const store = seed(twoProjectsOneMap());
		const there = destination();
		await restoreWorkspaceTar(streamOf(await archiveOf(store, 'W')), there.open);

		const workspace = new Workspace(there.store);
		const projects = await workspace.listProjects();
		expect(projects.map((project) => project.directory).toSorted()).toEqual([
			'amsterdam-1625',
			'the-canal-ring'
		]);
		expect(projects.every((project) => project.problem === null)).toBe(true);
		expect((await workspace.readProject('amsterdam-1625')).name).toBe('Amsterdam 1625');
		expect((await there.store.list('images/amsterdam-1625/')).length).toBe(3);
		expect(decode(await there.store.read('alignments/amsterdam-1625.json' as StorePath))).toBe(
			'{"type":"Annotation","id":"amsterdam-1625"}'
		);
	});

	it('asks for the Workspace name the backup carries', async () => {
		const store = seed({ 'a/project.json': projectJson() });
		const there = destination('Marking 2026 (2)');
		const restored = await restoreWorkspaceTar(
			streamOf(await archiveOf(store, 'Marking 2026')),
			there.open
		);

		expect(there.asked).toEqual(['Marking 2026']);
		expect(restored.backupName).toBe('Marking 2026');
		// And reports the name it really got, which is what the caller has to switch to.
		expect(restored.workspaceName).toBe('Marking 2026 (2)');
	});

	it('says that publishing is needed before the Workspace is a site again', async () => {
		const store = seed({ 'a/project.json': projectJson(), 'index.html': '<!doctype html>' });
		const there = destination('Marking 2026');
		const restored = await restoreWorkspaceTar(streamOf(await archiveOf(store, 'W')), there.open);

		expect(restored.notice).toMatch(/publish/i);
		// And the other half of what the exclusion cost, which is easy to leave unsaid: an offline
		// copy's Base Map tiles are gone too, and a Reader of a Project that had one sees a blank map.
		expect(restored.notice).toMatch(/offline/i);
		expect(restored.notice).toContain('Marking 2026');
	});
});

describe('restoring never overwrites and never merges', () => {
	it('leaves the Workspace that was open completely untouched', async () => {
		const mine = seed({
			'my-project/project.json': projectJson({ name: 'My own work' }),
			// alignment-write-is-the-fixture: the open Workspace's own Alignment, whose survival across somebody else's restore is the assertion
			'alignments/amsterdam-1625.json': '{"mine":true}'
		});
		const before = contents(mine);

		const backup = seed(twoProjectsOneMap());
		const there = destination();
		await restoreWorkspaceTar(streamOf(await archiveOf(backup, 'Theirs')), there.open);

		// The Alignment ids collide — the case ADR-0023 says merging cannot answer — and the open
		// Workspace's copy is the one every one of its own Projects is drawn by.
		expect(contents(mine)).toEqual(before);
		expect(decode(await mine.read('alignments/amsterdam-1625.json' as StorePath))).toBe(
			'{"mine":true}'
		);
	});
});

describe('a backup past the zip’s ceiling', () => {
	it('round-trips more than 65,535 files with the count intact', async () => {
		// The reason the format moved off zip. The zip exporter refused above 65,535 entries because
		// the zip writer counted entries in sixteen bits — 70,000 produced an index claiming 4,464, and
		// `unzipSync` read back 4,464 files with no error at all. The assertion is on the **restored
		// file count**, which is exactly the assertion that caught it.
		//
		// Generated rather than committed as a fixture: 70,000 files do not belong in the repository.
		const count = 70_000;
		const store = new MemoryProjectStore();
		store.plant('a-project/project.json' as StorePath, encode(projectJson()));
		for (let i = 0; i < count; i += 1) {
			store.plant(`images/big/${i}.jpg` as StorePath, encode('t'));
		}
		const expected = count + 1;

		const backup = await exportWorkspaceTar(store, 'Huge');
		expect(backup.totalFiles).toBe(expected);

		const there = destination();
		const restored = await restoreWorkspaceTar(backup.body, there.open);

		expect(restored.totalFiles).toBe(expected);
		expect((await there.store.list('')).length).toBe(expected);
		expect((await there.store.list('images/big/')).length).toBe(count);
	}, 300_000);
});

describe('a long Project directory survives the round trip', () => {
	// The criterion that passes by accident if the Project name is short. 64 characters is the limit
	// `toDirectoryName` allows, and `<64>/annotations/<uuid>.geojson` is 121 bytes before the
	// Workspace name is prepended — past tar's 100-byte `name` field either way.
	const sixtyFour = 'a-project-name-at-the-sixty-four-character-limit-exactly-aaaaaaa';
	const uuids = ['0189a4c3-1c2f-7f1e-9b3a-0f2e5d6c7a8b', '0189a4c3-1c2f-7f1e-9b3a-0f2e5d6c7a8c'];

	it('is 64 characters, so the test is testing what it says it is', () => {
		expect(sixtyFour.length).toBe(64);
	});

	it('round-trips the directory and its annotations', async () => {
		const files: Record<string, string> = { [`${sixtyFour}/project.json`]: projectJson() };
		for (const uuid of uuids) {
			files[`${sixtyFour}/annotations/${uuid}.geojson`] = `{"uuid":"${uuid}"}`;
		}
		const store = seed(files);

		// A Workspace name at *its* limit too, so the archive paths are as long as they can be.
		const workspaceName = 'A Workspace Name At The Sixty Four Code Point Limit Exactly aaaa';
		expect([...workspaceName].length).toBe(64);
		const archive = await archiveOf(store, workspaceName);

		// The entry really is past tar's `name` field, or this asserts nothing.
		const longest = Math.max(
			...(await unpackTar(archive, { strict: true })).map(
				(entry) => new TextEncoder().encode(entry.header.name).length
			)
		);
		expect(longest).toBeGreaterThan(100);

		const there = destination();
		await restoreWorkspaceTar(streamOf(archive), there.open);
		expect(contents(there.store)).toEqual(files);
	});

	it('round-trips a Workspace name in a non-Latin script', async () => {
		// `toWorkspaceName` keeps a non-Latin script's combining marks intact. A backup that mangled
		// them would undo that at the one moment the user is trusting the tool with everything they
		// have.
		for (const name of ['अंकन २०२६', '標記二〇二六', 'ترميز ٢٠٢٦', 'Markierung Grün']) {
			const store = seed({ [`${'p'.repeat(64)}/annotations/${uuids[0]}.geojson`]: '{}' });
			const there = destination();
			const restored = await restoreWorkspaceTar(
				streamOf(await archiveOf(store, name)),
				there.open
			);

			expect(restored.backupName).toBe(name);
			expect(there.asked).toEqual([name]);
			expect(contents(there.store)).toEqual({
				[`${'p'.repeat(64)}/annotations/${uuids[0]}.geojson`]: '{}'
			});
		}
	});
});

describe('an interrupted restore leaves no Project on the hub', () => {
	it('writes project.json last, so the manifests arrive after everything they name', async () => {
		const store = seed(twoProjectsOneMap());
		const there = destination();
		const order: string[] = [];
		await restoreWorkspaceTar(streamOf(await archiveOf(store, 'W')), there.open, {
			onProgress: (progress) => {
				if (progress.path !== null) order.push(progress.path);
			}
		});

		const manifests = order.filter((path) => path.endsWith('/project.json'));
		expect(manifests).toEqual(['amsterdam-1625/project.json', 'the-canal-ring/project.json']);
		// Every one of them is in the last positions, after every other file.
		expect(order.slice(-manifests.length)).toEqual(manifests);
	});

	it('lists nothing on the hub when the archive is truncated part way through', async () => {
		// The failure the zip could not report at all: the zip reader read a short archive back as a short
		// archive, silently. `tar-format.test.ts` measures that a truncated tar throws instead; this
		// asserts what we then do about it.
		const store = seed(twoProjectsOneMap());
		const archive = await archiveOf(store, 'W');
		const there = destination();

		await expect(
			restoreWorkspaceTar(streamOf(archive.subarray(0, Math.floor(archive.length / 2))), there.open)
		).rejects.toThrow(/truncated/i);

		expect(await new Workspace(there.store).listProjects()).toEqual([]);
		expect(there.discarded()).toBe(true);
		expect(await there.store.list('')).toEqual([]);
	});

	it('lists nothing on the hub when a write fails part way through', async () => {
		const store = seed(twoProjectsOneMap());
		const archive = await archiveOf(store, 'W');
		const there = destination();
		there.store.failNextWrite('rename');

		await expect(restoreWorkspaceTar(streamOf(archive), there.open)).rejects.toThrow();

		expect(await new Workspace(there.store).listProjects()).toEqual([]);
		expect(there.discarded()).toBe(true);
	});
});

describe('a backup from a newer version of the app is refused', () => {
	it('names where to get that version, and restores nothing', async () => {
		const store = seed({
			'a-project/project.json': projectJson({ formatVersion: 99 }),
			'images/amsterdam-1625/info.json': '{"width":1,"height":1}'
		});
		const there = destination();

		const refusal = restoreWorkspaceTar(streamOf(await archiveOf(store, 'W')), there.open);
		await expect(refusal).rejects.toBeInstanceOf(ProjectFormatTooNewError);
		await expect(refusal).rejects.toThrow(/Nothing has been restored/);
		await expect(refusal).rejects.toThrow(/ballastella/i);

		expect(there.discarded()).toBe(true);
		expect(await there.store.list('')).toEqual([]);
	});

	it('refuses before the manifest is written, even though other files streamed past', async () => {
		// The manifests are held back, so a refusal reaches them before the hub does. Asserted
		// separately from the discard above, because a restore that wrote the manifest and then
		// deleted the Workspace would pass that assertion for the wrong reason.
		const store = seed({ 'a-project/project.json': projectJson({ formatVersion: 99 }) });
		const there = destination();
		let sawManifest = false;
		await restoreWorkspaceTar(streamOf(await archiveOf(store, 'W')), there.open, {
			onProgress: (progress) => {
				if (progress.path?.endsWith('project.json')) sawManifest = true;
			}
		}).catch(() => undefined);

		expect(sawManifest).toBe(false);
	});
});

describe('a backup that is not one is refused', () => {
	const refuse = async (archive: Uint8Array<ArrayBuffer>): Promise<BackupRejectedError> => {
		const there = destination();
		try {
			await restoreWorkspaceTar(streamOf(archive), there.open);
		} catch (cause) {
			expect(await there.store.list('')).toEqual([]);
			return cause as BackupRejectedError;
		}
		throw new Error('expected a refusal');
	};

	it('refuses an archive that does not open with a Workspace folder', async () => {
		const archive = await packTar([
			{
				header: { name: 'project.json', size: 2, type: 'file', mtime: TAR_ENTRY_MTIME },
				body: '{}'
			}
		]);
		const error = await refuse(archive);
		expect(error).toBeInstanceOf(BackupRejectedError);
		expect(error.reason).toBe('no-workspace-directory');
		expect(error.message).toMatch(/Nothing has been restored/);
	});

	it('refuses an empty file, in words rather than in the parser’s', async () => {
		// `modern-tar` says `Tar archive is truncated.` for this, for a JPEG picked by mistake, and
		// for a download that stopped half way. That sentence is not a message for a scholar and does
		// not end with the promise every other refusal here makes, so it is wrapped.
		const error = await refuse(new Uint8Array(0));
		expect(error).toBeInstanceOf(BackupRejectedError);
		expect(error.reason).toBe('not-a-tar');
		expect(error.message).toMatch(/Nothing has been restored/);
		expect(error.message).toMatch(/downloaded completely/);
	});

	it('refuses a file that is not an archive at all', async () => {
		const error = await refuse(encode('this is a JPEG, or a shopping list, but not a backup'));
		expect(error.reason).toBe('not-a-tar');
		expect(error.message).toMatch(/Nothing has been restored/);
	});

	it('accepts a well-formed but empty archive, and still says it holds no Workspace', async () => {
		// Two zero blocks is a *valid* tar holding nothing — a different failure from a damaged one,
		// and it reaches the `no-workspace-directory` refusal rather than the parser's.
		const error = await refuse(new Uint8Array(1024));
		expect(error.reason).toBe('no-workspace-directory');
	});

	it('refuses an entry that climbs out of the Workspace', async () => {
		const archive = await packTar([
			{ header: { name: 'W/', size: 0, type: 'directory', mtime: TAR_ENTRY_MTIME } },
			{
				header: { name: 'W/../../elsewhere.txt', size: 1, type: 'file', mtime: TAR_ENTRY_MTIME },
				body: 'x'
			}
		]);
		const error = await refuse(archive);
		expect(error.reason).toBe('path-traversal');
		expect(error.message).toContain('elsewhere.txt');
	});

	it('refuses an entry outside the folder the archive names', async () => {
		// Not a traversal — a perfectly ordinary path, in a different Workspace. In the OPFS root that
		// is another Workspace of the user's, including the damaged one being recovered from.
		const archive = await packTar([
			{ header: { name: 'W/', size: 0, type: 'directory', mtime: TAR_ENTRY_MTIME } },
			{
				header: { name: 'Another Workspace/x.txt', size: 1, type: 'file', mtime: TAR_ENTRY_MTIME },
				body: 'x'
			}
		]);
		const error = await refuse(archive);
		expect(error.reason).toBe('path-traversal');
		expect(error.message).toContain('Another Workspace');
	});

	// The two bounds on what a stranger's archive may ask restore to *hold*. Unlike every other file
	// in the archive, `project.json` files are buffered rather than streamed to disk — they have to
	// be, to be written last — so they are the one memory cost that scales with what the archive
	// claims. Both bounds are generous by a wide margin; both are asserted, because an untested bound
	// is a number in a comment.
	it('refuses a backup claiming more Projects than a Workspace is', async () => {
		// Valid manifests, deliberately. `{}` would be refused by `parseProjectFile` first — which is
		// itself correct, and is why this fixture is real documents: a bound that only ever fires
		// behind another refusal is a bound nothing has established.
		const manifest = encode(projectJson());
		const entries = [
			{ header: { name: 'W/', size: 0, type: 'directory' as const, mtime: TAR_ENTRY_MTIME } },
			...Array.from({ length: 1001 }, (_unused, i) => ({
				header: {
					name: `W/p${i}/project.json`,
					size: manifest.length,
					type: 'file' as const,
					mtime: TAR_ENTRY_MTIME
				},
				body: manifest
			}))
		];
		const error = await refuse(await packTar(entries));
		expect(error.reason).toBe('too-large');
		expect(error.message).toContain('1000');
	});

	it('refuses a project.json far larger than a manifest', async () => {
		const huge = 'x'.repeat(5 * 1024 * 1024);
		const error = await refuse(
			await packTar([
				{ header: { name: 'W/', size: 0, type: 'directory', mtime: TAR_ENTRY_MTIME } },
				{
					header: {
						name: 'W/a/project.json',
						size: huge.length,
						type: 'file',
						mtime: TAR_ENTRY_MTIME
					},
					body: huge
				}
			])
		);
		expect(error.reason).toBe('too-large');
		expect(error.message).toContain('project.json');
	});

	it('refuses an entry claiming the store’s reserved temporary suffix', async () => {
		const archive = await packTar([
			{ header: { name: 'W/', size: 0, type: 'directory', mtime: TAR_ENTRY_MTIME } },
			{
				header: {
					name: 'W/a/secret.ballastella-tmp',
					size: 1,
					type: 'file',
					mtime: TAR_ENTRY_MTIME
				},
				body: 'x'
			}
		]);
		expect((await refuse(archive)).reason).toBe('path-traversal');
	});

	it('refuses a Workspace folder whose name is a path rather than a name', async () => {
		const archive = await packTar([
			{ header: { name: 'has/a/slash/', size: 0, type: 'directory', mtime: TAR_ENTRY_MTIME } }
		]);
		expect((await refuse(archive)).reason).toBe('no-workspace-directory');
	});

	it('refuses a Workspace folder whose name is not a legal Workspace name', async () => {
		// ⚠ **This test exists because the mutation check found the guard it covers was doing
		// nothing.** Deleting `toWorkspaceName(name) === name` from `backupWorkspaceName` left the
		// whole suite green, because the only specimen was `has/a/slash/` — which the *earlier*
		// `includes('/')` check already rejects. These two are names that get past every structural
		// check and still change under the normaliser, which is the case the guard is actually for.
		//
		// ⚠ **An earlier version of this comment called these names "one our own exporter could not
		// have written", and that was false** — `exportWorkspaceTar` wrote exactly such names, for
		// every folder Workspace, which is the defect recorded in its header. It is true *now*, because
		// the exporter normalises; but the guard's job does not depend on that, and stating it that way
		// sent a reader looking for a reassurance rather than a rule. What the guard actually enforces
		// is simpler and does not rest on the exporter's good behaviour: **the archive's root directory
		// must be a legal Workspace directory name**, because restore has to create a Workspace by that
		// name and a name that changes under an idempotent normaliser would create one the archive does
		// not describe — the silent mangling `toWorkspaceName` exists to prevent.
		//
		// The second specimen is how this really arrives: APFS stores filenames decomposed, so a folder
		// called “Café Notes” comes back as NFD and is spelled differently by this build.
		for (const name of [
			// `#` is not in `toWorkspaceName`'s allowed set; it normalises to a space.
			'Marking#2026',
			// NFD: `e` followed by a combining acute, which `normalize('NFC')` composes.
			'Café Notes'
		]) {
			const archive = await packTar([
				{ header: { name: `${name}/`, size: 0, type: 'directory', mtime: TAR_ENTRY_MTIME } }
			]);
			expect((await refuse(archive)).reason).toBe('no-workspace-directory');
		}
	});

	it('refuses an entry whose path is longer than any Workspace path needs', async () => {
		// ⚠ **The mutation check earned this one.** It began as a test for a *third* safety call, on
		// the archive path before the Workspace prefix was stripped; removing that call left the whole
		// suite green and no specimen could be built that only it would catch, so the call was deleted
		// rather than excused. The bound itself is real and is asserted here on the path that is
		// actually written — see the note in `restore-workspace-tar.ts`.
		const archive = await packTar([
			{ header: { name: 'W/', size: 0, type: 'directory', mtime: TAR_ENTRY_MTIME } },
			{
				header: {
					name: `W/${'d/'.repeat(600)}file.json`,
					size: 1,
					type: 'file',
					mtime: TAR_ENTRY_MTIME
				},
				body: 'x'
			}
		]);
		const error = await refuse(archive);
		expect(error.reason).toBe('path-traversal');
		expect(error.message).toMatch(/1024 bytes/);
	});
});

describe('quota is checked before restoring, not discovered at eighty per cent', () => {
	const backupOf = async (): Promise<Uint8Array<ArrayBuffer>> =>
		archiveOf(seed(twoProjectsOneMap()), 'Marking 2026');

	it('refuses beforehand with the numbers, and writes nothing', async () => {
		const there = destination();
		const archive = await backupOf();

		const refusal = restoreWorkspaceTar(streamOf(archive), there.open, {
			archiveBytes: 900_000_000,
			estimateStorage: async () => ({ quota: 1_000_000_000, usage: 950_000_000 })
		});

		await expect(refusal).rejects.toBeInstanceOf(BackupRejectedError);
		await expect(refusal).rejects.toThrow(/900 MB/);
		await expect(refusal).rejects.toThrow(/50 MB/);
		await expect(refusal).rejects.toThrow(/1.0 GB/);

		// **Not even opened.** The refusal is before the destination exists, which is what "writes
		// nothing" means here — there is no Workspace to have written into and none to discard.
		expect(there.asked).toEqual([]);
		expect(there.discarded()).toBe(false);
		expect(await there.store.list('')).toEqual([]);
	});

	it('restores when there is room', async () => {
		const there = destination();
		const restored = await restoreWorkspaceTar(streamOf(await backupOf()), there.open, {
			archiveBytes: 1000,
			estimateStorage: async () => ({ quota: 1_000_000_000, usage: 0 })
		});
		expect(restored.totalFiles).toBe(8);
	});

	it('restores when the browser will not answer, rather than refusing what it cannot check', async () => {
		// Refusing on an unanswerable estimate would refuse every restore on a browser without the
		// API — which is the browser this whole path exists for.
		for (const estimate of [
			async () => null,
			async () => ({}),
			async () => ({ quota: 1_000_000_000 }),
			async () => {
				throw new Error('no');
			}
		]) {
			const there = destination();
			const restored = await restoreWorkspaceTar(streamOf(await backupOf()), there.open, {
				archiveBytes: 900_000_000,
				estimateStorage: estimate as never
			});
			expect(restored.totalFiles).toBe(8);
		}
	});
});

describe('restoring does not hold the archive in memory', () => {
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE BOUND IS A CONSTANT, NOT A FRACTION, AND THE FIRST DRAFT OF THESE TESTS GOT IT WRONG
	//
	// Both of these originally used an archive of about 1.8 MB and asserted that the source had been
	// read less than three-quarters of the way when half the files were on disk. Both failed, and
	// the *tests* were wrong rather than the code: the Web Streams chain between the source and the
	// decoder has fixed high-water marks totalling around 9 MiB, so **an archive smaller than that
	// is pulled in whole no matter how carefully restore streams**.
	//
	// That is worth stating rather than tuning away, because it is the honest shape of the guarantee.
	// Restore's peak memory is not "a fraction of the archive"; it is **a constant, plus one file**.
	// For a small backup the constant dominates and the whole thing is in memory — which is fine,
	// because it is small. For the ~400 MB backup ADR-0024 says a zip could not restore on an iPad at
	// all, the constant is what makes it possible. So the archive here is comfortably larger than the
	// buffer, and the assertion is against the constant.
	const OVER_THE_BUFFER = 32 * 1024 * 1024;
	/** The stream chain's own buffering, measured in `tar-format.test.ts` at about 9 MiB. */
	const STREAM_BUFFER_CEILING = 16 * 1024 * 1024;

	const bigWorkspace = (): MemoryProjectStore => {
		const store = new MemoryProjectStore();
		store.plant('a-project/project.json' as StorePath, encode(projectJson()));
		const tile = encode('x'.repeat(64 * 1024));
		for (let i = 0; i < OVER_THE_BUFFER / tile.length; i += 1) {
			store.plant(`images/big/${i}.jpg` as StorePath, tile);
		}
		return store;
	};

	/** A source that reports how much of the archive it has actually been asked for. */
	const meteredSource = (
		archive: Uint8Array,
		onPull: (fed: number) => void
	): ReadableStream<Uint8Array> => {
		let fed = 0;
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				if (fed >= archive.length) {
					controller.close();
					return;
				}
				const end = Math.min(fed + 64 * 1024, archive.length);
				controller.enqueue(archive.subarray(fed, end));
				fed = end;
				onPull(fed);
			}
		});
	};

	it('writes files while most of the archive is still unread', async () => {
		const store = bigWorkspace();
		const archive = await archiveOf(store, 'W');
		expect(archive.length).toBeGreaterThan(OVER_THE_BUFFER);

		let fed = 0;
		let fedAtFirstFile = -1;
		const there = destination();
		const source = meteredSource(archive, (at) => {
			fed = at;
		});

		await restoreWorkspaceTar(source, there.open, {
			onProgress: (progress) => {
				if (progress.files === 1 && fedAtFirstFile < 0) fedAtFirstFile = fed;
			}
		});

		// A restore that drained the stream into a buffer before writing anything would report its
		// first file only once `fed === archive.length`.
		expect(fedAtFirstFile).toBeGreaterThan(0);
		expect(fedAtFirstFile).toBeLessThan(STREAM_BUFFER_CEILING);
		expect(await there.store.list('images/big/')).toHaveLength(OVER_THE_BUFFER / (64 * 1024));
	}, 120_000);

	it('never lets more than the stream chain’s own buffer go unwritten', async () => {
		// The other half, and the one that actually pins peak memory. A consumer that pulled
		// everything it was offered while writing slowly would still hold the archive, and would
		// still pass the test above.
		const store = bigWorkspace();
		const archive = await archiveOf(store, 'W');

		let fed = 0;
		let written = 0;
		let maxOutstanding = 0;
		const there = destination();
		const source = meteredSource(archive, (at) => {
			fed = at;
			maxOutstanding = Math.max(maxOutstanding, fed - written);
		});

		await restoreWorkspaceTar(source, there.open, {
			onProgress: (progress) => {
				written = progress.bytes;
			}
		});

		// Bounded by a constant that does not grow with the archive — which is the property, and the
		// one a zip cannot have at any size, since a zip is unreadable without the index at its end.
		expect(maxOutstanding).toBeLessThan(STREAM_BUFFER_CEILING);
		expect(maxOutstanding).toBeLessThan(archive.length / 2);
	}, 120_000);
});

describe('a folder Workspace’s name is not a Workspace name, and a backup survives that', () => {
	// ⚠ **The defect this covers shipped, and only revealed itself at restore.** A folder Workspace's
	// name is the operating system's folder name, which has never been through `toWorkspaceName`.
	// `exportWorkspaceTar` wrote it into the archive verbatim, and `backupWorkspaceName` refuses any
	// root directory that is not already normalised — so a scholar with a folder called `Dave's maps`
	// got a backup that **failed when they tried to restore it**, which is the one moment they cannot
	// afford it.
	//
	// Every existing test passed straight through it, because every fixture was called `My Workspace`
	// or `Marking 2026` — the only kind of name that survives the normaliser untouched.
	const folderNames = [
		"Dave's maps",
		'maps, 1625',
		'maps & plans',
		'2026-08-08 backup!',
		// NFD, which is how it arrives off APFS: identical on screen, different in bytes.
		'Café Notes',
		// Past the 64-code-point cap, which a folder name is under no obligation to respect.
		`a very long folder name ${'x'.repeat(80)}`
	];

	it.for(folderNames)('backs up and restores a folder called %j', async (folderName) => {
		// The premise: this really is a name the Workspace rules would change. Without this the test
		// could pass by accident on a name that needed no normalising at all.
		expect(toWorkspaceName(folderName)).not.toBe(folderName);

		const store = seed(twoProjectsOneMap());
		const backup = await exportWorkspaceTar(store, folderName);
		const archive = await collect(backup.body);

		// The archive is rooted at a legal name, and the download is called the same thing — so what
		// lands in Downloads, what `tar xf` unpacks, and what the Workspace ends up called all agree.
		const legal = toWorkspaceName(folderName);
		expect(backup.workspaceName).toBe(legal);
		expect(backup.fileName).toBe(`${legal}.tar`);
		expect(backup.displayName).toBe(folderName);

		const entries = await unpackTar(archive, { strict: true });
		expect(entries[0]?.header.name).toBe(`${legal}/`);
		expect(entries.every((entry) => entry.header.name.startsWith(`${legal}/`))).toBe(true);

		// And it restores, which is the whole point.
		const there = destination(legal);
		const restored = await restoreWorkspaceTar(streamOf(archive), there.open);

		expect(contents(there.store)).toEqual(twoProjectsOneMap());
		// The original name is carried rather than thrown away, and it is what the destination is
		// asked for — whoever creates the Workspace normalises it, so the preference is safe to pass
		// on and the user's own word for their work is not silently replaced on the way through.
		expect(restored.backupName).toBe(folderName);
		expect(there.asked).toEqual([folderName]);
		expect(restored.backupDirectoryName).toBe(legal);
	});

	it('writes no extra record when the name is already a legal one', async () => {
		// Reproducibility: the PAX record must not appear on an ordinary browser-storage backup, or
		// every archive grows a block and the bytes change for a fix that case did not need.
		const store = seed(twoProjectsOneMap());
		const withRecord = await archiveOf(seed(twoProjectsOneMap()), "Dave's maps");
		const without = await archiveOf(store, 'Marking 2026');

		expect(new TextDecoder('latin1').decode(without)).not.toContain('BALLASTELLA.workspace');
		expect(new TextDecoder('latin1').decode(withRecord)).toContain('BALLASTELLA.workspace');
	});

	it('ignores a display-name record that is not a name', async () => {
		// The record is a string out of somebody else's file. It is only ever a *preference*, and a
		// hostile one degrades to the archive's own directory name rather than to a refusal.
		for (const hostile of ['../../elsewhere', 'a\\b', 'x'.repeat(1000), '']) {
			const manifest = encode(projectJson());
			const archive = await packTar([
				{
					header: {
						name: 'W/',
						size: 0,
						type: 'directory',
						mtime: TAR_ENTRY_MTIME,
						pax: { 'BALLASTELLA.workspace': hostile }
					}
				},
				{
					header: {
						name: 'W/a/project.json',
						size: manifest.length,
						type: 'file',
						mtime: TAR_ENTRY_MTIME
					},
					body: manifest
				}
			]);
			const there = destination();
			const restored = await restoreWorkspaceTar(streamOf(archive), there.open);
			expect(restored.backupName).toBe('W');
			expect(there.asked).toEqual(['W']);
		}
	});
});

describe('a restore never reports more than it wrote', () => {
	it('does not count an Alignment it declined, and says so', async () => {
		// ⚠ **The defect this covers is the exact class the tar format was chosen to prevent.**
		// `writeRestored` ignored `writeAlignmentBytes`' outcome and counted the file regardless, so a
		// restore that dropped the archive's Alignment still reported it as delivered. A transfer that
		// says it delivered more than it did is the zip writer claiming 4,464 of 70,000 with a
		// different spelling.
		//
		// Unreachable while every destination is new — but `RestoreDestination` is an interface the
		// caller implements, and nothing in its contract says the store it hands over must be empty.
		const store = seed({
			// alignment-write-is-the-fixture: the Alignment inside the backup, offered to a destination that already has one
			'alignments/m.json': '{"from":"the backup"}',
			'a/project.json': projectJson()
		});
		const there = destination();
		// alignment-write-is-the-fixture: the destination's pre-existing Alignment, which must win
		there.store.plant('alignments/m.json' as StorePath, encode('{"already":"here"}'));

		const restored = await restoreWorkspaceTar(streamOf(await archiveOf(store, 'W')), there.open);

		// Kept, per ADR-0023 — and **not counted**, which is the half that was wrong.
		expect(decode(await there.store.read('alignments/m.json' as StorePath))).toBe(
			'{"already":"here"}'
		);
		expect(restored.declined).toEqual(['alignments/m.json']);
		// One file written — the manifest — and the declined Alignment in neither total.
		expect(restored.totalFiles).toBe(1);
		expect(restored.totalBytes).toBe(encode(projectJson()).length);
		// And the user is told, rather than left to compare file counts by hand.
		expect(restored.notice).toContain('not restored');
		expect(restored.notice).toContain('alignments/m.json');
	});

	it('reports nothing declined for an ordinary restore', async () => {
		const store = seed(twoProjectsOneMap());
		const there = destination();
		const restored = await restoreWorkspaceTar(streamOf(await archiveOf(store, 'W')), there.open);

		expect(restored.declined).toEqual([]);
		expect(restored.notice).not.toContain('not restored');
		expect(restored.totalFiles).toBe(Object.keys(twoProjectsOneMap()).length);
	});
});

describe('the archive is a tar anyone can open', () => {
	it('unpacks to a folder named after the Workspace, with no tool of ours involved', async () => {
		// For the Firefox, Safari and iPad users this path exists for, the archive is the only copy of
		// their work outside a browser they cannot see into. `tar xf` has to produce something a
		// person recognises.
		const store = seed(twoProjectsOneMap());
		const entries = await unpackTar(await archiveOf(store, 'Marking 2026'), { strict: true });

		expect(entries[0]?.header.name).toBe('Marking 2026/');
		expect(entries[0]?.header.type).toBe('directory');
		expect(entries.every((entry) => entry.header.name.startsWith('Marking 2026/'))).toBe(true);
	});

	it('reads back an archive another packer wrote', async () => {
		// Restore is not coupled to our exporter's chunking: an archive built entry-by-entry through
		// the streaming packer restores the same as one `packTar` produced in a single buffer.
		const { readable, controller } = createTarPacker();
		const producing = (async () => {
			await controller
				.add({ name: 'Handmade/', size: 0, type: 'directory', mtime: TAR_ENTRY_MTIME })
				.close();
			const manifest = encode(projectJson());
			const writer = controller
				.add({
					name: 'Handmade/a-project/project.json',
					size: manifest.length,
					type: 'file',
					mtime: TAR_ENTRY_MTIME
				})
				.getWriter();
			await writer.write(manifest);
			await writer.close();
			controller.finalize();
		})();

		const there = destination();
		const restored = await restoreWorkspaceTar(readable, there.open);
		await producing;

		expect(restored.backupName).toBe('Handmade');
		expect(restored.projects).toEqual(['a-project']);
	});
});

describe('restore is not a merge, and does not pretend to detect a concurrent edit', () => {
	it('takes the archive’s Alignment without comparing it to anything', async () => {
		// Concurrent-edit detection is deliberately left open and ADR-0023 accepts it: nothing detects
		// a colleague's change arriving through a synced Workspace between a read and a write.
		// A backup and restore is exactly where somebody would assume that gap is covered, so this
		// asserts the honest behaviour rather than implying a guarantee.
		//
		// The new Workspace gets the archive's copy because it is a *new* Workspace with nothing in it
		// to compare against. No timestamps are read, nothing is reconciled, and the user's own
		// Workspace — asserted untouched above — is where their version still is.
		// alignment-write-is-the-fixture: the Alignment inside the backup, whose bytes must arrive unreconciled
		const store = seed({ 'alignments/m.json': '{"from":"the backup"}' });
		const there = destination();
		await restoreWorkspaceTar(streamOf(await archiveOf(store, 'W')), there.open);

		expect(decode(await there.store.read('alignments/m.json' as StorePath))).toBe(
			'{"from":"the backup"}'
		);
	});

	it('will not overwrite an Alignment already in the destination', async () => {
		// ⚠ **This test exists because the mutation check called the bluff of a doc comment.** Restore
		// routes its Alignment writes through `alignment-file.ts`'s `writeAlignmentBytes` with
		// `intent: 'create'` rather than through the generic `store.write`. Replacing that routing with
		// a plain write left the whole suite green — as it had to, since the destination
		// `restoreWorkspaceTar` is given is normally a Workspace created moments earlier and therefore
		// empty, where the two are indistinguishable.
		//
		// A guarantee nothing can observe is not a guarantee, so here is the case that observes it.
		// `RestoreDestination` is an *interface the caller implements*, and nothing in its contract
		// says the store must be empty — a future caller could hand over a store with something
		// already in it. When that happens, the Alignment already there wins, which is the direction
		// ADR-0023 requires: an Alignment is shared by every Project that draws the map, so
		// overwriting one can destroy Control Points somebody placed in a Project nobody has opened.
		// alignment-write-is-the-fixture: the Alignment inside the backup, offered to a destination that already has one
		const store = seed({ 'alignments/m.json': '{"from":"the backup"}' });
		const there = destination();
		// alignment-write-is-the-fixture: the destination's pre-existing Alignment, whose survival is the assertion
		there.store.plant('alignments/m.json' as StorePath, encode('{"already":"here"}'));

		await restoreWorkspaceTar(streamOf(await archiveOf(store, 'W')), there.open);

		expect(decode(await there.store.read('alignments/m.json' as StorePath))).toBe(
			'{"already":"here"}'
		);
	});
});

describe('WorkspaceRestore describes what happened', () => {
	it('reports the totals it actually wrote', async () => {
		const files = twoProjectsOneMap();
		const store = seed(files);
		const there = destination();
		const restored: WorkspaceRestore = await restoreWorkspaceTar(
			streamOf(await archiveOf(store, 'W')),
			there.open
		);

		const expectedBytes = Object.values(files).reduce(
			(sum, content) => sum + encode(content).length,
			0
		);
		expect(restored.totalFiles).toBe(Object.keys(files).length);
		expect(restored.totalBytes).toBe(expectedBytes);
	});
});

// ⚠ **The refusal lives in the writer, not only in the button** (ADR-0024).
//
// An archive of somebody else's work sitting in the user's Downloads folder is indistinguishable
// from a backup of their own, which is how a review copy comes to be restored months later as though
// it were theirs. The editor hides the button *and* refuses before the walk starts — but the editor
// has no test project at all, so a guard that lived only there was a guard whose call site could be
// deleted with the whole suite staying green. This is the layer that can be asserted.
describe('a Review Workspace is never backed up', () => {
	const marked = (): MemoryProjectStore => {
		const store = seed(twoProjectsOneMap());
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
		return store;
	};

	it('refuses, naming what it holds and the way out', async () => {
		const cause = await exportWorkspaceTar(marked(), 'amsterdam-1625').catch(
			(thrown: unknown) => thrown
		);

		expect(cause).toBeInstanceOf(ReviewWorkspaceError);
		expect((cause as Error).message).toContain('“Amsterdam 1625”');
		expect((cause as Error).message).toContain('cannot be backed up');
	});

	// The Workspace is never walked, and nothing is produced. **One file is read, and it is the mark
	// itself** — the refusal is a question about that file, so "nothing is read" would be an
	// overstatement of a real property: what the refusal must not cost is the walk. A refusal taken
	// after it would still be a refusal, but it would also be tens of thousands of `size` calls on a
	// shared pool. Both halves are asserted, so a later cut that reads a manifest or a project.json
	// "just to name the Workspace" has to come back through here.
	it('reads the mark and nothing else, and produces no archive at all', async () => {
		const store = marked();
		let listed = 0;
		const reads: string[] = [];
		const list = store.list.bind(store);
		const read = store.read.bind(store);
		store.list = async (prefix: string) => {
			listed += 1;
			return list(prefix);
		};
		store.read = async (path: StorePath) => {
			reads.push(path);
			return read(path);
		};

		await expect(exportWorkspaceTar(store, 'amsterdam-1625')).rejects.toBeInstanceOf(
			ReviewWorkspaceError
		);
		expect(listed).toBe(0);
		expect(reads).toEqual([REVIEW_MARK_PATH]);
	});

	it('still backs up a Workspace of the user’s own', async () => {
		const backup = await exportWorkspaceTar(seed(twoProjectsOneMap()), 'My Workspace');

		expect(backup.totalFiles).toBe(Object.keys(twoProjectsOneMap()).length);
	});
});

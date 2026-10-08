import type { FetchFn } from '../injection/store-image-fetch.js';
import { newProjectFile, serialiseProjectFile } from '../project/project-file.js';
import type { ProjectStore, StorePath } from '../store/project-store.js';
import { decode, encode } from '../test-support.js';
import { gitBlobSha } from './blob-sha.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import type { FakeMetadataStorage } from './fake-metadata-storage.js';
import { LocalChangeIndex } from './local-change-index.js';
import type { RemoteRepository } from './remote-binding.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';
import type { InventoryEntry } from './synchronization-planner.js';

export const ATLAS: RemoteRepository = { owner: 'ada', repository: 'atlas', branch: 'main' };

export const atlasWithReadme = (): Promise<FakeGitHub> =>
	createFakeGitHub({ ...ATLAS, tree: { 'README.md': '# Atlas\n' } });

export const baselineWith = (
	files: Iterable<readonly [string, string]>,
	remote: RemoteRepository = ATLAS
): SynchronizationBaseline => ({ remote, commit: 'c0ffee', files: new Map(files) });

export async function shas(files: Record<string, string>): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (const [path, text] of Object.entries(files)) map.set(path, await gitBlobSha(encode(text)));
	return map;
}

export const baselineOf = async (files: Record<string, string>): Promise<SynchronizationBaseline> =>
	baselineWith(await shas(files));

export const projectFile = (
	name: string,
	layers: Parameters<typeof serialiseProjectFile>[0]['layers'] = []
): string =>
	decode(serialiseProjectFile({ ...newProjectFile(name, new Date('2026-01-01')), layers }));

export const rawAnswer =
	(fake: FakeGitHub, path: string, answer: () => Response): FetchFn =>
	(input, init) =>
		String(input).endsWith(`/${path}`) ? Promise.resolve(answer()) : fake.fetch(input, init);

export const SMALL_WORKSPACE: Record<string, string> = {
	'ballastella-site.json': '{"formatVersion":2,"projects":[{"directory":"amsterdam-1625"}]}',
	'index.html': '<!doctype html>',
	'_app/immutable/entry/start.AAAA.js': 'export const start = 1;',
	'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}',
	'amsterdam-1625/annotations/notes.json': '{"type":"FeatureCollection","features":[]}',
	'images/blaeu/info.json': '{"id":"https://unset.invalid/blaeu"}',
	'images/blaeu/0,0,256,256/256,256/0/default.jpg': 'jpeg-bytes',
	'alignments/blaeu.json': '{"type":"Annotation"}'
};

export const changeIndex = (storage: FakeMetadataStorage, workspace = 'opfs:Marking 2026') =>
	new LocalChangeIndex(storage, workspace, { flushInterval: 0 });

export const remoteText = (github: FakeGitHub, path: string, ref?: string): string =>
	decode(github.files(ref).get(path) ?? new Uint8Array());

export const storedText = async (
	store: Pick<ProjectStore, 'read'>,
	path: string
): Promise<string> => decode(await store.read(path as StorePath));

export async function inventory(side: ProjectStore | FakeGitHub): Promise<InventoryEntry[]> {
	const files: [string, Uint8Array][] =
		'files' in side
			? [...side.files()]
			: await Promise.all(
					(await side.list('')).map(async (path): Promise<[string, Uint8Array]> => [
						path,
						await side.read(path)
					])
				);
	return Promise.all(files.map(async ([path, bytes]) => ({ path, sha: await gitBlobSha(bytes) })));
}

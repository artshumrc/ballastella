import { describe, expect, it } from 'vitest';

import { createFakeGitHub } from '../remote/fake-github.js';
import type { RemoteRepository } from '../remote/remote-binding.js';
import type { SynchronizationBaseline } from '../remote/synchronization-metadata.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { rejection, seeded, snapshot } from '../test-support.js';
import {
	allocateProjectImport,
	assertNotOwnRemote,
	readImportEvidence,
	type ImportIntoWorkspace
} from './project-import-allocation.js';
import { remapProjectImport } from './project-import-remapping.js';
import type { ProjectImportOrigin } from './project-import-source.js';
import {
	IMPORT_TRANSACTION_PATH,
	ImportRefusedError,
	commitProjectImport
} from './project-import-transaction.js';
import { REVIEW_ORIGIN as REVIEW, closureSource, json } from './test-fixtures.js';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const BOUND: RemoteRepository = { owner: OWNER, repository: REPOSITORY, branch: 'main' };
const SOURCE_DIRECTORY = 'amsterdam-1625';

const PROJECT = {
	formatVersion: 1,
	name: 'Amsterdam 1625',
	updatedAt: '2025-03-04T11:22:33.000Z',
	layers: [
		{
			kind: 'annotation',
			id: 'l2',
			name: 'Warehouses',
			visible: true,
			order: 0,
			geojsonRef: 'annotations/warehouses.geojson'
		}
	],
	baseMap: 'protomaps-light',
	onFrontPage: false
};

const EMPTY_COLLECTION = '{"type":"FeatureCollection","features":[]}';

const ON_REMOTE: Record<string, string> = {
	'README.md': '# Atlas\n',
	[`${SOURCE_DIRECTORY}/project.json`]: json(PROJECT),
	[`${SOURCE_DIRECTORY}/annotations/warehouses.geojson`]: EMPTY_COLLECTION
};

const atlas = (truncateAfter: number | null = null) =>
	createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree: ON_REMOTE }).then((github) =>
		Object.assign(github, { truncateAfter })
	);

const bound = (
	fetch: NonNullable<ImportIntoWorkspace['fetch']>,
	baseline?: SynchronizationBaseline | null
): ImportIntoWorkspace => ({
	remote: BOUND,
	local: [],
	token: null,
	fetch,
	...(baseline !== undefined && { baseline })
});

const githubOrigin = (
	overrides: Partial<Extract<ProjectImportOrigin, { kind: 'github' }>> = {}
): ProjectImportOrigin => ({
	kind: 'github',
	owner: OWNER,
	repository: REPOSITORY,
	branch: 'main',
	directory: SOURCE_DIRECTORY,
	commit: 'c0ffee',
	projectName: PROJECT.name,
	...overrides
});

const REVIEW_ORIGIN: ProjectImportOrigin = { ...REVIEW, projectName: PROJECT.name };

const baselineHolding = (paths: readonly string[]): SynchronizationBaseline => ({
	remote: BOUND,
	commit: 'baseline-commit',
	files: new Map(paths.map((path) => [path, 'sha']))
});

const closure = (origin: ProjectImportOrigin = REVIEW_ORIGIN) =>
	closureSource(
		{ 'project.json': json(PROJECT), 'annotations/warehouses.geojson': EMPTY_COLLECTION },
		{ origin }
	);

async function evidenceOf(
	workspace: ImportIntoWorkspace
): Promise<{ remote: string[]; baseline: string[] }> {
	const evidence = await readImportEvidence(REVIEW_ORIGIN, workspace);
	return { remote: [...(evidence.remote ?? [])].sort(), baseline: [...(evidence.baseline ?? [])] };
}

describe('the evidence an Import into a bound Workspace allocates against', () => {
	it('takes the current Remote tree and the valid Baseline, reserving a directory only the Remote has', async () => {
		const github = await atlas();
		const workspace = bound(github.fetch, baselineHolding(['boston-1775/project.json']));

		expect(await evidenceOf(workspace)).toEqual({
			remote: [
				'README.md',
				`${SOURCE_DIRECTORY}/annotations/warehouses.geojson`,
				`${SOURCE_DIRECTORY}/project.json`
			],
			baseline: ['boston-1775/project.json']
		});
		const evidence = await readImportEvidence(REVIEW_ORIGIN, workspace);
		expect(allocateProjectImport(await closure(), evidence).directory).toBe(
			`${SOURCE_DIRECTORY}-2`
		);
	});

	it('offers no Baseline evidence where there is no valid Baseline', async () => {
		const github = await atlas();
		const evidence = await readImportEvidence(REVIEW_ORIGIN, bound(github.fetch, null));
		expect(evidence.baseline).toBeUndefined();
	});

	it('asks GitHub nothing for an unbound Workspace, and offers no evidence of either kind', async () => {
		const noRequests = () => {
			throw new Error('nothing should have been asked of GitHub');
		};
		expect(await evidenceOf({ remote: null, local: [], fetch: noRequests })).toEqual({
			remote: [],
			baseline: []
		});
	});

	it('reads a repository with no commits as an empty Remote rather than a refusal', async () => {
		const github = await createFakeGitHub({ owner: OWNER, repository: REPOSITORY });
		expect(await evidenceOf(bound(github.fetch))).toEqual({ remote: [], baseline: [] });
	});
});

describe('a bound Workspace whose Remote cannot be inventoried, or is the Import’s own', () => {
	it.each([
		[
			'a truncated listing',
			REVIEW_ORIGIN,
			async () => (await atlas(1)).fetch,
			'remote-unavailable',
			`${OWNER}/${REPOSITORY}`
		],
		[
			'a host that cannot be reached',
			REVIEW_ORIGIN,
			async () => () => Promise.reject(new Error('offline')),
			'remote-unavailable',
			`${OWNER}/${REPOSITORY}`
		],
		[
			'a repository this reader cannot see',
			REVIEW_ORIGIN,
			async () =>
				(await createFakeGitHub({ owner: OWNER, repository: 'elsewhere', tree: {} })).fetch,
			'remote-unavailable',
			`${OWNER}/${REPOSITORY}`
		],
		[
			'the own Remote, only once the inventory is had',
			githubOrigin(),
			async () => (await atlas()).fetch,
			'own-remote',
			PROJECT.name
		],
		[
			'the own Remote, which a Remote that could not be listed never reaches',
			githubOrigin(),
			async () => (await atlas(1)).fetch,
			'remote-unavailable',
			`${OWNER}/${REPOSITORY}`
		]
	])(
		'refuses %s, naming it and adding nothing',
		async (_case, origin, fetchFor, refusal, names) => {
			const refused = await rejection(
				ImportRefusedError,
				readImportEvidence(origin, bound(await fetchFor()))
			);
			expect(refused.refusal).toBe(refusal);
			expect(refused.message).toContain('Nothing has been added to your Workspace.');
			expect(refused.message).toContain(names);
		}
	);
});

type ImportCheck = Parameters<typeof assertNotOwnRemote>[0];

function ownRemoteRefusal(check: ImportCheck): ImportRefusedError {
	try {
		assertNotOwnRemote(check);
	} catch (cause) {
		expect(cause).toBeInstanceOf(ImportRefusedError);
		return cause as ImportRefusedError;
	}
	throw new Error('the Import was not refused');
}

describe('Importing the Workspace’s own Remote Project', () => {
	const synchronized = {
		remote: BOUND,
		local: [`${SOURCE_DIRECTORY}/project.json`],
		remotePaths: Object.keys(ON_REMOTE)
	};

	it('is refused, naming the Project the author already has rather than Sync', () => {
		const { refusal, message } = ownRemoteRefusal({ origin: githubOrigin(), ...synchronized });
		expect(refusal).toBe('own-remote');
		expect(message).toContain(PROJECT.name);
		expect(message).toContain('already in this Workspace');
		expect(message).toContain('Nothing has been added to your Workspace.');
		expect(message).not.toMatch(/anyway|second copy of your own|Import it as|Use Sync/i);
	});

	it.each([
		[
			'directs the author to Sync when only the Remote has the Project',
			{ origin: githubOrigin(), remote: BOUND, local: [], remotePaths: Object.keys(ON_REMOTE) },
			'Use Sync'
		],
		[
			'recognises the Project directory the Baseline alone still records',
			{
				origin: githubOrigin(),
				remote: BOUND,
				local: [],
				remotePaths: [],
				baselinePaths: [`${SOURCE_DIRECTORY}/project.json`]
			},
			''
		],
		[
			'compares the repository as GitHub does, so case is not a different Remote',
			{ origin: githubOrigin({ owner: 'Ada', repository: 'Atlas' }), ...synchronized },
			''
		]
	])('%s', (_case, check: ImportCheck, message) => {
		const refused = ownRemoteRefusal(check);
		expect(refused.refusal).toBe('own-remote');
		expect(refused.message).toContain(message);
	});

	it.each<{ what: string; check: ImportCheck }>([
		{
			what: 'another repository entirely',
			check: { origin: githubOrigin({ repository: 'elsewhere' }), ...synchronized }
		},
		{
			what: 'another branch of the same repository, which is another Remote',
			check: { origin: githubOrigin({ branch: 'draft' }), ...synchronized }
		},
		{
			what: 'a Project directory this Workspace’s synchronization has never recognised',
			check: { origin: githubOrigin({ directory: 'somebody-elses' }), ...synchronized }
		},
		{
			what: 'an unbound Workspace, which has no own Remote to duplicate',
			check: { origin: githubOrigin(), remote: null, local: [], remotePaths: [] }
		},
		{
			what: 'a Project Bundle, whose evidence cannot establish a repository at all',
			check: { origin: REVIEW_ORIGIN, ...synchronized }
		},
		{
			what: 'a Review Workspace, for the same reason',
			check: {
				origin: { kind: 'review', projectName: PROJECT.name, directory: SOURCE_DIRECTORY },
				...synchronized
			}
		}
	])('treats $what as an ordinary Import', ({ check }) => {
		expect(() => assertNotOwnRemote(check)).not.toThrow();
	});
});

describe('what a refusal leaves behind', () => {
	async function importInto(
		store: MemoryProjectStore,
		workspace: ImportIntoWorkspace,
		origin: ProjectImportOrigin
	): Promise<void> {
		const evidence = await readImportEvidence(origin, workspace);
		const plan = await remapProjectImport(await closure(origin));
		const allocation = allocateProjectImport(plan.closure, {
			...evidence,
			local: await store.list('')
		});
		await commitProjectImport(store, plan.closure, allocation.destinations);
	}

	const boundWorkspace = async () => {
		const github = await atlas();
		const store = await seeded(
			Object.fromEntries(Object.entries(ON_REMOTE).filter(([path]) => path !== 'README.md'))
		);
		const baseline = baselineHolding(Object.keys(ON_REMOTE));
		const sides = async () => ({
			workspace: await snapshot(store),
			baseline: [...baseline.files].sort(),
			remote: github.files('main')
		});
		return { github, store, baseline, sides };
	};

	it.each([
		['an own-Remote refusal', githubOrigin(), null, 'own-remote'],
		['an inventory refusal', REVIEW_ORIGIN, 1, 'remote-unavailable']
	])('is unchanged on all three sides after %s', async (_case, origin, truncateAfter, refusal) => {
		const { github, store, baseline, sides } = await boundWorkspace();
		const before = await sides();
		github.truncateAfter = truncateAfter;

		const refused = await rejection(ImportRefusedError, () =>
			importInto(store, bound(github.fetch, baseline), origin)
		);
		expect(refused.refusal).toBe(refusal);
		expect(await sides()).toEqual(before);
		await expect(store.read(IMPORT_TRANSACTION_PATH)).rejects.toThrow();
	});

	it('adds the Project beside the synchronized one when the Import is somebody else’s work', async () => {
		const { github, store, baseline } = await boundWorkspace();

		await importInto(store, bound(github.fetch, baseline), REVIEW_ORIGIN);

		expect(await store.list('')).toEqual(
			expect.arrayContaining([
				`${SOURCE_DIRECTORY}-2/project.json`,
				`${SOURCE_DIRECTORY}/project.json`
			])
		);
		expect([...baseline.files.keys()]).not.toContain(`${SOURCE_DIRECTORY}-2/project.json`);
		expect([...github.files('main').keys()]).not.toContain(`${SOURCE_DIRECTORY}-2/project.json`);
	});
});

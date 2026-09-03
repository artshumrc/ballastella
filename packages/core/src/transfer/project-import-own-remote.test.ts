// What a bound Workspace's synchronization does to an Import: the current Remote inventory it must
// have, and the Import of its own Remote Project it must refuse (ADR-0037, ADR-0044).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO CLAIMS, AND THE SECOND ONE CANNOT BE MADE ABOUT A FUNCTION
//
// The first is a rule: given this Remote, this Baseline and this origin, the evidence is that
// evidence and the refusal is that refusal. Those are tables, and the fake GitHub answers the
// listing so a truncated tree and an unreachable host are provoked rather than described.
//
// The second is that a refusal costs the author nothing, and it is a claim about *bytes on three
// sides*: the Workspace, the Baseline and the Remote. So the last group runs the Import in the order
// the editor runs it — evidence, allocation, commit — against a real store and a real fake
// repository, and compares all three against snapshots taken before. A refusal that had written the
// Import marker, advanced the Baseline or pushed a commit would be visible there and nowhere else.

import { describe, expect, it } from 'vitest';

import { createFakeGitHub } from '../remote/fake-github.js';
import type { RemoteRepository } from '../remote/send-to-remote.js';
import type { SynchronizationBaseline } from '../remote/synchronization-metadata.js';
import { parseProjectFile } from '../project/project-file.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import { allocateProjectImport } from './project-import-allocation.js';
import {
	assertNotOwnRemote,
	readImportEvidence,
	type ImportIntoWorkspace
} from './project-import-own-remote.js';
import { remapProjectImport } from './project-import-remapping.js';
import {
	createProjectImportSource,
	type ClosureFile,
	type ClosurePath,
	type ProjectImportOrigin,
	type ProjectImportSource
} from './project-import-source.js';
import {
	IMPORT_TRANSACTION_PATH,
	ImportRefusedError,
	commitProjectImport
} from './project-import-transaction.js';

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
const json = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`;

const OWNER = 'ada';
const REPOSITORY = 'atlas';
/** The Remote the destination Workspace is bound to, throughout. */
const BOUND: RemoteRepository = { owner: OWNER, repository: REPOSITORY, branch: 'main' };

/** The Project directory every own-Remote question in this suite is about. */
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

/** The Project as the Remote holds it: `<directory>/…`, which is how a Workspace holds one too. */
const ON_REMOTE: Record<string, string> = {
	'README.md': '# Atlas\n',
	[`${SOURCE_DIRECTORY}/project.json`]: json(PROJECT),
	[`${SOURCE_DIRECTORY}/annotations/warehouses.geojson`]:
		'{"type":"FeatureCollection","features":[]}'
};

/** A GitHub origin, as `readRemoteProjectSource` observes one. */
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

/** A Project Bundle origin. It carries no repository, which is the whole of its evidence. */
const BUNDLE_ORIGIN: ProjectImportOrigin = {
	kind: 'project-bundle',
	fileName: 'amsterdam-1625.project.tar',
	projectName: PROJECT.name
};

const baselineHolding = (paths: readonly string[]): SynchronizationBaseline => ({
	remote: BOUND,
	commit: 'baseline-commit',
	files: new Map(paths.map((path) => [path, 'sha']))
});

/** A `fetch` that fails the test if anything asks it for anything. */
const noRequests = (): typeof fetch => () => {
	throw new Error('nothing should have been asked of GitHub');
};

/** The evidence, as {@link readImportEvidence} answers it, with the paths made assertable. */
async function evidenceOf(
	origin: ProjectImportOrigin,
	workspace: ImportIntoWorkspace
): Promise<{ remote: string[]; baseline: string[] }> {
	const evidence = await readImportEvidence(origin, workspace);
	return { remote: [...(evidence.remote ?? [])].sort(), baseline: [...(evidence.baseline ?? [])] };
}

/** The refusal `work` raised, or a failure saying it raised nothing. */
async function refusal(work: () => Promise<unknown>): Promise<ImportRefusedError> {
	try {
		await work();
	} catch (cause) {
		expect(cause).toBeInstanceOf(ImportRefusedError);
		return cause as ImportRefusedError;
	}
	throw new Error('the Import was not refused');
}

describe('the evidence an Import into a bound Workspace allocates against', () => {
	it('takes the current Remote tree and the valid Baseline', async () => {
		const github = await createFakeGitHub({
			owner: OWNER,
			repository: REPOSITORY,
			tree: ON_REMOTE
		});
		expect(
			await evidenceOf(BUNDLE_ORIGIN, {
				remote: BOUND,
				baseline: baselineHolding(['boston-1775/project.json']),
				local: [],
				token: null,
				fetch: github.fetch
			})
		).toEqual({
			remote: [
				'README.md',
				`${SOURCE_DIRECTORY}/annotations/warehouses.geojson`,
				`${SOURCE_DIRECTORY}/project.json`
			],
			baseline: ['boston-1775/project.json']
		});
	});

	it('asks GitHub nothing for an unbound Workspace, and offers no evidence of either kind', async () => {
		expect(
			await evidenceOf(BUNDLE_ORIGIN, { remote: null, local: [], fetch: noRequests() })
		).toEqual({ remote: [], baseline: [] });
	});

	it('offers no Baseline evidence where there is no valid Baseline', async () => {
		const github = await createFakeGitHub({
			owner: OWNER,
			repository: REPOSITORY,
			tree: ON_REMOTE
		});
		const evidence = await readImportEvidence(BUNDLE_ORIGIN, {
			remote: BOUND,
			baseline: null,
			local: [],
			token: null,
			fetch: github.fetch
		});
		expect(evidence.baseline).toBeUndefined();
	});

	it('reserves a Project directory that only the Remote has', async () => {
		const github = await createFakeGitHub({
			owner: OWNER,
			repository: REPOSITORY,
			tree: ON_REMOTE
		});
		const evidence = await readImportEvidence(BUNDLE_ORIGIN, {
			remote: BOUND,
			local: [],
			token: null,
			fetch: github.fetch
		});
		const allocation = allocateProjectImport(await closure(), evidence);
		expect(allocation.directory).toBe(`${SOURCE_DIRECTORY}-2`);
	});
});

describe('a bound Workspace whose Remote cannot be inventoried', () => {
	it('refuses a truncated listing, naming the repository and adding nothing', async () => {
		const github = await createFakeGitHub({
			owner: OWNER,
			repository: REPOSITORY,
			tree: ON_REMOTE
		});
		github.truncateAfter = 1;
		const refused = await refusal(() =>
			readImportEvidence(BUNDLE_ORIGIN, {
				remote: BOUND,
				local: [],
				token: null,
				fetch: github.fetch
			})
		);
		expect(refused.refusal).toBe('remote-unavailable');
		expect(refused.message).toContain(`${OWNER}/${REPOSITORY}`);
		expect(refused.message).toContain('Nothing has been added to your Workspace.');
	});

	it('refuses a host that cannot be reached', async () => {
		const refused = await refusal(() =>
			readImportEvidence(BUNDLE_ORIGIN, {
				remote: BOUND,
				local: [],
				token: null,
				fetch: () => Promise.reject(new Error('offline'))
			})
		);
		expect(refused.refusal).toBe('remote-unavailable');
	});

	it('refuses a repository this reader cannot see', async () => {
		const github = await createFakeGitHub({ owner: OWNER, repository: 'elsewhere', tree: {} });
		const refused = await refusal(() =>
			readImportEvidence(BUNDLE_ORIGIN, {
				remote: BOUND,
				local: [],
				token: null,
				fetch: github.fetch
			})
		);
		expect(refused.refusal).toBe('remote-unavailable');
	});

	it('reads a repository with no commits as an empty Remote rather than a refusal', async () => {
		const github = await createFakeGitHub({ owner: OWNER, repository: REPOSITORY });
		expect(
			await evidenceOf(BUNDLE_ORIGIN, {
				remote: BOUND,
				local: [],
				token: null,
				fetch: github.fetch
			})
		).toEqual({ remote: [], baseline: [] });
	});
});

describe('Importing the Workspace’s own Remote Project', () => {
	/** The Workspace's own Remote holds the Project, and so does the Workspace. */
	const synchronized = {
		remote: BOUND,
		local: [`${SOURCE_DIRECTORY}/project.json`],
		remotePaths: Object.keys(ON_REMOTE)
	};

	it('is refused, and names the Project the author already has', () => {
		const refused = (() => {
			try {
				assertNotOwnRemote({ origin: githubOrigin(), ...synchronized });
			} catch (cause) {
				return cause as ImportRefusedError;
			}
			throw new Error('the Import was not refused');
		})();
		expect(refused).toBeInstanceOf(ImportRefusedError);
		expect(refused.refusal).toBe('own-remote');
		expect(refused.message).toContain(PROJECT.name);
		expect(refused.message).toContain('already in this Workspace');
		expect(refused.message).toContain('Nothing has been added to your Workspace.');
		// The one remedy this refusal may never offer.
		expect(refused.message).not.toMatch(/anyway|second copy of your own|Import it as/i);
	});

	it('directs the author to Sync when only the Remote has the Project', () => {
		const refused = ownRemoteRefusal({
			origin: githubOrigin(),
			remote: BOUND,
			local: [],
			remotePaths: Object.keys(ON_REMOTE)
		});
		expect(refused.refusal).toBe('own-remote');
		expect(refused.message).toContain('Use Sync');
	});

	it('names the local Project rather than Sync when the Workspace holds it', () => {
		expect(ownRemoteRefusal({ origin: githubOrigin(), ...synchronized }).message).not.toContain(
			'Use Sync'
		);
	});

	it('recognises the Project directory the Baseline alone still records', () => {
		expect(
			ownRemoteRefusal({
				origin: githubOrigin(),
				remote: BOUND,
				local: [],
				remotePaths: [],
				baselinePaths: [`${SOURCE_DIRECTORY}/project.json`]
			}).refusal
		).toBe('own-remote');
	});

	it('compares the repository as GitHub does, so case is not a different Remote', () => {
		expect(
			ownRemoteRefusal({
				origin: githubOrigin({ owner: 'Ada', repository: 'Atlas' }),
				...synchronized
			}).refusal
		).toBe('own-remote');
	});

	const allowed: readonly { readonly what: string; readonly check: ImportCheck }[] = [
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
			check: { origin: BUNDLE_ORIGIN, ...synchronized }
		},
		{
			what: 'a Review Workspace, for the same reason',
			check: {
				origin: { kind: 'review', projectName: PROJECT.name, directory: SOURCE_DIRECTORY },
				...synchronized
			}
		}
	];

	for (const { what, check } of allowed) {
		it(`treats ${what} as an ordinary Import`, () => {
			expect(() => assertNotOwnRemote(check)).not.toThrow();
		});
	}

	it('is refused by the reader that fetches the inventory, after the inventory is had', async () => {
		const github = await createFakeGitHub({
			owner: OWNER,
			repository: REPOSITORY,
			tree: ON_REMOTE
		});
		const refused = await refusal(() =>
			readImportEvidence(githubOrigin(), {
				remote: BOUND,
				local: [],
				token: null,
				fetch: github.fetch
			})
		);
		expect(refused.refusal).toBe('own-remote');
	});

	it('is not reached at all by a Remote that could not be listed', async () => {
		const github = await createFakeGitHub({
			owner: OWNER,
			repository: REPOSITORY,
			tree: ON_REMOTE
		});
		github.truncateAfter = 1;
		const refused = await refusal(() =>
			readImportEvidence(githubOrigin(), {
				remote: BOUND,
				local: [],
				token: null,
				fetch: github.fetch
			})
		);
		expect(refused.refusal).toBe('remote-unavailable');
	});
});

describe('what a refusal leaves behind', () => {
	/** The Workspace, the Baseline and the Remote, as three snapshots that must not move. */
	async function snapshots(
		store: MemoryProjectStore,
		github: Awaited<ReturnType<typeof createFakeGitHub>>,
		baseline: SynchronizationBaseline
	) {
		const workspace: Record<string, string> = {};
		for (const path of await store.list('')) {
			workspace[path] = new TextDecoder().decode(await store.read(path as StorePath));
		}
		return {
			workspace,
			baseline: [...baseline.files].sort(),
			remote: await github.files('main')
		};
	}

	/**
	 * Run an Import the way the editor runs one, and refuse where the editor would.
	 *
	 * The order is the claim: the evidence is read *before* the allocation, so a refusal from it
	 * cannot have reached {@link commitProjectImport} and therefore cannot have written the marker.
	 */
	async function importInto(
		store: MemoryProjectStore,
		workspace: ImportIntoWorkspace,
		origin: ProjectImportOrigin
	): Promise<void> {
		const source = await closure(origin);
		const evidence = await readImportEvidence(origin, workspace);
		const plan = await remapProjectImport(source);
		const allocation = allocateProjectImport(plan.closure, {
			...evidence,
			local: await store.list('')
		});
		await commitProjectImport(store, plan.closure, allocation.destinations);
	}

	/** A Workspace already holding the synchronized Project, as a bound one would. */
	async function boundWorkspace(): Promise<MemoryProjectStore> {
		const store = new MemoryProjectStore();
		for (const [path, text] of Object.entries(ON_REMOTE)) {
			if (path === 'README.md') continue;
			await store.write(path as StorePath, encode(text));
		}
		return store;
	}

	it('is unchanged on all three sides after an own-Remote refusal', async () => {
		const github = await createFakeGitHub({
			owner: OWNER,
			repository: REPOSITORY,
			tree: ON_REMOTE
		});
		const store = await boundWorkspace();
		const baseline = baselineHolding(Object.keys(ON_REMOTE));
		const before = await snapshots(store, github, baseline);

		const refused = await refusal(() =>
			importInto(
				store,
				{ remote: BOUND, baseline, local: [], token: null, fetch: github.fetch },
				githubOrigin()
			)
		);
		expect(refused.refusal).toBe('own-remote');
		expect(await snapshots(store, github, baseline)).toEqual(before);
		await expect(store.read(IMPORT_TRANSACTION_PATH)).rejects.toThrow();
	});

	it('is unchanged on all three sides after an inventory refusal', async () => {
		const github = await createFakeGitHub({
			owner: OWNER,
			repository: REPOSITORY,
			tree: ON_REMOTE
		});
		const store = await boundWorkspace();
		const baseline = baselineHolding(Object.keys(ON_REMOTE));
		const before = await snapshots(store, github, baseline);
		github.truncateAfter = 1;

		const refused = await refusal(() =>
			importInto(
				store,
				{ remote: BOUND, baseline, local: [], token: null, fetch: github.fetch },
				BUNDLE_ORIGIN
			)
		);
		expect(refused.refusal).toBe('remote-unavailable');
		github.truncateAfter = null;
		expect(await snapshots(store, github, baseline)).toEqual(before);
	});

	it('adds the Project beside the synchronized one when the Import is somebody else’s work', async () => {
		const github = await createFakeGitHub({
			owner: OWNER,
			repository: REPOSITORY,
			tree: ON_REMOTE
		});
		const store = await boundWorkspace();
		const baseline = baselineHolding(Object.keys(ON_REMOTE));

		await importInto(
			store,
			{ remote: BOUND, baseline, local: [], token: null, fetch: github.fetch },
			BUNDLE_ORIGIN
		);

		// ⚠ The imported Project is *beside* the synchronized one, at a directory the Remote's own
		// inventory reserved — and the Baseline has not moved, so every path it wrote is local work.
		expect(await store.list('')).toContain(`${SOURCE_DIRECTORY}-2/project.json`);
		expect(await store.list('')).toContain(`${SOURCE_DIRECTORY}/project.json`);
		expect([...baseline.files.keys()]).not.toContain(`${SOURCE_DIRECTORY}-2/project.json`);
		expect(Object.keys(await github.files('main'))).not.toContain(
			`${SOURCE_DIRECTORY}-2/project.json`
		);
	});
});

/** What {@link assertNotOwnRemote} is asked, as this suite's tables spell it. */
type ImportCheck = Parameters<typeof assertNotOwnRemote>[0];

/** The refusal `check` raises, or a failure saying it raised none. */
function ownRemoteRefusal(check: ImportCheck): ImportRefusedError {
	try {
		assertNotOwnRemote(check);
	} catch (cause) {
		expect(cause).toBeInstanceOf(ImportRefusedError);
		return cause as ImportRefusedError;
	}
	throw new Error('the Import was not refused');
}

/** The incoming Project as a validated closure, from whichever origin is being tested. */
async function closure(origin: ProjectImportOrigin = BUNDLE_ORIGIN): Promise<ProjectImportSource> {
	const files: Record<ClosurePath, string> = {
		'project.json': json(PROJECT),
		'annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}'
	};
	const projectFileBytes = encode(files['project.json'] as string);
	return createProjectImportSource({
		origin,
		project: parseProjectFile(projectFileBytes),
		projectFileBytes,
		offered: Object.entries(files).map(([path, text]) => ({
			path,
			bytes: encode(text).byteLength
		})),
		files: async function* (paths: readonly ClosurePath[]): AsyncIterable<ClosureFile> {
			for (const path of paths) yield { path, bytes: encode(files[path] as string) };
		}
	});
}

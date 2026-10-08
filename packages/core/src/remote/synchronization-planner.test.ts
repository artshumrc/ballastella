import { describe, expect, it } from 'vitest';

import { newAnnotationLayer, newMapLayer } from '../project/layer.js';
import { newProjectFile, serialiseProjectFile } from '../project/project-file.js';
import { ManagedProjectStore } from '../store/managed-project-store.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { encode } from '../test-support.js';
import { gitBlobSha } from './blob-sha.js';
import { FakeMetadataStorage } from './fake-metadata-storage.js';
import { checkSourceStatus } from './local-change-index.js';
import { createFakeGitHub } from './fake-github.js';
import { ATLAS as REMOTE, baselineWith, changeIndex, inventory } from './remote-test-support.js';
import {
	comparePath,
	compareWorkspace,
	describeGraphViolations,
	planWorkspaceSync,
	type PathComparison,
	type SourceStatus,
	type SynchronizationInput,
	type WorkspaceComparison
} from './synchronization-planner.js';

const SHA = {
	a: 'a'.repeat(40),
	b: 'b'.repeat(40),
	c: 'c'.repeat(40)
} as const;

type Files = Readonly<Record<string, string>>;
const entries = (files: Files) => Object.entries(files).map(([path, sha]) => ({ path, sha }));

const input = (
	local: Files,
	remote: Files,
	baseline: Files | null,
	projects?: readonly { readonly sha: string; readonly bytes: Uint8Array }[]
): SynchronizationInput => ({
	local: entries(local),
	remote: entries(remote),
	baseline: baseline === null ? null : baselineWith(Object.entries(baseline)),
	...(projects === undefined
		? {}
		: { projectFiles: new Map(projects.map(({ sha, bytes }) => [sha, bytes])) })
});

const plan = (...args: Parameters<typeof input>) => planWorkspaceSync(input(...args));

const PROJECT = 'amsterdam-1625/project.json';
const INFO = 'images/map-1/info.json';

describe('comparePath', () => {
	const cases: readonly (readonly [
		PathComparison,
		string | null,
		string | null,
		string | null,
		string
	])[] = [
		['shared', SHA.a, SHA.a, SHA.a, 'untouched on both sides'],
		['shared', null, null, null, 'a path nothing holds'],
		['outbound', SHA.a, SHA.b, SHA.a, 'edited here only'],
		['outbound', null, SHA.a, null, 'added here only'],
		['outbound', SHA.a, null, SHA.a, 'deleted here only'],
		['inbound', SHA.a, SHA.a, SHA.b, 'edited on the Remote only'],
		['inbound', null, null, SHA.a, 'added on the Remote only'],
		['inbound', SHA.a, SHA.a, null, 'deleted on the Remote only'],
		['converged', SHA.a, SHA.b, SHA.b, 'the same edit on both sides'],
		['converged', null, SHA.a, SHA.a, 'the same addition on both sides'],
		['converged', SHA.a, null, null, 'deleted on both sides'],
		['conflict', SHA.a, SHA.b, SHA.c, 'edited differently on both sides'],
		['conflict', null, SHA.a, SHA.b, 'added differently on both sides'],
		['conflict', SHA.a, SHA.b, null, 'edited here and deleted there'],
		['conflict', SHA.a, null, SHA.b, 'deleted here and edited there']
	];

	for (const [expected, baseline, local, remote, what] of cases) {
		it(`calls B=${baseline?.[0] ?? '-'} L=${local?.[0] ?? '-'} R=${remote?.[0] ?? '-'} ${expected} — ${what}`, () => {
			expect(comparePath(baseline, local, remote)).toBe(expected);
		});
	}
});

describe('compareWorkspace', () => {
	const status = (local: Files, remote: Files, baseline: Files | null): SourceStatus =>
		compareWorkspace(input(local, remote, baseline)).status;

	it('reports In sync when every source path matches the Baseline', () => {
		const files = { [PROJECT]: SHA.a, [INFO]: SHA.b };
		expect(status(files, files, files)).toBe('in-sync');
	});

	const LEIDEN = 'leiden-1640/project.json';
	it.each([
		['In sync when both sides made the same change', SHA.b, SHA.b, 'in-sync'],
		['Changes to send for a local-only change', SHA.b, SHA.a, 'changes-to-send'],
		['Changes to get for a Remote-only change', SHA.a, SHA.b, 'changes-to-get'],
		[
			'Changes both ways for one path changed differently on both sides',
			SHA.b,
			SHA.c,
			'changes-both-ways'
		]
	] as const)('reports %s', (_, local, remote, expected) => {
		expect(status({ [PROJECT]: local }, { [PROJECT]: remote }, { [PROJECT]: SHA.a })).toBe(
			expected
		);
	});

	it('reports Changes both ways for safe changes at different paths', () => {
		expect(
			status(
				{ [PROJECT]: SHA.b, [LEIDEN]: SHA.a },
				{ [PROJECT]: SHA.a, [LEIDEN]: SHA.b },
				{ [PROJECT]: SHA.a, [LEIDEN]: SHA.a }
			)
		).toBe('changes-both-ways');
	});

	it('reports Cannot tell with no valid Baseline, however the two sides look', () => {
		const files = { [PROJECT]: SHA.a };
		expect([
			status(files, files, null),
			status(files, { [PROJECT]: SHA.b }, null),
			status({}, {}, null)
		]).toEqual(['cannot-tell', 'cannot-tell', 'cannot-tell']);
	});

	it('names every path in the union of the three inventories, sorted, Project directories from any side', () => {
		const comparison = compareWorkspace(
			input(
				{ [PROJECT]: SHA.a },
				{ [LEIDEN]: SHA.a, 'leiden-1640/annotations/notes.geojson': SHA.b },
				{ 'utrecht-1700/project.json': SHA.a, 'utrecht-1700/annotations/old.geojson': SHA.b }
			)
		);
		expect(comparison.paths.map((path) => path.path)).toEqual([
			PROJECT,
			'leiden-1640/annotations/notes.geojson',
			LEIDEN,
			'utrecht-1700/annotations/old.geojson',
			'utrecht-1700/project.json'
		]);
	});

	it('leaves files outside Ballastella’s namespace out of the comparison entirely', () => {
		const comparison = compareWorkspace(
			input(
				{ [PROJECT]: SHA.a, 'README.md': SHA.a },
				{ [PROJECT]: SHA.a, 'README.md': SHA.c, CNAME: SHA.b },
				{ [PROJECT]: SHA.a, 'README.md': SHA.a }
			)
		);
		expect([comparison.paths.map((path) => path.path), comparison.status]).toEqual([
			[PROJECT],
			'in-sync'
		]);
	});

	it('reports generated-output difference as Published Site staleness, not source drift', () => {
		const comparison = compareWorkspace(
			input(
				{ [PROJECT]: SHA.a, '_app/immutable/entry/app.new.js': SHA.a },
				{ [PROJECT]: SHA.a, '_app/immutable/entry/app.old.js': SHA.b },
				{ [PROJECT]: SHA.a }
			)
		);
		expect(comparison.status).toBe('in-sync');
		expect(comparison.publishedSiteStale).toEqual([
			'_app/immutable/entry/app.new.js',
			'_app/immutable/entry/app.old.js'
		]);
		const agreeing = { [PROJECT]: SHA.a, 'index.html': SHA.b };
		expect(compareWorkspace(input(agreeing, agreeing, agreeing)).publishedSiteStale).toEqual([]);
	});
});

const projectFile = async (
	name: string,
	layers: Parameters<typeof serialiseProjectFile>[0]['layers']
) => {
	const bytes = serialiseProjectFile({ ...newProjectFile(name, new Date('2026-01-01')), layers });
	return { bytes, sha: await gitBlobSha(bytes) };
};

const MAPPED = await projectFile('Amsterdam', [
	newMapLayer({ id: 'l1', name: 'The sheet', imageId: 'map-1' })
]);
const ANNOTATED = await projectFile('Amsterdam', [newAnnotationLayer({ id: 'l1', name: 'Notes' })]);
const EMPTY = await projectFile('Amsterdam', []);
const MISSING_IMAGE = input(
	{ [PROJECT]: MAPPED.sha, [INFO]: SHA.a },
	{ [PROJECT]: SHA.b },
	{ [PROJECT]: SHA.b, [INFO]: SHA.a },
	[MAPPED]
);

describe('prospective graph validation', () => {
	const annotated = { [PROJECT]: SHA.b, 'amsterdam-1625/annotations/l1.geojson': SHA.a };
	const projectless = { [PROJECT]: SHA.a, 'amsterdam-1625/annotations/notes.geojson': SHA.a };
	it.each([
		[
			'two individually safe changes leave a Layer’s Map Image missing',
			'missing-image',
			MISSING_IMAGE
		],
		[
			'a Layer’s Annotation is missing from the prospective result',
			'missing-annotation',
			input({ [PROJECT]: ANNOTATED.sha }, annotated, annotated, [ANNOTATED])
		],
		[
			'the prospective result holds a Project’s files but no project.json',
			'missing-project-file',
			input({ 'amsterdam-1625/annotations/notes.geojson': SHA.b }, projectless, projectless, [])
		],
		[
			'an Alignment outlives the Map Image it places',
			'orphan-alignment',
			input(
				{ [PROJECT]: EMPTY.sha, 'alignments/map-1.json': SHA.b },
				{ [PROJECT]: EMPTY.sha },
				{ [PROJECT]: EMPTY.sha, [INFO]: SHA.a },
				[EMPTY]
			)
		],
		[
			'a prospective Map Image is a heap of tiles nothing can open',
			'incomplete-image',
			input(
				{ [PROJECT]: MAPPED.sha, [INFO]: SHA.a, 'images/map-1/0/0/0.jpg': SHA.b },
				{ [PROJECT]: MAPPED.sha },
				{ [PROJECT]: MAPPED.sha, [INFO]: SHA.a },
				[MAPPED]
			)
		]
	])('refuses when %s', (_, kind, given) => {
		const { graph } = compareWorkspace(given);
		if (graph.outcome !== 'invalid') throw new Error('expected an invalid graph');
		expect(graph.violations.map((violation) => violation.kind)).toEqual([kind]);
	});

	it('accepts an Alignment beside its Map Image, and a Map Image with no Alignment', () => {
		const files = { [PROJECT]: MAPPED.sha, [INFO]: SHA.a };
		const aligned = compareWorkspace(
			input({ ...files, 'alignments/map-1.json': SHA.b }, files, files, [MAPPED])
		);
		const unplaced = compareWorkspace(input(files, files, files, [MAPPED]));
		expect([aligned.graph.outcome, aligned.status]).toEqual(['valid', 'changes-to-send']);
		expect([unplaced.graph.outcome, unplaced.status]).toEqual(['valid', 'in-sync']);
	});

	const failures = (comparison: WorkspaceComparison) => {
		if (comparison.graph.outcome !== 'failed') throw new Error('expected an operation failure');
		return comparison.graph.failures.map((failure) => failure.kind);
	};

	it.each([
		['a Remote project.json will not parse', 'malformed', '{ not json'],
		[
			'a Remote project.json is from a newer format',
			'unsupported',
			JSON.stringify({ formatVersion: 99, name: 'Later', layers: [] })
		],
		['the bytes of a chosen project.json were never supplied', 'unreadable', null]
	])('is an operation failure, not a violation, when %s', async (_, kind, text) => {
		const bytes = encode(text ?? '');
		const sha = text === null ? SHA.b : await gitBlobSha(bytes);
		const comparison = compareWorkspace(
			input(
				{ [PROJECT]: SHA.a },
				{ [PROJECT]: sha },
				{ [PROJECT]: SHA.a },
				text === null ? [] : [{ sha, bytes }]
			)
		);
		expect(failures(comparison)).toEqual([kind]);
		expect(comparison.status).not.toBe('in-sync');
	});

	it('does not check the graph at all when no validation material is offered', () => {
		const comparison = compareWorkspace(
			input({ [PROJECT]: SHA.b }, { [PROJECT]: SHA.a }, { [PROJECT]: SHA.a })
		);
		expect([comparison.graph.outcome, comparison.status]).toEqual([
			'not-checked',
			'changes-to-send'
		]);
	});
});

describe('planWorkspaceSync', () => {
	it('takes Remote-only additions, replacements and deletions into the Workspace', () => {
		const result = plan(
			{ 'a/project.json': SHA.a, 'a/annotations/keep.geojson': SHA.a, 'a/gone.geojson': SHA.a },
			{ 'a/project.json': SHA.b, 'a/annotations/keep.geojson': SHA.a, 'a/new.geojson': SHA.c },
			{ 'a/project.json': SHA.a, 'a/annotations/keep.geojson': SHA.a, 'a/gone.geojson': SHA.a }
		);
		expect(result.toGet.changes).toEqual([
			{ path: 'a/gone.geojson', sha: null, effect: 'delete' },
			{ path: 'a/new.geojson', sha: SHA.c, effect: 'add' },
			{ path: 'a/project.json', sha: SHA.b, effect: 'replace' }
		]);
		expect(result.toGet.removed).toEqual(['a/gone.geojson']);
	});

	it('sends every local source path as the new Baseline and preserves what is outside the namespace', () => {
		const result = plan(
			{ 'a/project.json': SHA.b, [INFO]: SHA.a },
			{ 'a/project.json': SHA.a, 'README.md': SHA.c, CNAME: SHA.c },
			{ 'a/project.json': SHA.a }
		);
		expect(result.toSend.changes).toEqual([
			{ path: 'a/project.json', sha: SHA.b, effect: 'replace' },
			{ path: INFO, sha: SHA.a, effect: 'add' }
		]);
		expect(result.preserved).toEqual(['CNAME', 'README.md']);
		expect([...result.toSend.advances].sort()).toEqual([
			['a/project.json', SHA.b],
			[INFO, SHA.a]
		]);
	});

	it('retains local-only changes at other paths and does not advance them on a get', () => {
		const result = plan(
			{ 'a/project.json': SHA.b, 'b/project.json': SHA.a },
			{ 'a/project.json': SHA.a, 'b/project.json': SHA.b },
			{ 'a/project.json': SHA.a, 'b/project.json': SHA.a }
		);
		expect(result.toGet.changes).toEqual([
			{ path: 'b/project.json', sha: SHA.b, effect: 'replace' }
		]);
		expect(result.retained).toEqual(['a/project.json']);
		expect([...result.toGet.advances]).toEqual([['b/project.json', SHA.b]]);
	});

	it('advances a get’s Baseline for inbound, shared and converged paths only', () => {
		const side = (inbound: string, both: string, outbound: string) => ({
			'a/project.json': SHA.a,
			'a/in.geojson': inbound,
			'a/both.geojson': both,
			'a/out.geojson': outbound
		});
		const result = plan(
			side(SHA.a, SHA.b, SHA.b),
			side(SHA.b, SHA.b, SHA.a),
			side(SHA.a, SHA.a, SHA.a)
		);
		expect([...result.toGet.advances].sort()).toEqual([
			['a/both.geojson', SHA.b],
			['a/in.geojson', SHA.b],
			['a/project.json', SHA.a]
		]);
		expect(result.toGet.retires).toEqual([]);
	});

	it('retires from the Baseline a path both sides no longer hold', () => {
		const result = plan(
			{ 'a/project.json': SHA.a },
			{ 'a/project.json': SHA.a },
			{ 'a/project.json': SHA.a, 'a/dropped.geojson': SHA.b }
		);
		expect(result.toGet.retires).toEqual(['a/dropped.geojson']);
	});

	it('reports a Conflict rather than refusing, and settles it in neither direction', () => {
		const result = plan(
			{ 'a/project.json': SHA.b },
			{ 'a/project.json': SHA.c },
			{ 'a/project.json': SHA.a }
		);
		expect(result.conflicts.map((row) => row.path)).toEqual(['a/project.json']);
		expect([result.toGet.changes, result.toSend.changes, result.toSend.removed]).toEqual([
			[],
			[],
			[]
		]);
	});

	it('never chooses generated Published Site output in either direction', () => {
		const result = plan(
			{ 'a/project.json': SHA.a },
			{ 'a/project.json': SHA.a, '_app/immutable/entry/app.old.js': SHA.b, 'index.html': SHA.c },
			{ 'a/project.json': SHA.a }
		);
		expect([result.toGet.changes, result.toSend.removed]).toEqual([[], []]);
	});

	it('reports a prospective Workspace that would not open as a broken graph', () => {
		const { graph } = planWorkspaceSync(MISSING_IMAGE).comparison;
		if (graph.outcome !== 'invalid') throw new Error('expected an invalid graph');
		expect(describeGraphViolations(graph.violations)).toContain('images/map-1');
	});

	it('reports an unreadable Remote as a failure rather than as changed scholarship', () => {
		const result = plan(
			{ 'a/project.json': SHA.a },
			{ 'a/project.json': SHA.b },
			{ 'a/project.json': SHA.a },
			[]
		);
		expect([result.comparison.graph.outcome, result.conflicts]).toEqual(['failed', []]);
	});
});

describe('what a send may remove', () => {
	it('removes an owned Remote source path the Baseline recorded and the Workspace has lost', () => {
		const both = { 'a/project.json': SHA.a, 'b/project.json': SHA.a };
		const result = plan({ 'a/project.json': SHA.a }, both, both);
		expect([result.toSend.removed, result.leftAlone]).toEqual([['b/project.json'], []]);
	});

	it('leaves alone a Remote path the Baseline never recorded, and offers it to get instead', () => {
		const result = plan(
			{ 'a/project.json': SHA.a },
			{ 'a/project.json': SHA.a, 'florida-1657/project.json': SHA.b },
			{ 'a/project.json': SHA.a }
		);
		expect([result.toSend.removed, result.leftAlone]).toEqual([[], ['florida-1657/project.json']]);
		expect(result.toGet.changes).toEqual([
			{ path: 'florida-1657/project.json', sha: SHA.b, effect: 'add' }
		]);
	});

	it('removes nothing in either direction with no Baseline at all', () => {
		const result = plan(
			{ 'a/project.json': SHA.a },
			{ 'b/project.json': SHA.b, 'c/project.json': SHA.c },
			null
		);
		expect([result.toSend.removed, result.toGet.removed]).toEqual([[], []]);
		expect(result.toGet.changes.map((choice) => choice.path)).toEqual([
			'b/project.json',
			'c/project.json'
		]);
		expect(result.leftAlone).toEqual(['b/project.json', 'c/project.json']);
		expect(result.comparison.status).toBe('cannot-tell');
	});

	it('is a Conflict, not a removal, where a Remote path this Workspace changed has gone', () => {
		const result = plan({ 'a/project.json': SHA.b }, {}, { 'a/project.json': SHA.a });
		expect(result.conflicts.map((row) => row.path)).toEqual(['a/project.json']);
		expect(result.toGet.removed).toEqual([]);
	});

	it('names what an overwrite would take down, from the Workspace alone', () => {
		const result = plan(
			{ 'a/project.json': SHA.a },
			{ 'a/project.json': SHA.c, 'florida-1657/project.json': SHA.b, 'README.md': SHA.c },
			null
		);
		expect([result.toOverwrite.removed, result.preserved]).toEqual([
			['florida-1657/project.json'],
			['README.md']
		]);
	});
});

describe('planning without a Baseline', () => {
	it('has nothing to do where the two source namespaces are byte-for-byte equal', () => {
		const files = { 'a/project.json': SHA.a, [INFO]: SHA.b };
		const result = plan(files, files, null);
		expect(result.toGet.changes).toEqual([]);
		expect(result.toSend.changes.every((choice) => choice.effect === 'keep')).toBe(true);
		expect([...result.toGet.advances].sort()).toEqual([
			['a/project.json', SHA.a],
			[INFO, SHA.b]
		]);
	});

	it('brings a whole Remote into a Workspace that holds no source at all', () => {
		expect(plan({}, { 'a/project.json': SHA.a }, null).toGet.changes).toEqual([
			{ path: 'a/project.json', sha: SHA.a, effect: 'add' }
		]);
	});

	it('has nothing to get where the Remote holds no source at all', () => {
		const result = plan({ 'a/project.json': SHA.a }, { 'README.md': SHA.b }, null);
		expect([result.toGet.changes, [...result.toGet.advances], result.preserved]).toEqual([
			[],
			[],
			['README.md']
		]);
	});

	it.each([
		[
			'reports a broken graph from a Remote whose Project names a Map Image it does not hold',
			{},
			'invalid'
		],
		['accepts a Remote that is a whole Workspace', { [INFO]: SHA.a }, 'valid']
	])('%s', (_, images, outcome) => {
		const result = plan({}, { [PROJECT]: MAPPED.sha, ...images }, null, [MAPPED]);
		expect(result.comparison.graph.outcome).toBe(outcome);
	});

	it('reports differing non-empty sides as a Conflict', () => {
		const result = plan({ 'a/project.json': SHA.a }, { 'a/project.json': SHA.b }, null);
		expect(result.conflicts.map((row) => row.path)).toEqual(['a/project.json']);
	});
});

describe('deliberate planning hashes the whole Workspace', () => {
	it('finds a chosen-folder edit that never reached the write index, and changes the plan', async () => {
		const store = new MemoryProjectStore();
		const managed = new ManagedProjectStore(
			store,
			changeIndex(new FakeMetadataStorage(), 'folder:maps')
		);
		await managed.write('a/project.json', encode('{"formatVersion":1,"name":"A","layers":[]}\n'));
		await managed.write('a/annotations/notes.geojson', encode('{"features":[]}\n'));

		const shared = await inventory(store);
		await managed.changes.clear();
		const baseline = baselineWith(shared.map((entry) => [entry.path, entry.sha]));

		const github = await createFakeGitHub({
			...REMOTE,
			tree: Object.fromEntries(store.snapshot())
		});
		await github.commitFiles({ 'a/annotations/notes.geojson': '{"features":[{"id":1}]}\n' });
		const remote = await inventory(github);

		await store.write('a/annotations/notes.geojson', encode('{"features":[{"id":2}]}\n'));

		const passive = await checkSourceStatus({ changes: managed, remote, baseline });
		expect([passive.status, passive.written]).toEqual(['changes-to-get', []]);
		const inbound = await gitBlobSha(encode('{"features":[{"id":1}]}\n'));
		const stale = planWorkspaceSync({ local: shared, remote, baseline });
		expect(stale.toGet.changes).toEqual([
			{ path: 'a/annotations/notes.geojson', sha: inbound, effect: 'replace' }
		]);

		const complete = planWorkspaceSync({ local: await inventory(store), remote, baseline });
		expect(complete.toGet.changes).toEqual([]);
		expect(complete.conflicts.map((row) => row.path)).toEqual(['a/annotations/notes.geojson']);
	});
});

import { describe, expect, it } from 'vitest';

import { newAnnotationLayer, newMapLayer } from '../project/layer.js';
import { newProjectFile, serialiseProjectFile } from '../project/project-file.js';
import { ManagedProjectStore } from '../store/managed-project-store.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import { gitBlobSha } from './blob-sha.js';
import { FakeMetadataStorage } from './fake-metadata-storage.js';
import { LocalChangeIndex, checkSourceStatus } from './local-change-index.js';
import { createFakeGitHub } from './fake-github.js';
import type { RemoteRepository } from './publish-to-remote.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';
import {
	comparePath,
	compareWorkspace,
	describeGraphViolations,
	planWorkspaceSync,
	type InventoryEntry,
	type PathComparison,
	type SourceStatus,
	type SynchronizationInput
} from './synchronization-planner.js';

// The planner has no I/O, so these fixtures are `path → blob SHA` maps and nothing else. Where a
// case is about the *inventory* rather than the arithmetic — a Workspace read completely, a Remote
// tree listed — it is built from a `MemoryProjectStore` or the fake GitHub, so that the paths and
// SHAs under test are ones those two really produce.

const REMOTE: RemoteRepository = { owner: 'ada', repository: 'atlas', branch: 'main' };

const encode = (text: string): Bytes => new TextEncoder().encode(text);

/** A distinct, stable blob SHA per marker, so a table row reads as `a` against `b`. */
const SHA = {
	a: 'a'.repeat(40),
	b: 'b'.repeat(40),
	c: 'c'.repeat(40)
} as const;

const entries = (files: Readonly<Record<string, string>>): InventoryEntry[] =>
	Object.entries(files).map(([path, sha]) => ({ path, sha }));

const baselineOf = (files: Readonly<Record<string, string>>): SynchronizationBaseline => ({
	remote: REMOTE,
	commit: 'c0ffee',
	files: new Map(Object.entries(files))
});

/** An input with no graph-validation material, for the cases that are only about the table. */
const input = (
	local: Readonly<Record<string, string>>,
	remote: Readonly<Record<string, string>>,
	baseline: Readonly<Record<string, string>> | null
): SynchronizationInput => ({
	local: entries(local),
	remote: entries(remote),
	baseline: baseline === null ? null : baselineOf(baseline)
});

// ── The per-path table ─────────────────────────────────────────────────────────────────────────

describe('comparePath', () => {
	// Baseline, local, Remote — `null` for absent, so an addition and a deletion are rows of the
	// same table rather than separate rules.
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

// ── The Workspace-level status ─────────────────────────────────────────────────────────────────

describe('compareWorkspace', () => {
	const status = (
		local: Readonly<Record<string, string>>,
		remote: Readonly<Record<string, string>>,
		baseline: Readonly<Record<string, string>> | null
	): SourceStatus => compareWorkspace(input(local, remote, baseline)).status;

	it('reports In sync when every source path matches the Baseline', () => {
		const files = { 'amsterdam-1625/project.json': SHA.a, 'images/map-1/info.json': SHA.b };
		expect(status(files, files, files)).toBe('in-sync');
	});

	it('reports In sync when both sides made the same change', () => {
		expect(
			status(
				{ 'amsterdam-1625/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a }
			)
		).toBe('in-sync');
	});

	it('reports Changes to send for a local-only change', () => {
		expect(
			status(
				{ 'amsterdam-1625/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a },
				{ 'amsterdam-1625/project.json': SHA.a }
			)
		).toBe('changes-to-send');
	});

	it('reports Changes to get for a Remote-only change', () => {
		expect(
			status(
				{ 'amsterdam-1625/project.json': SHA.a },
				{ 'amsterdam-1625/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a }
			)
		).toBe('changes-to-get');
	});

	it('reports Changes both ways for safe changes at different paths', () => {
		expect(
			status(
				{ 'amsterdam-1625/project.json': SHA.b, 'leiden-1640/project.json': SHA.a },
				{ 'amsterdam-1625/project.json': SHA.a, 'leiden-1640/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a, 'leiden-1640/project.json': SHA.a }
			)
		).toBe('changes-both-ways');
	});

	// ⚠ **A contested path is work outstanding in both directions, and not a state of its own**
	// (ADR-0046). There is something here GitHub has not got and something there this Workspace has
	// not got, which is exactly what `changes-both-ways` says.
	it('reports Changes both ways for one path changed differently on both sides', () => {
		expect(
			status(
				{ 'amsterdam-1625/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.c },
				{ 'amsterdam-1625/project.json': SHA.a }
			)
		).toBe('changes-both-ways');
	});

	it('reports Cannot tell with no valid Baseline, however the two sides look', () => {
		const files = { 'amsterdam-1625/project.json': SHA.a };
		expect(status(files, files, null)).toBe('cannot-tell');
		expect(status(files, { 'amsterdam-1625/project.json': SHA.b }, null)).toBe('cannot-tell');
		expect(status({}, {}, null)).toBe('cannot-tell');
	});

	it('names every path in the union of the three inventories, sorted', () => {
		const comparison = compareWorkspace(
			input(
				{ 'amsterdam-1625/project.json': SHA.a },
				{ 'leiden-1640/project.json': SHA.a },
				{ 'utrecht-1700/project.json': SHA.a }
			)
		);
		expect(comparison.paths.map((path) => path.path)).toEqual([
			'amsterdam-1625/project.json',
			'leiden-1640/project.json',
			'utrecht-1700/project.json'
		]);
	});

	it('recognises a Project directory from the Remote and the Baseline alone', () => {
		const comparison = compareWorkspace(
			input(
				{ 'amsterdam-1625/project.json': SHA.a },
				{ 'leiden-1640/project.json': SHA.a, 'leiden-1640/annotations/notes.geojson': SHA.b },
				{ 'utrecht-1700/project.json': SHA.a, 'utrecht-1700/annotations/old.geojson': SHA.b }
			)
		);
		// Both Annotations are source rather than somebody else's repository files, which is only
		// true because the Remote and the Baseline each recognised their directory.
		expect(comparison.paths.map((path) => path.path)).toContain(
			'leiden-1640/annotations/notes.geojson'
		);
		expect(comparison.paths.map((path) => path.path)).toContain(
			'utrecht-1700/annotations/old.geojson'
		);
	});

	it('leaves files outside Ballastella’s namespace out of the comparison entirely', () => {
		const comparison = compareWorkspace(
			input(
				{ 'amsterdam-1625/project.json': SHA.a, 'README.md': SHA.a },
				{ 'amsterdam-1625/project.json': SHA.a, 'README.md': SHA.c, CNAME: SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a, 'README.md': SHA.a }
			)
		);
		expect(comparison.paths.map((path) => path.path)).toEqual(['amsterdam-1625/project.json']);
		expect(comparison.status).toBe('in-sync');
	});

	// ── Published Site staleness ───────────────────────────────────────────────────────────────

	it('reports generated-output difference as Published Site staleness, not source drift', () => {
		const comparison = compareWorkspace(
			input(
				{ 'amsterdam-1625/project.json': SHA.a, '_app/immutable/entry/app.new.js': SHA.a },
				{ 'amsterdam-1625/project.json': SHA.a, '_app/immutable/entry/app.old.js': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a }
			)
		);
		expect(comparison.status).toBe('in-sync');
		expect(comparison.publishedSiteStale).toEqual([
			'_app/immutable/entry/app.new.js',
			'_app/immutable/entry/app.old.js'
		]);
	});

	it('reports no staleness when the two sides’ generated output agrees', () => {
		const files = { 'amsterdam-1625/project.json': SHA.a, 'index.html': SHA.b };
		expect(compareWorkspace(input(files, files, files)).publishedSiteStale).toEqual([]);
	});
});

// ── Prospective graph validation ───────────────────────────────────────────────────────────────

/** A `project.json` with the Layers given, and the blob SHA its bytes really have. */
const projectFile = async (
	name: string,
	layers: Parameters<typeof serialiseProjectFile>[0]['layers']
) => {
	const bytes = serialiseProjectFile({ ...newProjectFile(name, new Date('2026-01-01')), layers });
	return { bytes, sha: await gitBlobSha(bytes) };
};

const MAP_LAYER = [newMapLayer({ id: 'l1', name: 'The sheet', imageId: 'map-1' })];
const ANNOTATION_LAYER = [newAnnotationLayer({ id: 'l1', name: 'Notes' })];

describe('prospective graph validation', () => {
	it('refuses when two individually safe changes leave a Layer’s Map Image missing', async () => {
		const project = await projectFile('Amsterdam', MAP_LAYER);
		// Locally the map Layer is added; remotely the pyramid is deleted. Neither path changed on
		// both sides, and the combination is a Project that cannot draw.
		const comparison = compareWorkspace({
			local: entries({
				'amsterdam-1625/project.json': project.sha,
				'images/map-1/info.json': SHA.a
			}),
			remote: entries({ 'amsterdam-1625/project.json': SHA.b }),
			baseline: baselineOf({
				'amsterdam-1625/project.json': SHA.b,
				'images/map-1/info.json': SHA.a
			}),
			projectFiles: new Map([[project.sha, project.bytes]])
		});
		expect(comparison.graph.outcome).toBe('invalid');
		if (comparison.graph.outcome !== 'invalid') return;
		expect(comparison.graph.violations.map((violation) => violation.kind)).toEqual([
			'missing-image'
		]);
	});

	it('refuses when a Layer’s Annotation is missing from the prospective result', async () => {
		const project = await projectFile('Amsterdam', ANNOTATION_LAYER);
		const comparison = compareWorkspace({
			local: entries({ 'amsterdam-1625/project.json': project.sha }),
			remote: entries({
				'amsterdam-1625/project.json': SHA.b,
				'amsterdam-1625/annotations/l1.geojson': SHA.a
			}),
			baseline: baselineOf({
				'amsterdam-1625/project.json': SHA.b,
				'amsterdam-1625/annotations/l1.geojson': SHA.a
			}),
			// Locally the Annotation Layer was added and the Annotation deleted on the Remote.
			projectFiles: new Map([[project.sha, project.bytes]])
		});
		if (comparison.graph.outcome !== 'invalid') throw new Error('expected an invalid graph');
		expect(comparison.graph.violations.map((violation) => violation.kind)).toEqual([
			'missing-annotation'
		]);
	});

	it('refuses when the prospective result holds a Project’s files but no project.json', () => {
		const comparison = compareWorkspace({
			local: entries({ 'amsterdam-1625/annotations/notes.geojson': SHA.b }),
			remote: entries({
				'amsterdam-1625/project.json': SHA.a,
				'amsterdam-1625/annotations/notes.geojson': SHA.a
			}),
			baseline: baselineOf({
				'amsterdam-1625/project.json': SHA.a,
				'amsterdam-1625/annotations/notes.geojson': SHA.a
			}),
			projectFiles: new Map()
		});
		if (comparison.graph.outcome !== 'invalid') throw new Error('expected an invalid graph');
		expect(comparison.graph.violations.map((violation) => violation.kind)).toEqual([
			'missing-project-file'
		]);
	});

	it('refuses when an Alignment outlives the Map Image it places', async () => {
		const project = await projectFile('Amsterdam', MAP_LAYER);
		const comparison = compareWorkspace({
			local: entries({
				'amsterdam-1625/project.json': project.sha,
				'images/map-1/info.json': SHA.a,
				// alignment-write-is-the-fixture: an inventory entry, not bytes; the planner has no store
				'alignments/map-1.json': SHA.b
			}),
			remote: entries({
				'amsterdam-1625/project.json': project.sha,
				'images/map-1/info.json': SHA.a
			}),
			baseline: baselineOf({
				'amsterdam-1625/project.json': project.sha,
				'images/map-1/info.json': SHA.a
			}),
			projectFiles: new Map([[project.sha, project.bytes]])
		});
		// The Alignment alone is a local-only addition, so the graph is sound.
		expect(comparison.status).toBe('changes-to-send');
		expect(comparison.graph.outcome).toBe('valid');

		// A Project with no Layers at all, so the only thing left to object to is the Alignment.
		const empty = await projectFile('Amsterdam', []);
		const orphaned = compareWorkspace({
			local: entries({
				'amsterdam-1625/project.json': empty.sha,
				// alignment-write-is-the-fixture: an inventory entry, not bytes; the planner has no store
				'alignments/map-1.json': SHA.b
			}),
			remote: entries({ 'amsterdam-1625/project.json': empty.sha }),
			baseline: baselineOf({
				'amsterdam-1625/project.json': empty.sha,
				'images/map-1/info.json': SHA.a
			}),
			projectFiles: new Map([[empty.sha, empty.bytes]])
		});
		if (orphaned.graph.outcome !== 'invalid') throw new Error('expected an invalid graph');
		expect(orphaned.graph.violations.map((violation) => violation.kind)).toEqual([
			'orphan-alignment'
		]);
	});

	it('refuses when a prospective Map Image is a heap of tiles nothing can open', async () => {
		const project = await projectFile('Amsterdam', MAP_LAYER);
		// Remotely the `info.json` is deleted; locally a tile is added. Each is safe on its own, and
		// what is left is a directory no IIIF client can read (ADR-0023).
		const comparison = compareWorkspace({
			local: entries({
				'amsterdam-1625/project.json': project.sha,
				'images/map-1/info.json': SHA.a,
				'images/map-1/0/0/0.jpg': SHA.b
			}),
			remote: entries({ 'amsterdam-1625/project.json': project.sha }),
			baseline: baselineOf({
				'amsterdam-1625/project.json': project.sha,
				'images/map-1/info.json': SHA.a
			}),
			projectFiles: new Map([[project.sha, project.bytes]])
		});
		if (comparison.graph.outcome !== 'invalid') throw new Error('expected an invalid graph');
		expect(comparison.graph.violations.map((violation) => violation.kind)).toEqual([
			'incomplete-image'
		]);
	});

	it('accepts a Map Image with no Alignment, which is an unplaced map and not a violation', async () => {
		const project = await projectFile('Amsterdam', MAP_LAYER);
		const files = {
			'amsterdam-1625/project.json': project.sha,
			'images/map-1/info.json': SHA.a
		};
		const comparison = compareWorkspace({
			local: entries(files),
			remote: entries(files),
			baseline: baselineOf(files),
			projectFiles: new Map([[project.sha, project.bytes]])
		});
		expect(comparison.graph.outcome).toBe('valid');
		expect(comparison.status).toBe('in-sync');
	});

	it('is an operation failure, not a violation, when a Remote project.json will not parse', async () => {
		const bytes = encode('{ not json');
		const sha = await gitBlobSha(bytes);
		const comparison = compareWorkspace({
			local: entries({ 'amsterdam-1625/project.json': SHA.a }),
			remote: entries({ 'amsterdam-1625/project.json': sha }),
			baseline: baselineOf({ 'amsterdam-1625/project.json': SHA.a }),
			projectFiles: new Map([[sha, bytes]])
		});
		if (comparison.graph.outcome !== 'failed') throw new Error('expected an operation failure');
		expect(comparison.graph.failures.map((failure) => failure.kind)).toEqual(['malformed']);
		expect(comparison.status).not.toBe('in-sync');
	});

	it('is an operation failure when a Remote project.json is from a newer format', async () => {
		const bytes = encode(JSON.stringify({ formatVersion: 99, name: 'Later', layers: [] }));
		const sha = await gitBlobSha(bytes);
		const comparison = compareWorkspace({
			local: entries({ 'amsterdam-1625/project.json': SHA.a }),
			remote: entries({ 'amsterdam-1625/project.json': sha }),
			baseline: baselineOf({ 'amsterdam-1625/project.json': SHA.a }),
			projectFiles: new Map([[sha, bytes]])
		});
		if (comparison.graph.outcome !== 'failed') throw new Error('expected an operation failure');
		expect(comparison.graph.failures.map((failure) => failure.kind)).toEqual(['unsupported']);
	});

	it('is an operation failure when the bytes of a chosen project.json were never supplied', () => {
		const comparison = compareWorkspace({
			local: entries({ 'amsterdam-1625/project.json': SHA.a }),
			remote: entries({ 'amsterdam-1625/project.json': SHA.b }),
			baseline: baselineOf({ 'amsterdam-1625/project.json': SHA.a }),
			projectFiles: new Map()
		});
		if (comparison.graph.outcome !== 'failed') throw new Error('expected an operation failure');
		expect(comparison.graph.failures.map((failure) => failure.kind)).toEqual(['unreadable']);
	});

	it('does not check the graph at all when no validation material is offered', () => {
		const comparison = compareWorkspace(
			input(
				{ 'amsterdam-1625/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a },
				{ 'amsterdam-1625/project.json': SHA.a }
			)
		);
		expect(comparison.graph.outcome).toBe('not-checked');
		expect(comparison.status).toBe('changes-to-send');
	});
});

// ── The Sync plan ─────────────────────────────────────────────────────────────────────────────

describe('planWorkspaceSync', () => {
	it('takes Remote-only additions, replacements and deletions into the Workspace', () => {
		const plan = planWorkspaceSync(
			input(
				{ 'a/project.json': SHA.a, 'a/annotations/keep.geojson': SHA.a, 'a/gone.geojson': SHA.a },
				{ 'a/project.json': SHA.b, 'a/annotations/keep.geojson': SHA.a, 'a/new.geojson': SHA.c },
				{ 'a/project.json': SHA.a, 'a/annotations/keep.geojson': SHA.a, 'a/gone.geojson': SHA.a }
			)
		);
		expect(plan.toGet.changes).toEqual([
			{ path: 'a/gone.geojson', sha: null, effect: 'delete' },
			{ path: 'a/new.geojson', sha: SHA.c, effect: 'add' },
			{ path: 'a/project.json', sha: SHA.b, effect: 'replace' }
		]);
		expect(plan.toGet.removed).toEqual(['a/gone.geojson']);
	});

	it('sends every local source path and preserves what is outside the namespace', () => {
		const plan = planWorkspaceSync(
			input(
				{ 'a/project.json': SHA.b, 'images/map-1/info.json': SHA.a },
				{ 'a/project.json': SHA.a, 'README.md': SHA.c, CNAME: SHA.c },
				{ 'a/project.json': SHA.a }
			)
		);
		expect(plan.toSend.changes).toEqual([
			{ path: 'a/project.json', sha: SHA.b, effect: 'replace' },
			{ path: 'images/map-1/info.json', sha: SHA.a, effect: 'add' }
		]);
		expect(plan.preserved).toEqual(['CNAME', 'README.md']);
	});

	it('makes the whole local source namespace the Baseline a send would advance to', () => {
		const plan = planWorkspaceSync(
			input({ 'a/project.json': SHA.b, 'images/map-1/info.json': SHA.a }, {}, {})
		);
		expect([...plan.toSend.advances].sort()).toEqual([
			['a/project.json', SHA.b],
			['images/map-1/info.json', SHA.a]
		]);
	});

	it('retains local-only changes at other paths and does not advance them on a get', () => {
		const plan = planWorkspaceSync(
			input(
				{ 'a/project.json': SHA.b, 'b/project.json': SHA.a },
				{ 'a/project.json': SHA.a, 'b/project.json': SHA.b },
				{ 'a/project.json': SHA.a, 'b/project.json': SHA.a }
			)
		);
		expect(plan.toGet.changes).toEqual([{ path: 'b/project.json', sha: SHA.b, effect: 'replace' }]);
		expect(plan.retained).toEqual(['a/project.json']);
		expect([...plan.toGet.advances]).toEqual([['b/project.json', SHA.b]]);
	});

	it('advances a get’s Baseline for inbound, shared and converged paths only', () => {
		const plan = planWorkspaceSync(
			input(
				{
					'a/project.json': SHA.a,
					'a/in.geojson': SHA.a,
					'a/both.geojson': SHA.b,
					'a/out.geojson': SHA.b
				},
				{
					'a/project.json': SHA.a,
					'a/in.geojson': SHA.b,
					'a/both.geojson': SHA.b,
					'a/out.geojson': SHA.a
				},
				{
					'a/project.json': SHA.a,
					'a/in.geojson': SHA.a,
					'a/both.geojson': SHA.a,
					'a/out.geojson': SHA.a
				}
			)
		);
		expect([...plan.toGet.advances].sort()).toEqual([
			['a/both.geojson', SHA.b],
			['a/in.geojson', SHA.b],
			['a/project.json', SHA.a]
		]);
		expect(plan.toGet.retires).toEqual([]);
	});

	it('retires from the Baseline a path both sides no longer hold', () => {
		const plan = planWorkspaceSync(
			input(
				{ 'a/project.json': SHA.a },
				{ 'a/project.json': SHA.a },
				{ 'a/project.json': SHA.a, 'a/dropped.geojson': SHA.b }
			)
		);
		expect(plan.toGet.retires).toEqual(['a/dropped.geojson']);
	});

	it('reports a Conflict rather than refusing, and settles it in neither direction', () => {
		const plan = planWorkspaceSync(
			input({ 'a/project.json': SHA.b }, { 'a/project.json': SHA.c }, { 'a/project.json': SHA.a })
		);
		expect(plan.conflicts.map((row) => row.path)).toEqual(['a/project.json']);
		// Neither half writes it: the get resolves it into a copy, and until then both sides keep
		// exactly what they hold (ADR-0046).
		expect(plan.toGet.changes).toEqual([]);
		expect(plan.toSend.changes).toEqual([]);
		expect(plan.toSend.removed).toEqual([]);
	});

	it('never chooses generated Published Site output in either direction', () => {
		const plan = planWorkspaceSync(
			input(
				{ 'a/project.json': SHA.a },
				{ 'a/project.json': SHA.a, '_app/immutable/entry/app.old.js': SHA.b, 'index.html': SHA.c },
				{ 'a/project.json': SHA.a }
			)
		);
		expect(plan.toGet.changes).toEqual([]);
		expect(plan.toSend.removed).toEqual([]);
	});

	it('reports a prospective Workspace that would not open as a broken graph', async () => {
		const project = await projectFile('Amsterdam', MAP_LAYER);
		const plan = planWorkspaceSync({
			local: entries({
				'amsterdam-1625/project.json': project.sha,
				'images/map-1/info.json': SHA.a
			}),
			remote: entries({ 'amsterdam-1625/project.json': SHA.b }),
			baseline: baselineOf({
				'amsterdam-1625/project.json': SHA.b,
				'images/map-1/info.json': SHA.a
			}),
			projectFiles: new Map([[project.sha, project.bytes]])
		});
		if (plan.comparison.graph.outcome !== 'invalid') throw new Error('expected an invalid graph');
		expect(describeGraphViolations(plan.comparison.graph.violations)).toContain('images/map-1');
	});

	it('reports an unreadable Remote as a failure rather than as changed scholarship', () => {
		const plan = planWorkspaceSync({
			local: entries({ 'a/project.json': SHA.a }),
			remote: entries({ 'a/project.json': SHA.b }),
			baseline: baselineOf({ 'a/project.json': SHA.a }),
			projectFiles: new Map()
		});
		expect(plan.comparison.graph.outcome).toBe('failed');
		expect(plan.conflicts).toEqual([]);
	});
});

// ── Baseline-narrowed removal, which is what makes one Sync control safe ───────────────────────

describe('what a send may remove', () => {
	it('removes an owned Remote source path the Baseline recorded and the Workspace has lost', () => {
		const plan = planWorkspaceSync(
			input(
				{ 'a/project.json': SHA.a },
				{ 'a/project.json': SHA.a, 'b/project.json': SHA.a },
				{ 'a/project.json': SHA.a, 'b/project.json': SHA.a }
			)
		);
		expect(plan.toSend.removed).toEqual(['b/project.json']);
		expect(plan.leftAlone).toEqual([]);
	});

	// ⚠ **The single most important row in this file.** Absent from the Baseline and absent here means
	// the Remote *gained* it, so it is somebody else's work and a send may not take it down. Turn the
	// `local === null` guard in the `outbound` arm into a no-op and this is the only test that fails.
	it('leaves alone a Remote path the Baseline never recorded, and offers it to get instead', () => {
		const plan = planWorkspaceSync(
			input(
				{ 'a/project.json': SHA.a },
				{ 'a/project.json': SHA.a, 'florida-1657/project.json': SHA.b },
				{ 'a/project.json': SHA.a }
			)
		);
		expect(plan.toSend.removed).toEqual([]);
		expect(plan.leftAlone).toEqual(['florida-1657/project.json']);
		expect(plan.toGet.changes).toEqual([
			{ path: 'florida-1657/project.json', sha: SHA.b, effect: 'add' }
		]);
	});

	it('removes nothing in either direction with no Baseline at all', () => {
		const plan = planWorkspaceSync(
			input({ 'a/project.json': SHA.a }, { 'b/project.json': SHA.b, 'c/project.json': SHA.c }, null)
		);
		expect(plan.toSend.removed).toEqual([]);
		expect(plan.toGet.removed).toEqual([]);
		// Both sides' own work is offered, in the direction it is missing from.
		expect(plan.toGet.changes.map((choice) => choice.path)).toEqual([
			'b/project.json',
			'c/project.json'
		]);
		expect(plan.leftAlone).toEqual(['b/project.json', 'c/project.json']);
		// And the badge is still `Cannot tell`: the plan reasons about bytes, the status about
		// attribution, and there is no attribution to make.
		expect(plan.comparison.status).toBe('cannot-tell');
	});

	it('is a Conflict, not a removal, where a Remote path this Workspace changed has gone', () => {
		const plan = planWorkspaceSync(
			input({ 'a/project.json': SHA.b }, {}, { 'a/project.json': SHA.a })
		);
		expect(plan.conflicts.map((row) => row.path)).toEqual(['a/project.json']);
		expect(plan.toGet.removed).toEqual([]);
	});

	// The one mode whose removals come from the Workspace alone: inside the owned namespace the
	// Remote becomes exactly the Workspace, which is why it is named before it is carried out.
	it('names what an overwrite would take down, from the Workspace alone', () => {
		const plan = planWorkspaceSync(
			input(
				{ 'a/project.json': SHA.a },
				{ 'a/project.json': SHA.c, 'florida-1657/project.json': SHA.b, 'README.md': SHA.c },
				null
			)
		);
		expect(plan.toOverwrite.removed).toEqual(['florida-1657/project.json']);
		expect(plan.preserved).toEqual(['README.md']);
	});
});

// ── No Baseline ────────────────────────────────────────────────────────────────────────────────

describe('planning without a Baseline', () => {
	it('has nothing to do where the two source namespaces are byte-for-byte equal', () => {
		const files = { 'a/project.json': SHA.a, 'images/map-1/info.json': SHA.b };
		const plan = planWorkspaceSync(input(files, files, null));
		expect(plan.toGet.changes).toEqual([]);
		expect(plan.toSend.changes.every((choice) => choice.effect === 'keep')).toBe(true);
		expect([...plan.toGet.advances].sort()).toEqual([
			['a/project.json', SHA.a],
			['images/map-1/info.json', SHA.b]
		]);
	});

	it('brings a whole Remote into a Workspace that holds no source at all', () => {
		const plan = planWorkspaceSync(input({}, { 'a/project.json': SHA.a }, null));
		expect(plan.toGet.changes).toEqual([{ path: 'a/project.json', sha: SHA.a, effect: 'add' }]);
	});

	it('has nothing to get where the Remote holds no source at all', () => {
		const plan = planWorkspaceSync(
			input({ 'a/project.json': SHA.a }, { 'README.md': SHA.b }, null)
		);
		expect(plan.toGet.changes).toEqual([]);
		expect([...plan.toGet.advances]).toEqual([]);
		expect(plan.preserved).toEqual(['README.md']);
	});

	// The one get that would adopt a whole Remote unexamined if nothing checked it: a Remote that
	// would open as a broken Workspace, taken whole on the very transfer that establishes the
	// evidence for every later one.
	it('reports a broken graph from a Remote whose Project names a Map Image it does not hold', async () => {
		const project = await projectFile('Amsterdam', MAP_LAYER);
		const plan = planWorkspaceSync({
			local: [],
			remote: entries({ 'amsterdam-1625/project.json': project.sha }),
			baseline: null,
			projectFiles: new Map([[project.sha, project.bytes]])
		});

		expect(plan.comparison.graph.outcome).toBe('invalid');
	});

	it('accepts a Remote that is a whole Workspace', async () => {
		const project = await projectFile('Amsterdam', MAP_LAYER);
		const plan = planWorkspaceSync({
			local: [],
			remote: entries({
				'amsterdam-1625/project.json': project.sha,
				'images/map-1/info.json': SHA.a
			}),
			baseline: null,
			projectFiles: new Map([[project.sha, project.bytes]])
		});

		expect(plan.comparison.graph.outcome).toBe('valid');
	});

	// ⚠ **What used to be `unknown-history`.** Two non-empty sides that hold one path differently and
	// no record of what they last shared is not a removal and not an overwrite: it is the same path
	// changed on both sides, which is the one refusal a Sync has left.
	it('reports differing non-empty sides as a Conflict', () => {
		const plan = planWorkspaceSync(
			input({ 'a/project.json': SHA.a }, { 'a/project.json': SHA.b }, null)
		);
		expect(plan.conflicts.map((row) => row.path)).toEqual(['a/project.json']);
	});
});

// ── The complete local hash ────────────────────────────────────────────────────────────────────

/** Every path a Workspace holds, hashed — the pass deliberate planning always makes. */
const hashWorkspace = async (store: MemoryProjectStore): Promise<InventoryEntry[]> => {
	const inventory: InventoryEntry[] = [];
	for (const path of await store.list('')) {
		inventory.push({ path, sha: await gitBlobSha(await store.read(path)) });
	}
	return inventory;
};

describe('deliberate planning hashes the whole Workspace', () => {
	it('finds a chosen-folder edit that never reached the write index, and changes the plan', async () => {
		const store = new MemoryProjectStore();
		const managed = new ManagedProjectStore(
			store,
			new LocalChangeIndex(new FakeMetadataStorage(), 'folder:maps', { flushInterval: 0 })
		);
		await managed.write('a/project.json', encode('{"formatVersion":1,"name":"A","layers":[]}\n'));
		await managed.write('a/annotations/notes.geojson', encode('{"features":[]}\n'));

		const shared = await hashWorkspace(store);
		// The Baseline about to be established makes every one of those paths shared, so the index is
		// emptied exactly as a successful transfer would empty it.
		await managed.changes.clear();
		const baseline: SynchronizationBaseline = {
			remote: REMOTE,
			commit: 'c0ffee',
			files: new Map(shared.map((entry) => [entry.path, entry.sha]))
		};

		const github = await createFakeGitHub({
			...REMOTE,
			tree: Object.fromEntries(
				await Promise.all(
					(await store.list('')).map(async (path) => [path, await store.read(path)] as const)
				)
			)
		});
		await github.commitFiles({ 'a/annotations/notes.geojson': '{"features":[{"id":1}]}\n' });
		const remote = await Promise.all(
			[...github.files()].map(async ([path, bytes]) => ({ path, sha: await gitBlobSha(bytes) }))
		);

		// Somebody edits the same Annotation in the chosen folder with another program, so it never
		// crosses the managed store's seam and the index has nothing to say about it.
		await store.write('a/annotations/notes.geojson', encode('{"features":[{"id":2}]}\n'));

		// The passive check therefore reports one inbound change and no local drift at all, and a plan
		// built from the same evidence would take the Remote's bytes over the author's own edit.
		const passive = await checkSourceStatus({ changes: managed, remote, baseline });
		expect(passive.status).toBe('changes-to-get');
		expect(passive.written).toEqual([]);
		const inbound = await gitBlobSha(encode('{"features":[{"id":1}]}\n'));
		const stale = planWorkspaceSync({ local: shared, remote, baseline });
		expect(stale.toGet.changes).toEqual([
			{ path: 'a/annotations/notes.geojson', sha: inbound, effect: 'replace' }
		]);

		// The complete hash sees both sides changed the one path, which is a Conflict.
		const complete = planWorkspaceSync({ local: await hashWorkspace(store), remote, baseline });
		expect(complete.toGet.changes).toEqual([]);
		expect(complete.conflicts.map((row) => row.path)).toEqual(['a/annotations/notes.geojson']);
	});
});

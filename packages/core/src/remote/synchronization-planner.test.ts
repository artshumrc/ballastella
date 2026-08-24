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
	planWorkspacePublish,
	planWorkspaceUpdate,
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

	it('reports Up to date when every source path matches the Baseline', () => {
		const files = { 'amsterdam-1625/project.json': SHA.a, 'images/map-1/info.json': SHA.b };
		expect(status(files, files, files)).toBe('up-to-date');
	});

	it('reports Up to date when both sides made the same change', () => {
		expect(
			status(
				{ 'amsterdam-1625/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a }
			)
		).toBe('up-to-date');
	});

	it('reports Changes to publish for a local-only change', () => {
		expect(
			status(
				{ 'amsterdam-1625/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a },
				{ 'amsterdam-1625/project.json': SHA.a }
			)
		).toBe('changes-to-publish');
	});

	it('reports Update available for a Remote-only change', () => {
		expect(
			status(
				{ 'amsterdam-1625/project.json': SHA.a },
				{ 'amsterdam-1625/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a }
			)
		).toBe('update-available');
	});

	it('reports Changes on both sides for safe changes at different paths', () => {
		expect(
			status(
				{ 'amsterdam-1625/project.json': SHA.b, 'leiden-1640/project.json': SHA.a },
				{ 'amsterdam-1625/project.json': SHA.a, 'leiden-1640/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a, 'leiden-1640/project.json': SHA.a }
			)
		).toBe('changes-on-both-sides');
	});

	it('reports Conflict for one path changed differently on both sides', () => {
		expect(
			status(
				{ 'amsterdam-1625/project.json': SHA.b, 'leiden-1640/project.json': SHA.a },
				{ 'amsterdam-1625/project.json': SHA.c, 'leiden-1640/project.json': SHA.b },
				{ 'amsterdam-1625/project.json': SHA.a, 'leiden-1640/project.json': SHA.a }
			)
		).toBe('conflict');
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
		expect(comparison.status).toBe('up-to-date');
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
		expect(comparison.status).toBe('up-to-date');
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
	it('is Conflict when two individually safe changes leave a Layer’s Map Image missing', async () => {
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
		expect(comparison.status).toBe('conflict');
		expect(comparison.graph.outcome).toBe('invalid');
		if (comparison.graph.outcome !== 'invalid') return;
		expect(comparison.graph.violations.map((violation) => violation.kind)).toEqual([
			'missing-image'
		]);
	});

	it('is Conflict when a Layer’s Annotation is missing from the prospective result', async () => {
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
		expect(comparison.status).toBe('conflict');
		if (comparison.graph.outcome !== 'invalid') throw new Error('expected an invalid graph');
		expect(comparison.graph.violations.map((violation) => violation.kind)).toEqual([
			'missing-annotation'
		]);
	});

	it('is Conflict when the prospective result holds a Project’s files but no project.json', () => {
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
		expect(comparison.status).toBe('conflict');
		if (comparison.graph.outcome !== 'invalid') throw new Error('expected an invalid graph');
		expect(comparison.graph.violations.map((violation) => violation.kind)).toEqual([
			'missing-project-file'
		]);
	});

	it('is Conflict when an Alignment outlives the Map Image it places', async () => {
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
		expect(comparison.status).toBe('changes-to-publish');
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
		expect(orphaned.status).toBe('conflict');
	});

	it('is Conflict when a prospective Map Image is a heap of tiles nothing can open', async () => {
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
		expect(comparison.status).toBe('conflict');
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
		expect(comparison.status).toBe('up-to-date');
	});

	it('is an operation failure, not Conflict, when a Remote project.json will not parse', async () => {
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
		expect(comparison.status).not.toBe('conflict');
		expect(comparison.status).not.toBe('up-to-date');
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
		expect(comparison.status).toBe('changes-to-publish');
	});
});

// ── Update plans ───────────────────────────────────────────────────────────────────────────────

describe('planWorkspaceUpdate', () => {
	it('takes Remote-only additions, replacements and deletions', () => {
		const result = planWorkspaceUpdate(
			input(
				{ 'a/project.json': SHA.a, 'a/annotations/keep.geojson': SHA.a, 'a/gone.geojson': SHA.a },
				{ 'a/project.json': SHA.b, 'a/annotations/keep.geojson': SHA.a, 'a/new.geojson': SHA.c },
				{ 'a/project.json': SHA.a, 'a/annotations/keep.geojson': SHA.a, 'a/gone.geojson': SHA.a }
			)
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.changes).toEqual([
			{ path: 'a/gone.geojson', sha: null, effect: 'delete' },
			{ path: 'a/new.geojson', sha: SHA.c, effect: 'add' },
			{ path: 'a/project.json', sha: SHA.b, effect: 'replace' }
		]);
	});

	it('names the destructive paths for confirmation, and only those', () => {
		const result = planWorkspaceUpdate(
			input(
				{ 'a/project.json': SHA.a, 'a/gone.geojson': SHA.a },
				{ 'a/project.json': SHA.b, 'a/new.geojson': SHA.c },
				{ 'a/project.json': SHA.a, 'a/gone.geojson': SHA.a }
			)
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.destructive).toEqual(['a/gone.geojson', 'a/project.json']);
	});

	it('retains local-only changes at other paths and does not advance them', () => {
		const result = planWorkspaceUpdate(
			input(
				{ 'a/project.json': SHA.b, 'b/project.json': SHA.a },
				{ 'a/project.json': SHA.a, 'b/project.json': SHA.b },
				{ 'a/project.json': SHA.a, 'b/project.json': SHA.a }
			)
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.changes).toEqual([
			{ path: 'b/project.json', sha: SHA.b, effect: 'replace' }
		]);
		expect(result.plan.retained).toEqual(['a/project.json']);
		expect([...result.plan.advances]).toEqual([['b/project.json', SHA.b]]);
	});

	it('advances the Baseline for inbound, shared and converged paths only', () => {
		const result = planWorkspaceUpdate(
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
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect([...result.plan.advances].sort()).toEqual([
			['a/both.geojson', SHA.b],
			['a/in.geojson', SHA.b],
			['a/project.json', SHA.a]
		]);
		expect(result.plan.retires).toEqual([]);
	});

	it('retires from the Baseline a path both sides no longer hold', () => {
		const result = planWorkspaceUpdate(
			input(
				{ 'a/project.json': SHA.a },
				{ 'a/project.json': SHA.a },
				{ 'a/project.json': SHA.a, 'a/dropped.geojson': SHA.b }
			)
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.retires).toEqual(['a/dropped.geojson']);
	});

	it('refuses a Conflict without changing anything', () => {
		const result = planWorkspaceUpdate(
			input({ 'a/project.json': SHA.b }, { 'a/project.json': SHA.c }, { 'a/project.json': SHA.a })
		);
		if (result.outcome !== 'refused') throw new Error('expected a refusal');
		expect(result.reason).toBe('conflict');
		expect(result.paths).toEqual(['a/project.json']);
		expect(result.message).toContain('a/project.json');
	});

	it('never chooses generated Published Site output', () => {
		const result = planWorkspaceUpdate(
			input(
				{ 'a/project.json': SHA.a },
				{ 'a/project.json': SHA.a, '_app/immutable/entry/app.old.js': SHA.b, 'index.html': SHA.c },
				{ 'a/project.json': SHA.a }
			)
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.changes).toEqual([]);
	});

	it('refuses when the prospective graph is invalid', async () => {
		const project = await projectFile('Amsterdam', MAP_LAYER);
		const result = planWorkspaceUpdate({
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
		if (result.outcome !== 'refused') throw new Error('expected a refusal');
		expect(result.reason).toBe('conflict');
		expect(result.message).toContain('images/map-1');
	});

	it('fails rather than refuses when the Remote input cannot be read', () => {
		const result = planWorkspaceUpdate({
			local: entries({ 'a/project.json': SHA.a }),
			remote: entries({ 'a/project.json': SHA.b }),
			baseline: baselineOf({ 'a/project.json': SHA.a }),
			projectFiles: new Map()
		});
		expect(result.outcome).toBe('failed');
	});
});

// ── Publish plans ──────────────────────────────────────────────────────────────────────────────

describe('planWorkspacePublish', () => {
	it('sends every local source path and preserves what is outside the namespace', () => {
		const result = planWorkspacePublish(
			input(
				{ 'a/project.json': SHA.b, 'images/map-1/info.json': SHA.a },
				{ 'a/project.json': SHA.a, 'README.md': SHA.c, CNAME: SHA.c },
				{ 'a/project.json': SHA.a }
			)
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.source).toEqual([
			{ path: 'a/project.json', sha: SHA.b, effect: 'replace' },
			{ path: 'images/map-1/info.json', sha: SHA.a, effect: 'add' }
		]);
		expect(result.plan.preserved).toEqual(['CNAME', 'README.md']);
	});

	it('removes owned Remote source paths the Workspace no longer holds', () => {
		const result = planWorkspacePublish(
			input(
				{ 'a/project.json': SHA.a },
				{ 'a/project.json': SHA.a, 'b/project.json': SHA.a },
				{
					'a/project.json': SHA.a,
					'b/project.json': SHA.a
				}
			)
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.removed).toEqual(['b/project.json']);
	});

	it('refuses a Remote-only source change and names Update as the remedy', () => {
		const result = planWorkspacePublish(
			input({ 'a/project.json': SHA.a }, { 'a/project.json': SHA.b }, { 'a/project.json': SHA.a })
		);
		if (result.outcome !== 'refused') throw new Error('expected a refusal');
		expect(result.reason).toBe('remote-changes');
		expect(result.message).toContain('Update');
	});

	it('refuses safe changes on both sides', () => {
		const result = planWorkspacePublish(
			input(
				{ 'a/project.json': SHA.b, 'b/project.json': SHA.a },
				{ 'a/project.json': SHA.a, 'b/project.json': SHA.b },
				{ 'a/project.json': SHA.a, 'b/project.json': SHA.a }
			)
		);
		if (result.outcome !== 'refused') throw new Error('expected a refusal');
		expect(result.reason).toBe('changes-on-both-sides');
		expect(result.paths).toEqual(['b/project.json']);
	});

	it('refuses a Conflict', () => {
		const result = planWorkspacePublish(
			input({ 'a/project.json': SHA.b }, { 'a/project.json': SHA.c }, { 'a/project.json': SHA.a })
		);
		if (result.outcome !== 'refused') throw new Error('expected a refusal');
		expect(result.reason).toBe('conflict');
	});

	it('goes ahead when only local work is outstanding', () => {
		const result = planWorkspacePublish(
			input({ 'a/project.json': SHA.b }, { 'a/project.json': SHA.a }, { 'a/project.json': SHA.a })
		);
		expect(result.outcome).toBe('planned');
	});

	it('replaces the whole owned namespace when told to publish anyway', () => {
		const result = planWorkspacePublish(
			input(
				{ 'a/project.json': SHA.b },
				{ 'a/project.json': SHA.c, 'README.md': SHA.a },
				{
					'a/project.json': SHA.a
				}
			),
			{ replace: true }
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.replacing).toBe(true);
		expect(result.plan.source).toEqual([{ path: 'a/project.json', sha: SHA.b, effect: 'replace' }]);
		expect(result.plan.preserved).toEqual(['README.md']);
	});

	it('makes the whole local source namespace the Baseline it would advance to', () => {
		const result = planWorkspacePublish(
			input({ 'a/project.json': SHA.b, 'images/map-1/info.json': SHA.a }, {}, {})
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect([...result.plan.advances].sort()).toEqual([
			['a/project.json', SHA.b],
			['images/map-1/info.json', SHA.a]
		]);
	});
});

// ── No Baseline ────────────────────────────────────────────────────────────────────────────────

describe('planning without a Baseline', () => {
	it('establishes one when the two source namespaces are byte-for-byte equal', () => {
		const files = { 'a/project.json': SHA.a, 'images/map-1/info.json': SHA.b };
		const update = planWorkspaceUpdate(input(files, files, null));
		if (update.outcome !== 'planned') throw new Error('expected a plan');
		expect(update.plan.establishesBaseline).toBe(true);
		expect(update.plan.changes).toEqual([]);
		expect([...update.plan.advances].sort()).toEqual([
			['a/project.json', SHA.a],
			['images/map-1/info.json', SHA.b]
		]);

		const publish = planWorkspacePublish(input(files, files, null));
		if (publish.outcome !== 'planned') throw new Error('expected a plan');
		expect(publish.plan.establishesBaseline).toBe(true);
	});

	it('lets Update establish one when the Workspace holds no source at all', () => {
		const result = planWorkspaceUpdate(input({}, { 'a/project.json': SHA.a }, null));
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.establishesBaseline).toBe(true);
		expect(result.plan.changes).toEqual([{ path: 'a/project.json', sha: SHA.a, effect: 'add' }]);
	});

	it('lets Update establish one when the Remote holds no source at all', () => {
		const result = planWorkspaceUpdate(
			input({ 'a/project.json': SHA.a }, { 'README.md': SHA.b }, null)
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.establishesBaseline).toBe(true);
		expect(result.plan.changes).toEqual([]);
		// Nothing was shared, so the Baseline it establishes is empty and the local work is still
		// Changes to publish afterwards.
		expect([...result.plan.advances]).toEqual([]);
	});

	// The one Update that adopts a whole Remote unexamined if nothing checks it. Every row is
	// `cannot-tell` without a Baseline, so the shared prospective set is the local side alone — which
	// here is nothing — and a Remote that would open as a broken Workspace would be taken whole on the
	// very transfer that establishes the evidence for every later one (SPEC story 136).
	it('refuses to establish one from a Remote whose Project names a Map Image it does not hold', async () => {
		const project = await projectFile('Amsterdam', MAP_LAYER);
		const result = planWorkspaceUpdate({
			local: [],
			remote: entries({ 'amsterdam-1625/project.json': project.sha }),
			baseline: null,
			projectFiles: new Map([[project.sha, project.bytes]])
		});

		if (result.outcome !== 'refused') throw new Error('expected a refusal');
		expect(result.reason).toBe('conflict');
		expect(result.message).toContain('Nothing has been changed.');
	});

	it('still establishes one from a Remote that is a whole Workspace', async () => {
		const project = await projectFile('Amsterdam', MAP_LAYER);
		const result = planWorkspaceUpdate({
			local: [],
			remote: entries({
				'amsterdam-1625/project.json': project.sha,
				'images/map-1/info.json': SHA.a
			}),
			baseline: null,
			projectFiles: new Map([[project.sha, project.bytes]])
		});

		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.establishesBaseline).toBe(true);
	});

	it('refuses Update when differing non-empty local and Remote work cannot be attributed', () => {
		const result = planWorkspaceUpdate(
			input({ 'a/project.json': SHA.a }, { 'a/project.json': SHA.b }, null)
		);
		if (result.outcome !== 'refused') throw new Error('expected a refusal');
		expect(result.reason).toBe('unknown-history');
		expect(result.message).toContain('cannot tell');
	});

	it('lets Publish establish one when the Remote holds no source at all', () => {
		const result = planWorkspacePublish(
			input({ 'a/project.json': SHA.a }, { 'README.md': SHA.b }, null)
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.establishesBaseline).toBe(true);
		expect(result.plan.preserved).toEqual(['README.md']);
	});

	it('refuses ordinary Publish over a non-empty Remote it cannot account for', () => {
		const result = planWorkspacePublish(
			input({ 'a/project.json': SHA.a }, { 'b/project.json': SHA.b }, null)
		);
		if (result.outcome !== 'refused') throw new Error('expected a refusal');
		expect(result.reason).toBe('unknown-history');
		expect(result.paths).toEqual(['b/project.json']);
	});

	it('still lets Publish anyway through, and it establishes the Baseline', () => {
		const result = planWorkspacePublish(
			input({ 'a/project.json': SHA.a }, { 'b/project.json': SHA.b }, null),
			{ replace: true }
		);
		if (result.outcome !== 'planned') throw new Error('expected a plan');
		expect(result.plan.replacing).toBe(true);
		expect(result.plan.removed).toEqual(['b/project.json']);
		expect(result.plan.establishesBaseline).toBe(true);
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
		expect(passive.status).toBe('update-available');
		expect(passive.written).toEqual([]);
		const inbound = await gitBlobSha(encode('{"features":[{"id":1}]}\n'));
		const stale = planWorkspaceUpdate({ local: shared, remote, baseline });
		if (stale.outcome !== 'planned') throw new Error('expected a plan');
		expect(stale.plan.changes).toEqual([
			{ path: 'a/annotations/notes.geojson', sha: inbound, effect: 'replace' }
		]);

		// The complete hash sees both sides changed the one path, and refuses.
		const complete = planWorkspaceUpdate({ local: await hashWorkspace(store), remote, baseline });
		if (complete.outcome !== 'refused') throw new Error('expected a refusal');
		expect(complete.reason).toBe('conflict');
		expect(complete.paths).toEqual(['a/annotations/notes.geojson']);
	});
});

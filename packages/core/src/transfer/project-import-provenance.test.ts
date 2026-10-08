import { describe, expect, it } from 'vitest';

import type { ImportProvenanceEntry } from '../project/import-provenance.js';
import {
	parseProjectFile,
	serialiseProjectFile,
	type ProjectFile
} from '../project/project-file.js';
import { decode, encode } from '../test-support.js';
import { detachImportedProject } from './project-import-remapping.js';
import type { ProjectImportOrigin } from './project-import-source.js';

const AT = new Date('2026-08-22T09:30:00.000Z');
const LATER = new Date('2026-09-01T14:00:00.000Z');

const GITHUB: ProjectImportOrigin = {
	kind: 'github',
	owner: 'ada',
	repository: 'atlas',
	branch: 'main',
	directory: 'amsterdam-1625',
	commit: '9f2c1de4b7a80315c6e5d2f9a1b8c7d6e5f40312',
	projectName: 'Amsterdam 1625'
};

const REVIEW: ProjectImportOrigin = {
	kind: 'review',
	projectName: 'Amsterdam 1625',
	directory: 'amsterdam-1625'
};

const arrived = (extra: Record<string, unknown> = {}): ProjectFile =>
	parseProjectFile(
		encode(
			JSON.stringify({
				formatVersion: 1,
				name: 'Amsterdam 1625',
				updatedAt: '2025-03-04T11:22:33.000Z',
				layers: [],
				baseMap: 'protomaps-light',
				canonicalUrl: 'https://ada.github.io/atlas',
				noteFromALaterBuild: 'kept',
				...extra
			})
		)
	);

const written = (project: ProjectFile): Record<string, unknown> =>
	JSON.parse(decode(serialiseProjectFile(project)));

describe('the observed entry each source appends', () => {
	it('records the repository, branch, Project directory and commit, for a Project on a Remote', () => {
		const detached = detachImportedProject(arrived(), GITHUB, AT);

		expect(detached.importProvenance).toEqual([
			{
				kind: 'github',
				owner: 'ada',
				repository: 'atlas',
				branch: 'main',
				directory: 'amsterdam-1625',
				commit: '9f2c1de4b7a80315c6e5d2f9a1b8c7d6e5f40312',
				observedAt: '2026-08-22T09:30:00.000Z',
				evidence: 'observed'
			}
		]);
	});

	it('records the Project name and nothing about the throwaway Workspace, for a Review', () => {
		const detached = detachImportedProject(arrived(), REVIEW, AT);

		expect(detached.importProvenance).toEqual([
			{
				kind: 'review',
				projectName: 'Amsterdam 1625',
				observedAt: '2026-08-22T09:30:00.000Z',
				evidence: 'observed'
			}
		]);
	});

	it.each([
		[
			'a Project on a Remote',
			GITHUB,
			['branch', 'commit', 'directory', 'evidence', 'kind', 'observedAt', 'owner', 'repository']
		],
		['a Review', REVIEW, ['evidence', 'kind', 'observedAt', 'projectName']]
	])('claims no author, owner or credential for %s', (_name, origin, keys) => {
		const [entry] = detachImportedProject(arrived(), origin, AT).importProvenance ?? [];

		expect(Object.keys(entry as ImportProvenanceEntry).toSorted()).toEqual(keys);
	});
});

describe('the publication reset', () => {
	it('writes no canonicalUrl at all, whatever address the source was stamped with', () => {
		const detached = detachImportedProject(arrived(), GITHUB, AT);
		expect(detached.canonicalUrl).toBeNull();
		expect(written(detached)).not.toHaveProperty('canonicalUrl');
		expect(JSON.stringify(written(detached))).toContain('ada');
	});

	it('takes the Project off the Front Page whatever the source chose', () => {
		for (const onFrontPage of [undefined, true, false]) {
			const source = arrived(onFrontPage === undefined ? {} : { onFrontPage });
			const detached = detachImportedProject(source, REVIEW, AT);
			expect(detached.onFrontPage).toBe(false);
			expect(written(detached)).not.toHaveProperty('onFrontPage');
		}
	});

	it('keeps updatedAt, because being copied is not an edit, and the name, the Base Map and a field a later build wrote', () => {
		const detached = detachImportedProject(arrived(), REVIEW, AT);
		expect(detached.updatedAt).toBe('2025-03-04T11:22:33.000Z');
		expect(detached.name).toBe('Amsterdam 1625');
		expect(detached.baseMap).toBe('protomaps-light');
		expect(detached.unknownFields).toEqual({ noteFromALaterBuild: 'kept' });
	});
});

describe('a Project handed on more than once', () => {
	const twice = (): ProjectFile => {
		const first = detachImportedProject(arrived(), GITHUB, AT);
		return detachImportedProject(parseProjectFile(serialiseProjectFile(first)), REVIEW, LATER);
	};

	it('appends oldest first, marks carried entries inherited, and keeps their facts so the route stays inspectable', () => {
		const entries = twice().importProvenance ?? [];
		expect(entries.map((entry) => entry.kind)).toEqual(['github', 'review']);
		expect(entries.map((entry) => entry.evidence)).toEqual(['inherited', 'observed']);
		expect(entries[0]).toEqual({
			kind: 'github',
			owner: 'ada',
			repository: 'atlas',
			branch: 'main',
			directory: 'amsterdam-1625',
			commit: '9f2c1de4b7a80315c6e5d2f9a1b8c7d6e5f40312',
			observedAt: '2026-08-22T09:30:00.000Z',
			evidence: 'inherited'
		});
	});

	it('carries an entry of a kind it does not know, marked inherited', () => {
		const source = arrived({
			importProvenance: [
				{
					kind: 'zenodo',
					doi: '10.5281/zenodo.1234567',
					observedAt: '2026-01-05T08:00:00.000Z',
					evidence: 'observed'
				}
			]
		});

		const detached = detachImportedProject(source, REVIEW, AT);

		expect(written(detached).importProvenance).toEqual([
			{
				kind: 'zenodo',
				doi: '10.5281/zenodo.1234567',
				observedAt: '2026-01-05T08:00:00.000Z',
				evidence: 'inherited'
			},
			{
				kind: 'review',
				projectName: 'Amsterdam 1625',
				observedAt: '2026-08-22T09:30:00.000Z',
				evidence: 'observed'
			}
		]);
	});
});

describe('an ordinary edit to an imported Project', () => {
	it('keeps the whole history, in order, byte for byte', () => {
		const imported = serialiseProjectFile(detachImportedProject(arrived(), GITHUB, AT));
		const renamed = parseProjectFile(imported);
		const written = serialiseProjectFile({ ...renamed, name: 'Amsterdam, 1625' });

		expect(parseProjectFile(written).importProvenance).toEqual(
			parseProjectFile(imported).importProvenance
		);
	});
});

// What an imported Project says about itself afterwards (ticket 08, ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MATRIX IS HERE BECAUSE IT IS METADATA, AND METADATA IS WHERE A SEAM 1 TEST IS AT ITS BEST
//
// Every claim in this file is about the bytes of one `project.json` after one transfer: which fields
// were cleared, which entry was appended, what happened to the entries that were already there. The
// SPEC's testing decisions rule that out of the browser explicitly — "do not add browser tests for
// metadata permutations that the core model seam can prove" — so the permutations live here and the
// running editor is asked only whether a reader can see the history at all.
//
// The assertions go through `serialiseProjectFile` and back wherever the claim is about the *file*
// rather than the model, because "no `canonicalUrl`" is a claim about absence from a document and a
// model with `canonicalUrl: null` in it would satisfy an assertion about the model either way.

import { describe, expect, it } from 'vitest';

import type { ImportProvenanceEntry } from '../project/import-provenance.js';
import {
	parseProjectFile,
	serialiseProjectFile,
	type ProjectFile
} from '../project/project-file.js';
import { detachImportedProject } from './project-import-provenance.js';
import type { ProjectImportOrigin } from './project-import-source.js';

const AT = new Date('2026-08-22T09:30:00.000Z');
const LATER = new Date('2026-09-01T14:00:00.000Z');

const BUNDLE: ProjectImportOrigin = {
	kind: 'project-bundle',
	fileName: 'amsterdam-1625.project.tar',
	projectName: 'Amsterdam 1625'
};

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

/**
 * The Project as it arrives: published from somebody's site, on their front page, with a field a
 * later build wrote.
 *
 * Read out of bytes rather than written as a literal, so the fixture is a `project.json` a source
 * could really have handed over.
 */
const arrived = (extra: Record<string, unknown> = {}): ProjectFile =>
	parseProjectFile(
		new TextEncoder().encode(
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

/** The document a Project would be written to disk as. */
const written = (project: ProjectFile): Record<string, unknown> =>
	JSON.parse(new TextDecoder().decode(serialiseProjectFile(project)));

describe('the observed entry each source appends', () => {
	it('records the file that was picked and the name inside it, for a Project Bundle', () => {
		const detached = detachImportedProject(arrived(), BUNDLE, AT);

		expect(detached.importProvenance).toEqual([
			{
				kind: 'project-bundle',
				filename: 'amsterdam-1625.project.tar',
				projectName: 'Amsterdam 1625',
				observedAt: '2026-08-22T09:30:00.000Z',
				evidence: 'observed'
			}
		]);
	});

	it('records the repository, branch, Project directory and commit, for a published Project', () => {
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

	// Stories 61 and 62, as the whole key set rather than as a list of absences: an author, an owner of
	// the scholarship or a credential would arrive as a *new field*, and an absence assertion goes
	// green for every field nobody has thought of yet.
	it.each([
		['a Project Bundle', BUNDLE, ['evidence', 'filename', 'kind', 'observedAt', 'projectName']],
		[
			'a published Project',
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
	it('writes no canonicalUrl at all, whatever the source was published at', () => {
		const detached = detachImportedProject(arrived(), GITHUB, AT);

		expect(detached.canonicalUrl).toBeNull();
		expect(written(detached)).not.toHaveProperty('canonicalUrl');
		// Retained where it is history rather than identity — and it is the *route* that keeps it, not
		// a field of the Project (stories 55, 56).
		expect(JSON.stringify(written(detached))).toContain('ada');
	});

	it('takes the Project off the Front Page whatever the source chose', () => {
		for (const onFrontPage of [undefined, true, false]) {
			const source = arrived(onFrontPage === undefined ? {} : { onFrontPage });

			const detached = detachImportedProject(source, BUNDLE, AT);

			expect(detached.onFrontPage).toBe(false);
			expect(written(detached).onFrontPage).toBe(false);
		}
	});

	it('leaves updatedAt alone, because being copied is not an edit its author made', () => {
		const detached = detachImportedProject(arrived(), BUNDLE, AT);

		expect(detached.updatedAt).toBe('2025-03-04T11:22:33.000Z');
	});

	it('keeps the name, the Base Map and a field a later build wrote', () => {
		const detached = detachImportedProject(arrived(), BUNDLE, AT);

		expect(detached.name).toBe('Amsterdam 1625');
		expect(detached.baseMap).toBe('protomaps-light');
		expect(detached.unknownFields).toEqual({ noteFromALaterBuild: 'kept' });
	});
});

describe('a Project handed on more than once', () => {
	/** The same Project, exported out of the Workspace it was imported into and imported again. */
	const twice = (): ProjectFile => {
		const first = detachImportedProject(arrived(), GITHUB, AT);
		// Through the file, because that is the only way the second Import sees the first: a Project
		// Bundle carries `project.json` and nothing else about the transfer (SPEC story 67).
		return detachImportedProject(parseProjectFile(serialiseProjectFile(first)), BUNDLE, LATER);
	};

	it('appends rather than replaces, oldest transfer first', () => {
		expect(twice().importProvenance?.map((entry) => entry.kind)).toEqual([
			'github',
			'project-bundle'
		]);
	});

	it('marks the entries it carried inherited, and only its own observed', () => {
		expect(twice().importProvenance?.map((entry) => entry.evidence)).toEqual([
			'inherited',
			'observed'
		]);
	});

	it('carries the earlier entry’s facts unchanged, so the route stays inspectable', () => {
		const [first] = twice().importProvenance ?? [];

		expect(first).toEqual({
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

	// An entry a *later* build wrote, of a kind this one has never heard of. Erasing it would make the
	// history a record of the transfers this build happened to recognise rather than of the Project's
	// route, which is the one thing an append-only history may not do.
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

		const detached = detachImportedProject(source, BUNDLE, AT);

		expect(written(detached).importProvenance).toEqual([
			{
				kind: 'zenodo',
				doi: '10.5281/zenodo.1234567',
				observedAt: '2026-01-05T08:00:00.000Z',
				evidence: 'inherited'
			},
			{
				kind: 'project-bundle',
				filename: 'amsterdam-1625.project.tar',
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

		// What every edit in the app does: parse, change one field, write it back.
		const renamed = parseProjectFile(imported);
		const written = serialiseProjectFile({ ...renamed, name: 'Amsterdam, 1625' });

		expect(parseProjectFile(written).importProvenance).toEqual(
			parseProjectFile(imported).importProvenance
		);
	});
});

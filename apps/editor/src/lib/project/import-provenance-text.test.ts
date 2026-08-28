import type { ImportProvenanceEntry } from '@ballastella/core';
import { describe, expect, it } from 'vitest';

import { describeImportEvidence, describeImportProvenance } from './import-provenance-text.js';

const AT = '2026-08-22T09:30:00.000Z';

describe('what a transfer is said to have been', () => {
	it('names the repository, branch, Project folder and commit of a published Project', () => {
		const entry: ImportProvenanceEntry = {
			kind: 'github',
			owner: 'ada',
			repository: 'atlas',
			branch: 'main',
			directory: 'amsterdam-1625',
			commit: '9f2c1de4b7a80315c6e5d2f9a1b8c7d6e5f40312',
			observedAt: AT,
			evidence: 'observed'
		};

		expect(describeImportProvenance(entry)).toBe(
			'Copied from ada/atlas, branch main, Project folder “amsterdam-1625”, ' +
				'commit 9f2c1de4b7a80315c6e5d2f9a1b8c7d6e5f40312.'
		);
	});

	it('names the file a Project Bundle came in, and the name inside it', () => {
		expect(
			describeImportProvenance({
				kind: 'project-bundle',
				filename: 'amsterdam-1625.project.tar',
				projectName: 'Amsterdam 1625',
				observedAt: AT,
				evidence: 'observed'
			})
		).toBe(
			'Copied from the Project Bundle “amsterdam-1625.project.tar”, which named the Project ' +
				'“Amsterdam 1625”.'
		);
	});

	it('says a review copy was the source', () => {
		expect(
			describeImportProvenance({
				kind: 'review',
				projectName: 'Amsterdam 1625',
				observedAt: AT,
				evidence: 'inherited'
			})
		).toBe('Copied from a review copy of the Project “Amsterdam 1625”.');
	});

	// A transfer a later build recorded. The reader is told that something happened and that this
	// version cannot say what, rather than being shown a gap.
	it('says a kind it does not know is a kind it does not know', () => {
		expect(
			describeImportProvenance({
				kind: 'foreign',
				declaredKind: 'zenodo',
				observedAt: AT,
				evidence: 'inherited'
			})
		).toContain('does not recognise (“zenodo”)');
	});

	it('leaves out a fact an entry does not hold, rather than an empty quotation', () => {
		const sentence = describeImportProvenance({
			kind: 'github',
			owner: 'ada',
			repository: 'atlas',
			branch: '',
			directory: '',
			commit: '',
			observedAt: AT,
			evidence: 'inherited'
		});

		expect(sentence).toBe('Copied from ada/atlas.');
	});
});

describe('what a reader is told about the evidence', () => {
	it('says an observed entry was seen here', () => {
		expect(
			describeImportEvidence({
				kind: 'review',
				projectName: 'Amsterdam 1625',
				observedAt: AT,
				evidence: 'observed'
			})
		).toBe('Seen by Ballastella as this copy was made.');
	});

	// A carried claim shown beside a witnessed one must not read as a verified one.
	it('says an inherited entry was not checked', () => {
		expect(
			describeImportEvidence({
				kind: 'review',
				projectName: 'Amsterdam 1625',
				observedAt: AT,
				evidence: 'inherited'
			})
		).toContain('not checked here');
	});
});

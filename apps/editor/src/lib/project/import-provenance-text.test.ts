import type { ImportProvenanceEntry } from '@ballastella/core';
import { describe, expect, it } from 'vitest';

import { describeImportEvidence, describeImportProvenance } from './import-provenance-text.js';

const AT = '2026-08-22T09:30:00.000Z';

describe('what a transfer is said to have been', () => {
	it('names the repository, branch, Project folder and commit of a Project on a Remote', () => {
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
	it.each([
		['observed', 'Seen by Ballastella as this copy was made.'],
		['inherited', 'Carried in with the Project from an earlier transfer, and not checked here.']
	] as const)('says what a %s entry was', (evidence, said) => {
		expect(
			describeImportEvidence({
				kind: 'review',
				projectName: 'Amsterdam 1625',
				observedAt: AT,
				evidence
			})
		).toBe(said);
	});
});

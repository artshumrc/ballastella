import type { ImportProvenanceEntry } from '@ballastella/core';

export function describeImportProvenance(entry: ImportProvenanceEntry): string {
	switch (entry.kind) {
		case 'github': {
			const repository = [entry.owner, entry.repository].filter((part) => part !== '').join('/');
			const where = [
				repository === '' ? 'a repository on GitHub' : repository,
				entry.branch === '' ? null : `branch ${entry.branch}`,
				entry.directory === '' ? null : `Project folder “${entry.directory}”`,
				entry.commit === '' ? null : `commit ${entry.commit}`
			].filter((part) => part !== null);
			return `Copied from ${where.join(', ')}.`;
		}
		case 'project-bundle': {
			const named =
				entry.projectName === '' ? '' : `, which named the Project “${entry.projectName}”`;
			const file = entry.filename === '' ? 'a Project Bundle' : `“${entry.filename}”`;
			return `Copied from the Project Bundle ${file}${named}.`;
		}
		case 'review': {
			const named = entry.projectName === '' ? 'a Project' : `the Project “${entry.projectName}”`;
			return `Copied from a review copy of ${named}.`;
		}
		case 'foreign':
			return entry.declaredKind === ''
				? 'Copied by a transfer this version of Ballastella does not recognise.'
				: `Copied by a kind of transfer this version of Ballastella does not recognise ` +
						`(“${entry.declaredKind}”).`;
	}
}

export function describeImportEvidence(entry: ImportProvenanceEntry): string {
	return entry.evidence === 'observed'
		? 'Seen by Ballastella as this copy was made.'
		: 'Carried in with the Project from an earlier transfer, and not checked here.';
}

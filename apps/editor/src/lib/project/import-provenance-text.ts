// The words a Project's transfer history is shown in (ADR-0037).
//
// Here rather than inside `ProjectScreen.svelte` so that the sentences have a unit test: what a
// reader is told about a transfer nobody witnessed is a claim, and a claim asserted only in a browser
// suite is one nothing checks per case.
//
// ⚠ **Neither sentence may become attribution.** An entry names a route — a file that was picked, a
// repository the bytes came from — and the section these lines appear in says so in as many words,
// because a scholar reading a list of accounts beside somebody's maps will otherwise read it as
// authorship.

import type { ImportProvenanceEntry } from '@ballastella/core';

/** What was copied, and out of where. Only what the entry actually holds. */
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
		// A transfer a later build recorded. Named rather than hidden: the reader can see that something
		// happened and that this version cannot say what, which is the honest pair of facts.
		case 'foreign':
			return entry.declaredKind === ''
				? 'Copied by a transfer this version of Ballastella does not recognise.'
				: `Copied by a kind of transfer this version of Ballastella does not recognise ` +
						`(“${entry.declaredKind}”).`;
	}
}

/**
 * Whether Ballastella saw this, said to a reader.
 *
 * The inherited sentence says twice over that nothing here checked it, because the whole risk of
 * showing a carried claim is that it reads as a verified one.
 */
export function describeImportEvidence(entry: ImportProvenanceEntry): string {
	return entry.evidence === 'observed'
		? 'Seen by Ballastella as this copy was made.'
		: 'Carried in with the Project from an earlier transfer, and not checked here.';
}

// Detaching an imported Project: the publication reset and the provenance entry, in one place
// (ticket 08, ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THESE THREE CHANGES ARE ONE FUNCTION
//
// A Project that has just been copied into somebody else's Workspace is wrong in three ways at once,
// and they are the same mistake: it is still describing itself as the *source* Project. It names the
// address its Map Images were stamped for; it carries its author's decision about a front page it is
// no longer on; and it says nothing about how it got here. Split across the modules that happened to
// be nearby, the second one gets forgotten — a Project imported off its own front page for reasons
// nobody recorded — so `remapProjectImport` deliberately does none of it and this does all of it.
//
// ⚠ **`updatedAt` is not touched.** Being copied is not an edit its author made, and stamping it here
// would overwrite the one date in the file that says when the scholarship last changed with the date
// somebody pressed Import (SPEC "Import does not itself change authorship timestamps").
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHERE THIS GOES IN AN IMPORT
//
// **Before the remapping, not after it.** `remapProjectImport` serialises the manifest it plans, so a
// reset applied afterwards would have to rewrite bytes the closure had already committed to:
//
//     const detached = detachImportedProject(source.project, source.origin, new Date());
//     const plan = await remapProjectImport({
//       ...source,
//       project: detached,
//       projectFileBytes: serialiseProjectFile(detached)
//     });
//
// The order is safe in both directions — this pass touches no Layer and the remapping touches no
// publication field — and that is the argument for doing it here rather than folding it into the
// remapping, where the ticket-06 test asserts its absence.

import {
	inheritImportProvenance,
	type ImportProvenanceEntry
} from '../project/import-provenance.js';
import type { ProjectFile } from '../project/project-file.js';
import type { ProjectImportOrigin } from './project-import-source.js';

/**
 * One entry for the transfer that is happening now, from what its source observed.
 *
 * **Nothing is derived and nothing is inferred.** Every field is copied from a
 * {@link ProjectImportOrigin}, which is itself only what a source reader saw: a filename is the file
 * the user picked, a repository owner is the account the bytes came from, and a Project name is the
 * string inside `project.json`. None of the three is an author, and turning any of them into one is
 * the failure this narrowness exists to prevent (SPEC stories 61, 62).
 *
 * A Review's `directory` is deliberately dropped: it names a folder inside a Workspace that is about
 * to be thrown away, so it identifies nothing a reader could ever look at.
 */
export function observedImportProvenance(
	origin: ProjectImportOrigin,
	observedAt: Date
): ImportProvenanceEntry {
	const common = { observedAt: observedAt.toISOString(), evidence: 'observed' as const };
	switch (origin.kind) {
		case 'github':
			return {
				kind: 'github',
				owner: origin.owner,
				repository: origin.repository,
				branch: origin.branch,
				directory: origin.directory,
				commit: origin.commit,
				...common
			};
		case 'project-bundle':
			return {
				kind: 'project-bundle',
				filename: origin.fileName,
				projectName: origin.projectName,
				...common
			};
		case 'review':
			return { kind: 'review', projectName: origin.projectName, ...common };
	}
}

/**
 * The Project as a **detached local copy**: no source publication identity, off the Front Page, and
 * one more entry in its transfer history.
 *
 * The history is appended to rather than replaced, and what was already there becomes `inherited` —
 * so a Project handed on three times says so, and says which of the three this build witnessed
 * (stories 63–65). An entry is never removed: a Project whose route this build cannot fully read
 * still keeps every entry it arrived with.
 *
 * ⚠ **`canonicalUrl` is cleared and survives only inside the entry**, where it is a historical route
 * rather than an address (story 55, 56). Left in place it would be a copy claiming the source's
 * citable IIIF endpoint as its own, and the next publish would offer to stamp somebody else's site.
 *
 * ⚠ **`onFrontPage` is `false` whatever the source chose**, because the source's choice was about the
 * source's site (story 53). It is not privacy and nothing here should be read as making it privacy:
 * the imported Project is as publishable as any other, and the control that decides the listing says
 * so in words.
 */
export function detachImportedProject(
	project: ProjectFile,
	origin: ProjectImportOrigin,
	observedAt: Date
): ProjectFile {
	return {
		...project,
		canonicalUrl: null,
		onFrontPage: false,
		importProvenance: [
			...inheritImportProvenance(project.importProvenance ?? []),
			observedImportProvenance(origin, observedAt)
		]
	};
}

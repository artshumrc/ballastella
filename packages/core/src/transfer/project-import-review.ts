// Importing the Project a reviewer is looking at, into the Workspace they were looking at it *from*
// (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE DESTINATION IS A THING THAT WAS WRITTEN DOWN RATHER THAN A THING THAT IS LOOKED UP
//
// Every other Import copies into the Workspace that is open, which is the Workspace the offer named
// a sentence ago. A review Import cannot: the Workspace that is open *is* the review copy, and it is
// about to be deleted. So the destination has to come from somewhere, and there are only two places
// it could come from — the Workspace the reviewer happens to be able to reach now, or the one they
// were in when they opened the thing they are reading.
//
// It is the second, and the difference is not academic. A teacher marking thirty submissions moves
// between Workspaces constantly; the banner's first exit exists precisely so they can. An Import that
// resolved "my Workspace" at the moment it ran would copy a student's work into whichever Workspace
// that wandering had left behind, delete the review copy, and report success. So the origin is
// written into the Review mark before the first Project byte lands, and this module is what refuses
// when there is none or when the one there is cannot be opened.
//
// ⚠ **Nothing here chooses a destination, and there is nowhere to add one.** Not the current
// Workspace, not the last one of the user's own, not a Workspace whose display name matches, and
// never a new one: a Workspace created to receive a copy is a Workspace the author never made, and
// the review copy would be deleted into it. Refusing costs a reviewer one press of "Back to my
// Workspace" and an Import from a bundle they still have. The alternative costs somebody the copy and
// the original at once.

import type { ReviewMark, ReviewOrigin } from '../project/review-workspace.js';
import { describeReviewSubject } from '../project/review-workspace.js';

/** Why the ordinary Workspace a Review recorded cannot receive the copy. */
export type ReviewDestinationRefusal =
	/** The mark records none — every review copy made before ADR-0037, and any made without one. */
	| 'no-origin'
	/** It is not there any more: deleted, or the folder replaced by another of the same name. */
	| 'gone'
	/** It is there and will not answer — an unplugged disk, a folder that has moved. */
	| 'unreachable'
	/** The folder grant was declined, so this browser may not write into it. */
	| 'permission-denied';

/**
 * The recorded destination will not receive this copy, and the review copy is still here.
 *
 * ⚠ **Every message ends on the same clause, and it is the load-bearing half.** A reviewer meeting a
 * refusal has one question — "have I lost what I was reading?" — and the answer is always no: nothing
 * is discarded until the Import has committed and the destination has been opened. A refusal that did
 * not say so would send somebody looking for a copy they still have.
 */
export class ReviewDestinationUnavailableError extends Error {
	readonly refusal: ReviewDestinationRefusal;

	constructor(refusal: ReviewDestinationRefusal, message: string) {
		super(`${message} Nothing has been Imported, and this review copy is still here.`);
		this.name = 'ReviewDestinationUnavailableError';
		this.refusal = refusal;
	}
}

/**
 * The ordinary Workspace this review copy may be Imported into.
 *
 * @throws ReviewDestinationUnavailableError `'no-origin'` for a mark that records none, which is
 *   every review copy made before ADR-0037. Such a copy stays reviewable, editable and discardable;
 *   what it may not do is have a destination inferred for it.
 */
export function reviewImportOrigin(mark: ReviewMark): ReviewOrigin {
	if (mark.origin !== null) return mark.origin;
	throw new ReviewDestinationUnavailableError(
		'no-origin',
		`This review copy does not record which of your Workspaces it was opened from, so there is no ` +
			`one Workspace to Import ${describeReviewSubject(mark)} into — and Ballastella will not ` +
			`choose one for you. Go back to your own Workspace and Import the file or the link there ` +
			`instead.`
	);
}

/**
 * Refuse the recorded destination, in the words the reviewer should see.
 *
 * ⚠ **The Workspace is named and nothing is offered in its place.** Naming it is what lets a reviewer
 * act — a folder they can plug back in, a Workspace they deleted this morning — and offering an
 * alternative is precisely what this operation must never do.
 *
 * @throws ReviewDestinationUnavailableError always
 */
export function refuseReviewDestination(
	origin: ReviewOrigin,
	refusal: Exclude<ReviewDestinationRefusal, 'no-origin'>
): never {
	const named = origin.backing === 'folder' ? `the folder “${origin.name}”` : `“${origin.name}”`;
	const because: Record<Exclude<ReviewDestinationRefusal, 'no-origin'>, string> = {
		gone:
			`This review copy was opened from ${named}, and ${named} is not there any more — deleted, ` +
			`or replaced by something else of the same name.`,
		unreachable:
			`This review copy was opened from ${named}, and ${named} cannot be reached from this ` +
			`browser right now.`,
		'permission-denied':
			`This review copy was opened from ${named}, and Ballastella was not given permission to ` +
			`write there.`
	};
	throw new ReviewDestinationUnavailableError(refusal, because[refusal]);
}

/**
 * What is left to do after an Import that committed and a discard that did not.
 *
 * ⚠ **Reported rather than repaired, and never by deleting the Project that just arrived.** Past the
 * commit there is durable work of the user's own in their own Workspace; the review copy failing to
 * go is untidiness, and rolling the Import back to tidy it would destroy the thing the whole
 * operation existed to keep. So the copy stays, the sentence says so, and the reviewer discards it
 * from the banner the next time they open it.
 */
export function reviewCopyStillHere(reviewWorkspaceName: string, projectName: string): string {
	return (
		`“${projectName}” was Imported and is in your Workspace. The review copy ` +
		`“${reviewWorkspaceName}” could not be discarded, so it is still in your list of Workspaces — ` +
		`open it and discard it from the banner when you are ready.`
	);
}

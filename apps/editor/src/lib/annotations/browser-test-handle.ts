/** One Annotation write the app performed, as the Playwright suite reads it back. */
export type AnnotationWrite = {
	/** Path within the Workspace, so a write to the wrong Project or Layer cannot pass unnoticed. */
	path: string;
	/** How many Annotations the written document carried. */
	annotations: number;
};

declare global {
	interface Window {
		/**
		 * Every Annotation write the app has made, in order, for the Playwright suite.
		 *
		 * The same bargain `ballastellaAlignmentWrites` struck in ticket 07, and for the same reason:
		 * ticket 10's vertex criterion is about a **count** — editing a vertex must produce exactly one
		 * store write, on gesture end (ADR-0017 rule 1). A per-pointer-move implementation passes any
		 * "did it save?" assertion and fails this one, so the number is the whole point, and a write
		 * into OPFS issues no request so there is nothing outside the page to count.
		 *
		 * It is not an API. Nothing in `src/` may read it.
		 */
		ballastellaAnnotationWrites?: AnnotationWrite[];
	}
}

/**
 * Note that an Annotation Layer's document reached the store. Called after the write resolves, so an
 * attempt the store refused is deliberately absent — the criterion is about writes that happened.
 */
export function recordAnnotationWrite(path: string, annotations: number): void {
	// Only ever appended to a list somebody else created: the suite assigns an empty array before it
	// starts watching, which also gives it a way to clear the log between navigations. Absent means
	// nobody is watching.
	if (typeof window === 'undefined') return;
	window.ballastellaAnnotationWrites?.push({ path, annotations });
}

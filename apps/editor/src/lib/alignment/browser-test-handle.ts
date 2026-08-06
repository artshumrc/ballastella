/** One Alignment write the app performed, as the Playwright suite reads it back. */
export type AlignmentWrite = {
	/** Path within the Workspace, so a write to the wrong Project or image cannot pass unnoticed. */
	path: string;
	/** How many complete Control Points the written document carried. */
	controlPoints: number;
};

declare global {
	interface Window {
		/**
		 * Every Alignment write the app has made, in order, for the Playwright suite.
		 *
		 * This exists because ticket 07's drag criterion is about a **count**: dragging a Control
		 * Point must produce exactly one store write, on pointer-up (ADR-0017 rule 1). A
		 * per-pointer-move implementation passes any "did it save?" assertion and fails this one, so
		 * the number is the whole point — and a write into OPFS issues no request, so there is nothing
		 * outside the page to count.
		 *
		 * The alternative was a map- or store-abstraction layer, which SPEC's Seam 2 rules out on
		 * purpose: it would test a fake instead of the thing that ships. So this is the same bargain
		 * `ballastellaServedTiles` struck in ticket 06 and `ballastellaBaseMap` in ticket 04 — one
		 * property, written only here, read only by `e2e/`.
		 *
		 * It is not an API. Nothing in `src/` may read it.
		 */
		ballastellaAlignmentWrites?: AlignmentWrite[];
	}
}

/**
 * Note that an Alignment reached the store. Called after the write resolves, so an attempt that
 * failed is deliberately absent — the criterion is about writes that happened.
 */
export function recordAlignmentWrite(path: string, controlPoints: number): void {
	// Only ever appended to a list somebody else created: the suite assigns an empty array before it
	// starts watching, which also gives it a way to clear the log between navigations. Absent means
	// nobody is watching.
	if (typeof window === 'undefined') return;
	window.ballastellaAlignmentWrites?.push({ path, controlPoints });
}

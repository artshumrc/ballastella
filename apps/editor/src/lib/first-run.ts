/**
 * Whether the editor has ever been opened on this browser.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR, AND WHAT IT IS DELIBERATELY NOT
 *
 * With nothing in it, Workspace Home is a screen whose every control belongs to somebody who
 * already has work: two empty lists, an Import menu, two offers to review what a colleague sent,
 * and a door to GitHub. A first visit therefore makes a Project and opens it, so that the first
 * thing a scholar meets is a Base Map they can draw on.
 *
 * ⚠ **It asks nothing, and it must never grow a question.** ADR-0001's amendment moved the choice
 * between backings out of first contact and ADR-0042 restated it: the first Workspace appears
 * silently and browser-backed, because a folder is a capability upgrade and never a gate, and a
 * first-time author cannot answer the question anyway. This module is what makes that silence
 * reach further — into the first Project as well as the first Workspace — and not a place to put
 * the question back.
 *
 * `localStorage`, beside ADR-0020's Base Map preference and the community-lookup setting. It is a
 * fact about this person and this browser rather than anything of the Workspace's: `sessionStorage`
 * would make every new tab a first visit and mint a Project in each, and a record inside the
 * Workspace would make the second Workspace somebody creates a first visit all over again.
 */
const STORAGE_KEY = 'ballastella.visited';

/**
 * Latched for the life of the document, so one page can never mint two Projects.
 *
 * The reactive read that calls this re-runs when the Project list changes, which is precisely what
 * making a Project does — so the write below is not on its own enough to close the loop.
 */
let claimed = false;

/**
 * Whether this is a first visit, recording it as it answers. True at most once per document.
 *
 * ⚠ **A browser that will not answer is not a first visit.** A `getItem` that throws is paired with
 * a `setItem` that throws — Safari in a private window, a blocked third-party context — so a `true`
 * here could never be written down, and every load would make another Project for somebody who
 * already has ten. Every other reader of `localStorage` in this app degrades to the harmless side
 * of its own question, and the harmless side of this one is that the visitor has been here before.
 */
export function claimFirstVisit(): boolean {
	if (claimed) return false;
	claimed = true;
	try {
		if (globalThis.localStorage.getItem(STORAGE_KEY) === 'yes') return false;
		globalThis.localStorage.setItem(STORAGE_KEY, 'yes');
		return true;
	} catch {
		return false;
	}
}

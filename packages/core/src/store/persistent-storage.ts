// Whether this **origin's** storage is evictable, which is a question about the browser and not
// about any Workspace (ADR-0024).
//
// Its own module because it names no Workspace, no Project and no path: `navigator.storage.persist()`
// covers the whole origin — OPFS, IndexedDB, Cache Storage, the lot — so a Workspace happens to be
// what benefits rather than what is being asked about. It lived in `opfs-workspaces.ts` for one
// commit, where it was the only export that did not take or return a Workspace name.

/**
 * What the browser answered when asked to keep this origin's storage.
 *
 * Three states rather than two, because "this browser has no such API" is not a refusal and must not
 * be reported to the user as one.
 */
export type StoragePersistence = 'granted' | 'refused' | 'unsupported';

/**
 * Ask the browser to stop treating this origin's storage as evictable, and report what it said.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS IS A DATA-LOSS FIX, NOT A NICETY (ADR-0024)
 *
 * `navigator.storage.persist()` was called nowhere in this tree, so OPFS data was best-effort and
 * evictable under disk pressure. That was tolerable while browser storage was a starter store; it is
 * not, now that it is the primary home for a shared pool of gigabyte pyramids (ADR-0023) — and it is
 * where every user on Firefox, Safari, and iPadOS keeps everything they have, because File System
 * Access exists on none of them.
 *
 * **`persisted()` is asked first, and that is not an optimisation.** Firefox's `persist()` opens a
 * permission prompt; asking again on every load of an origin that already has the grant is the
 * nagging ADR-0012 rules out. Chromium grants or declines silently on its own heuristics —
 * installing the app is what usually turns it — so the answer is worth *recording* rather than
 * acting on.
 *
 * The refusal is returned rather than swallowed because the user is entitled to know that the thing
 * holding all of their work is evictable, and what to do about it. **What is said to them is
 * `storage-durability.ts`'s**, not this answer: what to do about it differs by engine, and this
 * function's three states cannot tell a browser that will ask from one that never will. This is the
 * asking; that is the telling.
 *
 * `storage` is injectable so the three answers can be asserted. A real browser cannot be made to
 * produce all three — Chromium decides on its own heuristics, and Firefox's `persist()` blocks on a
 * permission prompt that never appears with no user gesture — so a test against the real API can
 * only assert that *something* came back, which is the shape of assertion that passes when the
 * function has been deleted. The real call is exercised by the running app in
 * `e2e/editor-named-workspaces.e2e.ts`.
 */
export async function requestPersistentStorage(
	storage: StorageManager | undefined = typeof navigator === 'undefined'
		? undefined
		: navigator.storage
): Promise<StoragePersistence> {
	if (typeof storage?.persist !== 'function' || typeof storage?.persisted !== 'function') {
		return 'unsupported';
	}
	try {
		if (await storage.persisted()) return 'granted';
		return (await storage.persist()) ? 'granted' : 'refused';
	} catch {
		// A browser that has the methods and throws from them is one that cannot answer, which is what
		// `unsupported` means to every caller. Reporting it as a refusal would tell the user their
		// browser declined something it was never asked.
		return 'unsupported';
	}
}

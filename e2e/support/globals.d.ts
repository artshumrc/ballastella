// The globals `e2e/support/test.ts` installs in the page. See that file for why they exist.

declare global {
	/**
	 * The Workspace the app currently has open, in OPFS — a **named subdirectory of the root**, not
	 * the root itself.
	 *
	 * Which one that is follows the editor's own `localStorage`, so a spec that has switched
	 * Workspaces reads the one it is looking at rather than the default.
	 *
	 * ⚠ **Created if it is not there**, which is what seeding needs and what the app does on load.
	 * That makes it the wrong helper for "has this Workspace been deleted?" — it would answer with an
	 * empty directory, which is indistinguishable from one that is there and empty. Use
	 * {@link workspaceRootIfAny} for that.
	 *
	 * Available inside any `page.evaluate` on a `page` from `e2e/support/test.ts`.
	 */
	function workspaceRoot(): Promise<FileSystemDirectoryHandle>;

	/**
	 * The same directory, or `null` when it is not there. Creates nothing.
	 *
	 * For the one question {@link workspaceRoot} cannot answer honestly: whether a Workspace still
	 * exists.
	 */
	function workspaceRootIfAny(): Promise<FileSystemDirectoryHandle | null>;
}

export {};

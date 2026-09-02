/**
 * Whether the Sync modal is on screen.
 *
 * The bar's own control opens it for a Workspace that has a repository, and it is mounted once, by
 * the bar. Anything else that ends where syncing begins — the guided sequence, which stops at the
 * connection; a link from a published site, which makes a Workspace and connects it — opens this
 * same modal through {@link SyncModal.start} rather than mounting a second copy.
 *
 * A module singleton in the shape `connectSequence`, `editHistorySlot` and `theme` established. Not
 * a context: the bar is mounted outside the layout's `children()`, so a context provided by a route
 * is not in scope for it.
 */
class SyncModal {
	/** Bound into the one Sync modal the navigation bar mounts. */
	open = $state(false);

	/** Open it from wherever the author pressed. */
	start(): void {
		this.open = true;
	}
}

export const syncModal = new SyncModal();

/**
 * A request to open the Workspace's own editing dialog, from somewhere that is not its roster row.
 *
 * The dialog is the roster row's (ADR-0042) and is mounted once, by the navigation bar, over the
 * Workspace that row names. What this carries is the *ask*: the Sync modal's **Repository settings…**
 * is a handoff to the standing relationship rather than a second copy of it, and the modal has no
 * access to the roster's rows.
 *
 * A module singleton in the shape `connectSequence` and `syncModal` established. Not a context: the
 * bar is mounted outside the layout's `children()`, so a context provided by a route is not in scope.
 */
class WorkspaceSettings {
	/** Whether the dialog has been asked for. Taken back down by the bar, which opens it. */
	asked = $state(false);

	/** Ask for the open Workspace's editing dialog. */
	start(): void {
		this.asked = true;
	}
}

export const workspaceSettings = new WorkspaceSettings();

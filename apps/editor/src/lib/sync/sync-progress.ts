// What a Sync is doing right now, said in two places at two lengths.
//
// Here rather than inside `SyncDialog.svelte` because two components render it: the modal, from a
// live region inside the open `<dialog>` — the only non-inert subtree while a Sync runs — and the
// navigation bar's one GitHub control, whose label has to reflect progress while it is
// `aria-disabled`. Two hand-written sentences would be two things that can come to disagree about
// which phase a Sync is in, which is precisely the fact a scholar is watching them for.

/** A Sync has three phases, and a scholar can tell them apart only if they are named. */
export type SyncPhase =
	/** Bringing the Remote's changes into the Workspace. */
	| 'getting'
	/** Writing the viewer's files into the Workspace, for a Workspace with Share Links. */
	| 'writing'
	/** Sending the Workspace to its Remote. */
	| 'sending';

export type SyncProgress = {
	readonly phase: SyncPhase;
	readonly files: number;
	readonly totalFiles: number;
	/**
	 * GitHub's hourly budget as the last response reported it, or `null`.
	 *
	 * `null` while getting or writing locally, where there is no such budget to report, and also for
	 * a Remote whose responses carry no rate-limit headers — a corporate proxy strips them. Left out
	 * of the sentence rather than shown as a zero, which would read as "no requests left at all".
	 */
	readonly requestsRemaining: number | null;
};

const PHASE_VERB: Record<SyncPhase, string> = {
	getting: 'Getting',
	writing: 'Writing the viewer',
	sending: 'Sending'
};

/**
 * The whole sentence, for the live region inside the modal.
 *
 * ⚠ **Three numbers while sending, because a Sync can be slow for three different reasons and a
 * scholar cannot tell them apart otherwise**: files done and files total say whether it is moving,
 * and the remaining hourly budget is the only warning that it is about to stop. Two numbers make a
 * Sync that halts at 900 of 4 000 files look like a hang.
 */
export function describeSyncProgress(progress: SyncProgress | null): string {
	if (progress === null) return '';
	const counted = `${progress.files} of ${progress.totalFiles} files`;
	const budget =
		progress.requestsRemaining === null
			? ''
			: ` ${progress.requestsRemaining} GitHub requests left this hour.`;
	return `${PHASE_VERB[progress.phase]}: ${counted}.${budget}`;
}

/**
 * What the navigation bar's one GitHub control says while a Sync runs.
 *
 * Short, because it is a button on a bar with four other controls on it, and the full sentence is
 * being announced from inside the modal at the same moment.
 */
export function syncControlLabel(progress: SyncProgress | null): string {
	if (progress === null) return 'Syncing…';
	return `${PHASE_VERB[progress.phase]}… ${progress.files}/${progress.totalFiles}`;
}

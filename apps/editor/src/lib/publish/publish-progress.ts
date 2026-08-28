// What a publish is doing right now, said in two places at two lengths.
//
// Here rather than inside `PublishDialog.svelte` because two components render it: the dialog, from
// a live region inside the open modal — the only non-inert subtree while a publish runs — and the
// navigation bar's Publish control, whose label has to reflect progress while it is `aria-disabled`.
// Two hand-written sentences would be two things that can come to disagree about which phase a
// publish is in, which is precisely the fact a scholar is watching them for.

/** A publish has two phases, and a scholar can tell them apart only if they are named. */
export type PublishPhase =
	/** Writing the viewer's files into the Workspace. No network, and no request budget. */
	| 'writing'
	/** Sending the Workspace to its Remote. */
	| 'uploading';

export type PublishProgress = {
	readonly phase: PublishPhase;
	readonly files: number;
	readonly totalFiles: number;
	/**
	 * GitHub's hourly budget as the last response reported it, or `null`.
	 *
	 * `null` while writing locally, where there is no such budget, and also for a Remote whose
	 * responses carry no rate-limit headers — a corporate proxy strips them. Left out of the sentence
	 * rather than shown as a zero, which would read as "no requests left at all".
	 */
	readonly requestsRemaining: number | null;
};

/**
 * The whole sentence, for the live region inside the modal.
 *
 * ⚠ **Three numbers while uploading, because a publish can be slow for three different reasons and
 * a scholar cannot tell them apart otherwise**: files done and files total say whether it is moving,
 * and the remaining hourly budget is the only warning that it is about to stop. Two numbers make a
 * publish that halts at 900 of 4 000 files look like a hang.
 */
export function describePublishProgress(progress: PublishProgress | null): string {
	if (progress === null) return '';
	const counted = `${progress.files} of ${progress.totalFiles} files`;
	if (progress.phase === 'writing') return `Publishing: ${counted}.`;
	const budget =
		progress.requestsRemaining === null
			? ''
			: ` ${progress.requestsRemaining} GitHub requests left this hour.`;
	return `Uploading: ${counted}.${budget}`;
}

/**
 * What the navigation bar's Publish control says while it runs.
 *
 * Short, because it is a button on a bar with four other controls on it, and the full sentence is
 * being announced from inside the modal at the same moment.
 */
export function publishControlLabel(progress: PublishProgress | null): string {
	if (progress === null) return 'Publishing…';
	return progress.phase === 'writing'
		? `Publishing… ${progress.files}/${progress.totalFiles}`
		: `Uploading… ${progress.files}/${progress.totalFiles}`;
}

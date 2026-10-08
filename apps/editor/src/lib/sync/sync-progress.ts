type SyncPhase = 'getting' | 'writing' | 'sending';

export type SyncProgress = {
	readonly phase: SyncPhase;
	readonly files: number;
	readonly totalFiles: number;
	readonly requestsRemaining: number | null;
};

const PHASE_VERB: Record<SyncPhase, string> = {
	getting: 'Getting',
	writing: 'Writing the viewer',
	sending: 'Sending'
};

export function describeSyncProgress(progress: SyncProgress | null): string {
	if (progress === null) return '';
	const counted = `${progress.files} of ${progress.totalFiles} files`;
	const budget =
		progress.requestsRemaining === null
			? ''
			: ` ${progress.requestsRemaining} GitHub requests left this hour.`;
	return `${PHASE_VERB[progress.phase]}: ${counted}.${budget}`;
}

export function syncControlLabel(progress: SyncProgress | null): string {
	if (progress === null) return 'Syncing…';
	return `${PHASE_VERB[progress.phase]}… ${progress.files}/${progress.totalFiles}`;
}

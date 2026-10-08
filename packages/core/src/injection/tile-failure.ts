export type TileSourceFailure =
	| { readonly kind: 'no-answer'; readonly host: string | null }
	| { readonly kind: 'file-missing'; readonly host: string | null }
	| { readonly kind: 'server-error'; readonly host: string | null; readonly status: number }
	| { readonly kind: 'unreadable'; readonly host: string | null; readonly detail: string };

const where = (host: string | null): string => (host === null ? 'this site' : host);

export function mapImageTilesUnavailableNotice(
	failure: TileSourceFailure,
	mapName: string | null = null
): string {
	const subject = mapName === null ? 'A Map Image on this page' : `The Map Image “${mapName}”`;
	return `${subject} ${cause(failure)} ${SAFE} ${remedy(failure)}`;
}

function cause(failure: TileSourceFailure): string {
	switch (failure.kind) {
		case 'no-answer':
			return `stopped drawing, because ${where(failure.host)} could not be reached.`;
		case 'file-missing':
			return `stopped drawing, because ${where(failure.host)} does not hold the file it is drawn from.`;
		case 'server-error':
			return `stopped drawing, because ${where(failure.host)} answered ${failure.status}.`;
		case 'unreadable':
			return `stopped drawing, because its tiles could not be read from ${where(failure.host)}: ${failure.detail}`;
	}
}

const SAFE =
	'Nothing you did caused this, and nothing has been lost: the Annotations and the rest of the ' +
	'author’s work are unaffected, and whatever of the map had already been drawn is still on screen.';

function remedy(failure: TileSourceFailure): string {
	switch (failure.kind) {
		case 'no-answer':
			return (
				'That is either your connection or that server, and there is no way to tell which from ' +
				`here. ${WHEN_IT_ANSWERS_AGAIN}`
			);
		case 'file-missing':
			return (
				'Reconnecting will not help, because the file is not there to fetch. Whoever made ' +
				'this site has to restore it.'
			);
		case 'server-error':
			return (
				'The server answered, so your own connection is working and it is that server that is ' +
				`failing. ${WHEN_IT_ANSWERS_AGAIN}`
			);
		case 'unreadable':
			return 'Reloading the page is the thing most likely to help.';
	}
}

const WHEN_IT_ANSWERS_AGAIN =
	'When it is answering again the map picks up what it can by itself; anything still missing ' +
	'comes back if you hide this Layer and show it again, or reload the page.';

export const TILE_RECOVERY_DELAYS: readonly number[] = [
	250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000
];

export function keepAskingForMissingTiles(askAgain: (delivered: () => void) => void): () => void {
	let next = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const schedule = (): void => {
		const delay = TILE_RECOVERY_DELAYS[next];
		if (stopped || delay === undefined) return;
		next += 1;
		timer = setTimeout(() => {
			timer = undefined;
			let spent = false;
			askAgain(() => {
				if (spent) return;
				spent = true;
				schedule();
			});
		}, delay);
	};

	schedule();

	return () => {
		stopped = true;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
}

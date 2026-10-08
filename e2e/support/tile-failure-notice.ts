const SAFE =
	'Nothing you did caused this, and nothing has been lost: the Annotations and the rest of the ' +
	'author’s work are unaffected, and whatever of the map had already been drawn is still on screen.';

const WHEN_IT_ANSWERS_AGAIN =
	'When it is answering again the map picks up what it can by itself; anything still missing ' +
	'comes back if you hide this Layer and show it again, or reload the page.';

/**
 * The row for a request that got no answer at all — what an aborted route looks like to `fetch`.
 *
 * @param mapName the Layer's name, as the stack shows it
 * @param where the host that did not answer, or `this site` when there was no host to name
 */
export function tilesUnavailableNotice(mapName: string, where: string): string {
	return (
		`The Map Image “${mapName}” stopped drawing, because ${where} could not be reached. ` +
		`${SAFE} That is either your connection or that server, and there is no way to tell which ` +
		`from here. ${WHEN_IT_ANSWERS_AGAIN}`
	);
}

export function tilesServerErrorNotice(mapName: string, where: string, status: number): string {
	return (
		`The Map Image “${mapName}” stopped drawing, because ${where} answered ${status}. ` +
		`${SAFE} The server answered, so your own connection is working and it is that server that ` +
		`is failing. ${WHEN_IT_ANSWERS_AGAIN}`
	);
}

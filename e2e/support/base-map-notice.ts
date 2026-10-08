export function unavailableNotice(label: string, host: string): string {
	return (
		`The Base Map “${label}” could not be loaded from ${host}. ` +
		'Nothing in your Workspace is affected — your Map Images, their Alignments and your ' +
		'Annotations are all still here and still saving, and they will draw over the geography ' +
		'again as soon as a Base Map does. ' +
		'This Base Map is fetched from another server, so this is usually that server rather ' +
		'than your connection. Try another Base Map, or make this Project available offline ' +
		'while one is working so it keeps drawing when none is.'
	);
}

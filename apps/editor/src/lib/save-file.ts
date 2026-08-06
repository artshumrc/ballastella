/**
 * Hand a stream of bytes to the user as a file.
 *
 * Its own module because it is the one place in the editor that reaches for the DOM to *produce*
 * something rather than to render it, and because there is a real choice here worth naming.
 *
 * `Response(…).blob()` rather than accumulating chunks into an array first: a `Blob` is backed by
 * the browser's own storage, which spills to disk, so the archive does not have to fit in the JS
 * heap. Exporting a mirrored pyramid of several hundred megabytes is the case this has to survive,
 * and it is exactly the case where the user has no folder access to fall back on (ADR-0001).
 *
 * `showSaveFilePicker` would stream straight to a file the user picked and is better still, but it
 * is Chromium-only — the browsers this path exists *for* do not have it — so it belongs with ticket
 * 12's File System Access work rather than here, where it would be the untested branch.
 */
export async function saveFile(fileName: string, body: ReadableStream<Uint8Array>): Promise<void> {
	const blob = await new Response(body).blob();
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = fileName;
		link.rel = 'noopener';
		// Not appended to the document: a click on a detached anchor still downloads, and nothing
		// flashes into the page.
		link.click();
	} finally {
		// After the click, which has already taken its own reference to the blob.
		URL.revokeObjectURL(url);
	}
}

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
	const link = document.createElement('a');
	link.href = url;
	link.download = fileName;
	link.rel = 'noopener';
	// Not appended to the document: a click on a detached anchor still downloads, and nothing
	// flashes into the page.
	link.click();
	// Revoked on a later task, not in the same one as the click.
	//
	// Chromium takes its own reference to the blob synchronously, so revoking immediately is safe
	// there — and Chromium is the only browser this repository's e2e suite runs. Safari has
	// historically cancelled a download whose object URL was revoked before it had started reading,
	// which makes an immediate revoke a correctness bet placed in exactly the browsers nothing here
	// tests, on the one path ADR-0001 makes those browsers' only way out. A macrotask costs nothing
	// and removes the bet; the URL is still released, so the blob is still collectable.
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

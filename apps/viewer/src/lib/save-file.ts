/**
 * Hand a Blob to the Reader as a file.
 *
 * Its own module because it is the one place in this application that reaches for the DOM to
 * *produce* something rather than to render it.
 *
 * **A Blob rather than a stream, which is the difference from the editor's twin** (`save-file.ts`
 * there): that one exists for a Project Bundle of several hundred megabytes and takes a
 * `ReadableStream` so the archive never has to fit in the JS heap. A Published Site downloads one
 * Map Snapshot, which arrives already encoded as a Blob, and lifting either into a shared package
 * would mean lifting the other's shape with it. So this is deliberately the smaller half, kept
 * local, rather than a shared utility neither app quite wants.
 *
 * `showSaveFilePicker` would stream straight to a file the Reader picked, but it is Chromium-only
 * and a Published Site is read on whatever browser a scholar has; an anchor is the path every one of
 * them takes.
 */
export function saveFile(fileName: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = fileName;
	link.rel = 'noopener';
	// Not appended to the document: a click on a detached anchor still downloads, and nothing
	// flashes into the page.
	link.click();
	// Revoked on a later task, not in the same one as the click. Chromium takes its own reference to
	// the blob synchronously, so an immediate revoke is safe there — but Safari has historically
	// cancelled a download whose object URL was revoked before it had started reading, and a
	// Published Site is exactly where the browser is not ours to choose. A macrotask costs nothing
	// and removes the bet; the URL is still released, so the blob is still collectable.
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

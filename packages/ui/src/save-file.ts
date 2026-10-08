export async function saveFile(
	fileName: string,
	data: Blob | ReadableStream<Uint8Array>
): Promise<void> {
	const blob = data instanceof Blob ? data : await new Response(data).blob();
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = fileName;
	link.rel = 'noopener';
	link.click();
	// Safari cancels a download whose URL is revoked synchronously.
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

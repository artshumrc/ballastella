export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
	const framed = new Uint8Array(header.byteLength + bytes.byteLength);
	framed.set(header, 0);
	framed.set(bytes, header.byteLength);

	const digest = await crypto.subtle.digest('SHA-1', framed);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

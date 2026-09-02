// The name git gives a file's bytes, computed in a browser.
//
// Three features rest on this one function agreeing with git exactly, and they are the three that
// make sending to a Remote bearable at all: a second send that uploads only what changed, a
// refusal to overwrite another machine's work, and a get that resumes rather than restarts. Each
// of them compares a SHA computed here against one GitHub computed there. If the arithmetic is
// wrong they are all wrong at once, in the same direction, and none of them says so — an unchanged
// pyramid re-uploads, a conflict is missed, a resumed get re-downloads. `blob-sha.test.ts`
// therefore checks the output against real `git hash-object` values rather than against itself.

/**
 * The hex SHA-1 git would give `bytes`, which is `sha1("blob " + byteLength + "\0" + bytes)`.
 *
 * Async because it goes through `crypto.subtle.digest`, which is the one SHA-1 that exists in both
 * a browser and Node. **Do not add a synchronous variant**: it would mean a second implementation
 * of the hash, and two implementations of this is the state the paragraph above describes.
 */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
	// A fresh buffer rather than a view: `bytes` may be a `subarray` of something larger, and a
	// digest taken over the underlying buffer would hash its neighbours too.
	const framed = new Uint8Array(header.byteLength + bytes.byteLength);
	framed.set(header, 0);
	framed.set(bytes, header.byteLength);

	const digest = await crypto.subtle.digest('SHA-1', framed);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

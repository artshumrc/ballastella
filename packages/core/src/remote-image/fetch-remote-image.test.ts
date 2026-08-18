import { describe, expect, it } from 'vitest';

import {
	REMOTE_IMAGE_LIMITS,
	RemoteImageRefusedError,
	fetchRemoteImageFile
} from './fetch-remote-image';

/** A response that is bytes with a type, which is all a plain image file ever is. */
const image = (bytes: number, contentType = 'image/jpeg', init: ResponseInit = {}) =>
	new Response(new Uint8Array(bytes).fill(0xff), {
		headers: { 'content-type': contentType },
		...init
	});

const refusal = (promise: Promise<unknown>): Promise<RemoteImageRefusedError | null> =>
	promise.then(
		() => null,
		(cause: unknown) => cause as RemoteImageRefusedError
	);

describe('fetchRemoteImageFile', () => {
	it('hands back the bytes as a file named after the address', async () => {
		const file = await fetchRemoteImageFile('https://images.example.test/maps/la-floride.jpg', {
			fetch: async () => image(64)
		});

		expect(file.name).toBe('la-floride.jpg');
		expect(file.type).toBe('image/jpeg');
		expect(file.size).toBe(64);
	});

	it('gives a name to an address that has none, from what the host says it sent', async () => {
		// A shelfmark-style identifier with no extension is ordinary at a library, and the name is what
		// the Map Image is labelled — so it has to be readable rather than empty.
		const file = await fetchRemoteImageFile('https://images.example.test/objects/MS-44', {
			fetch: async () => image(16, 'image/png')
		});

		expect(file.name).toBe('MS-44.png');
		expect(file.type).toBe('image/png');
	});

	it('refuses a response that is not an image, naming what arrived', async () => {
		const failure = await refusal(
			fetchRemoteImageFile('https://images.example.test/maps/la-floride.jpg', {
				fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
			})
		);

		expect(failure?.host).toBe('images.example.test');
		expect(failure?.message).toContain('application/json');
		expect(failure?.message).toContain('Nothing has been added');
	});

	it('refuses an SVG in terms of what it is, rather than as a file that could not be read', async () => {
		// It would reach `createImageBitmap` and be rejected there as unreadable, which reads as a
		// corrupt download. It is not corrupt; it is a drawing with no pixels to cut tiles from.
		const failure = await refusal(
			fetchRemoteImageFile('https://images.example.test/maps/plan.svg', {
				fetch: async () => image(32, 'image/svg+xml')
			})
		);

		expect(failure?.message).toContain('SVG drawing');
		expect(failure?.message).toContain('PNG or a JPEG');
	});

	it('names the status a host answered with', async () => {
		const failure = await refusal(
			fetchRemoteImageFile('https://images.example.test/maps/gone.jpg', {
				fetch: async () => image(4, 'image/jpeg', { status: 404, statusText: 'Not Found' })
			})
		);

		expect(failure?.message).toContain('404 Not Found');
	});

	it('says what a host that could not be reached at all means, including the CORS case', async () => {
		const failure = await refusal(
			fetchRemoteImageFile('https://images.example.test/maps/la-floride.jpg', {
				fetch: async () => {
					throw new TypeError('Failed to fetch');
				}
			})
		);

		expect(failure?.message).toContain('does not allow other websites to read its files');
		expect(failure?.message).toContain('add it from a file instead');
	});

	it('stops reading a response larger than the bound, without believing content-length', async () => {
		// The same lesson as the IIIF reader's: a declared size is a claim. The header lies about being
		// small and the body streams for ever.
		let chunksSent = 0;
		const failure = await refusal(
			fetchRemoteImageFile('https://images.example.test/maps/endless.jpg', {
				limits: { responseBytes: 4096 },
				fetch: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							pull(controller) {
								chunksSent += 1;
								controller.enqueue(new Uint8Array(1024).fill(0xff));
							}
						}),
						{ headers: { 'content-type': 'image/jpeg', 'content-length': '12' } }
					)
			})
		);

		expect(failure?.message).toContain('larger than the');
		expect(chunksSent).toBeLessThan(10);
	});

	it('refuses an address that would be written into the Workspace with a password in it', async () => {
		// The URL hygiene the IIIF reader applies, applied here too: this path writes no `remote.json`,
		// but a refusal has to be the same whichever of the two a pasted address turns out to name.
		await expect(
			fetchRemoteImageFile('https://scholar:secret@images.example.test/maps/la-floride.jpg', {
				fetch: async () => image(4)
			})
		).rejects.toThrow(/username or password/);
	});

	it('abandons the download when the caller cancels, without reporting a refusal', async () => {
		const controller = new AbortController();
		const failure = await refusal(
			fetchRemoteImageFile('https://images.example.test/maps/la-floride.jpg', {
				signal: controller.signal,
				fetch: async (_input, init) => {
					controller.abort();
					init?.signal?.throwIfAborted();
					return image(4);
				}
			})
		);

		expect(failure).not.toBeInstanceOf(RemoteImageRefusedError);
		expect(controller.signal.aborted).toBe(true);
	});

	it('bounds a download far above a real scan and far below a tab that never ends', () => {
		expect(REMOTE_IMAGE_LIMITS.responseBytes).toBe(256 * 1024 * 1024);
	});
});

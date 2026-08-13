// A Project Bundle to open, which is how a spec gets a Review Workspace on screen.

import { packTar } from 'modern-tar';

/** What `setInputFiles` wants: a named tar in memory. */
export type BundleFile = { name: string; mimeType: string; buffer: Buffer };

/**
 * A one-Project bundle: `project.json` at the root, which is what a bundle is.
 *
 * Shared rather than copied because two suites open one to reach the same state — a review copy with
 * the reader's own credential sealed behind it — and a bundle that drifted between them would be two
 * specs disagreeing about what "somebody else's Project" is.
 */
export async function oneProjectBundle(name = 'Amsterdam 1625'): Promise<BundleFile> {
	const encode = (text: string) => new TextEncoder().encode(text);
	const files: Record<string, string> = {
		'project.json': `${JSON.stringify({
			formatVersion: 1,
			name,
			updatedAt: '2025-03-04T11:22:33.000Z',
			layers: [],
			baseMap: 'protomaps-light'
		})}\n`
	};
	return {
		name: 'amsterdam-1625.project.tar',
		mimeType: 'application/x-tar',
		buffer: Buffer.from(
			await packTar(
				Object.entries(files).map(([path, text]) => ({
					header: { name: path, size: encode(text).length, type: 'file' as const },
					body: encode(text)
				}))
			)
		)
	};
}

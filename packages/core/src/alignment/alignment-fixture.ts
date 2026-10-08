import type { Bytes, ProjectStore } from '../store/project-store.js';

export function seedAlignmentFixture(
	store: ProjectStore,
	imageId: string,
	bytes: Bytes | number
): Promise<void> {
	const content = typeof bytes === 'number' ? (new Uint8Array(bytes) as Bytes) : bytes;
	return store.write(`alignments/${imageId}.json`, content);
}

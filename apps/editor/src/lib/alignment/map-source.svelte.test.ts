import type { MapImageSource } from '@ballastella/core';
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';

import { mapImageSourceOf } from './map-source.svelte.js';

const IMAGE_ID = 'a-library-sheet';
const SERVICE = 'https://images.test/iiif/3/florida';

function inARoot(body: () => void): void {
	const dispose = $effect.root(body);
	try {
		flushSync();
	} finally {
		dispose();
	}
}

describe('where the Map Image being aligned is served from', () => {
	it('does not re-run its readers when an unrelated Workspace read has answered', () => {
		let referenced = $state.raw<{ imageId: string; service: string }[]>([
			{ imageId: IMAGE_ID, service: SERVICE }
		]);
		const lookUp = (imageId: string): MapImageSource => {
			const found = referenced.find((image) => image.imageId === imageId);
			return found
				? { imageMode: 'referenced', imageId, service: found.service }
				: { imageMode: 'offline-copy', imageId };
		};

		let runs = 0;
		let seen: MapImageSource | undefined;
		inARoot(() => {
			const source = mapImageSourceOf(lookUp, () => IMAGE_ID);
			$effect(() => {
				seen = source.current;
				runs += 1;
			});
			flushSync();
			expect(runs).toBe(1);
			expect(seen).toEqual({ imageMode: 'referenced', imageId: IMAGE_ID, service: SERVICE });
			referenced = [{ imageId: IMAGE_ID, service: SERVICE }];
			flushSync();
			expect(runs, 'an unrelated Workspace read rebuilt the pane').toBe(1);
			referenced = [];
			flushSync();
			expect(runs).toBe(2);
			expect(seen).toEqual({ imageMode: 'offline-copy', imageId: IMAGE_ID });
		});
	});
});

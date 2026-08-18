// The two derives that stop a live alignment being rebuilt underneath the scholar (ticket 07).
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHAT IS COUNTED HERE IS **HOW MANY TIMES A DEPENDENT EFFECT RAN**, AND NOTHING ELSE.       │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// Both guards in `map-source.svelte.ts` are about identity rather than about values, so asserting
// the value each derive produces proves nothing: the collapsed, broken form produces exactly the
// same values. What separates the two forms is whether a dependent effect re-runs when something
// unrelated upstream changed, and re-running is what tears the warped layer off the map and
// re-reads the pyramid under a half-placed Control Point.
//
// So each test holds an effect over the derived values, changes something that must not matter, and
// asserts the effect did not run again. Collapse either helper into a single object-valued
// `$derived` and both go red.
//
// This runs on Svelte's **client** runtime — see `vitest.config.ts`, which is emphatic about why.
// The server runtime's `derived` is an uncached thunk, under which every assertion here would pass
// against code that has no reactivity at all.

import type { MapImageSource } from '@ballastella/core';
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';

import { mapImageSourceOf, warpedAddressOf } from './map-source.svelte.js';

const IMAGE_ID = 'a-library-sheet';
const SERVICE = 'https://images.test/iiif/3/florida';

/**
 * Run `body` inside a reactive root and tear it down afterwards.
 *
 * `flushSync` between the steps rather than `await tick()`, so the assertions sit between two
 * settled states rather than between two microtask queues.
 */
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
		// A stand-in for `EditorSession.remoteOrigins` — the `$state` behind `mapImageSource`,
		// which is re-assigned by every Workspace walk the session makes, most of which have nothing to
		// do with the map on screen.
		let referenced = $state.raw<{ imageId: string; service: string }[]>([
			{ imageId: IMAGE_ID, service: SERVICE }
		]);
		// Rebuilt on every call, exactly as the session's own method is. This is the fact the guard
		// exists for: a `$derived` holding this object takes a new identity whenever `referenced` does.
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

			// A Workspace walk finishing: the same map, the same Library, a new array. In the running app
			// this is `refreshAddableMapImages` in another Project's dialog, or a Workspace refresh,
			// or another map being added — none of which is a reason to rebuild this pane.
			referenced = [{ imageId: IMAGE_ID, service: SERVICE }];
			flushSync();
			expect(runs, 'an unrelated Workspace read rebuilt the pane').toBe(1);

			// And the guard is not simply inertness: a map copied offline really does change the answer,
			// and the pane must be rebuilt then, because from that moment it should read the Workspace's
			// own pyramid rather than the Library's.
			referenced = [];
			flushSync();
			expect(runs).toBe(2);
			expect(seen).toEqual({ imageMode: 'offline-copy', imageId: IMAGE_ID });
		});
	});
});

describe('the address the warped renderer is built from', () => {
	it('does not rebuild the warped layer when the source object is merely re-made', () => {
		let source = $state.raw<MapImageSource | null>({
			imageMode: 'referenced',
			imageId: IMAGE_ID,
			service: SERVICE
		});

		let runs = 0;
		inARoot(() => {
			const address = warpedAddressOf(() => source);
			$effect(() => {
				void address.referenced;
				void address.service;
				runs += 1;
			});
			flushSync();
			expect(runs).toBe(1);

			// The same address, a new object. Adding the warped layer again here costs every warped tile
			// a refetch and a re-decode, in the middle of somebody's alignment.
			source = { imageMode: 'referenced', imageId: IMAGE_ID, service: SERVICE };
			flushSync();
			expect(runs, 'the warped layer was rebuilt for an identical address').toBe(1);

			// The unguarded direction: an offline copy changes where the tiles are, and the renderer's
			// document carries that address, so this one *must* rebuild.
			source = { imageMode: 'offline-copy', imageId: IMAGE_ID };
			flushSync();
			expect(runs).toBe(2);
		});
	});
});

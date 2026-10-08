import type { Layer } from '@ballastella/core';
import { flushSync } from 'svelte';
import { expect, test } from 'vitest';

import { ANNOTATION_INSPECTOR_ID } from './constants.js';
import { MapView, annotationRow, returnFocusFromInspector } from './map-view.svelte.js';

const SHEET = { kind: 'map', id: 'sheet', name: 'Harbour', imageId: 'harbour-1891' } as Layer;

test('names the Map Image whose tiles stopped, and clears a failed Base Map when another is chosen', () => {
	let entry = $state('first');
	const dispose = $effect.root(() => {
		const view = new MapView(
			() => [SHEET],
			() => entry
		);
		const failure = { kind: 'no-answer', host: null } as const;
		view.onTileOutcome({ ok: false, failure, imageId: 'harbour-1891' });
		expect(view.tilesUnavailable).toContain('“Harbour”');
		view.onTileOutcome({ ok: true });
		expect(view.tilesMissing).toBe(false);

		flushSync();
		view.onBaseMapStatus('unavailable');
		expect(view.baseMapUnavailable).toBe(true);
		entry = 'second';
		flushSync();
		expect(view.baseMapUnavailable).toBe(false);
	});
	dispose();
});

test('closing the inspector returns focus to its row only when focus would strand', async () => {
	document.body.innerHTML = `
		<ul><li data-testid="annotation-row" data-annotation-id="a1" tabindex="-1"></li></ul>
		<aside id="${ANNOTATION_INSPECTOR_ID}"><button>Close</button></aside>
		<input />`;
	const row = annotationRow(document.body, 'a1');

	document.querySelector('input')!.focus();
	await returnFocusFromInspector(row);
	expect(document.activeElement?.tagName).toBe('INPUT');

	document.querySelector('button')!.focus();
	await returnFocusFromInspector(row);
	expect(document.activeElement).toBe(row);
	document.body.innerHTML = '';
});

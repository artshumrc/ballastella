import { describe, expect, it } from 'vitest';

import * as core from './index';

describe('@ballastella/core', () => {
	it('exposes the image pane projection to both apps', () => {
		// The behaviour of these lives in `src/image-pane`; this only asserts that they are
		// reachable through the package entry point the apps import.
		expect(Object.keys(core).sort()).toEqual([
			'ROUND_TRIP_TOLERANCE_PX',
			'WINDOW_TILE_ZOOM',
			'createImagePane',
			'createSyntheticProjection'
		]);
	});
});

import { describe, expect, it } from 'vitest';

import * as core from './index';

describe('@ballastella/core', () => {
	it('resolves and exposes the Base Map surface from the package entry point', () => {
		// The apps import from '@ballastella/core', never from a file inside it, so the entry point
		// is the contract. ADR-0020 has the published viewer carrying the catalog too, so this edge
		// has to hold for both apps.
		expect(typeof core.resolveBaseMap).toBe('function');
		expect(typeof core.baseMapStyle).toBe('function');
		expect(core.BASE_MAP_CATALOG.entries.length).toBeGreaterThan(0);
	});
});

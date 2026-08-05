import { describe, expect, it } from 'vitest';

import * as core from './index';

describe('@ballastella/core', () => {
	it('resolves and exposes no public API yet', () => {
		expect(Object.keys(core)).toEqual([]);
	});
});

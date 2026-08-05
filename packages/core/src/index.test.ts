import { describe, expect, it } from 'vitest';

import * as core from './index';

describe('@ballastella/core', () => {
	it('resolves from its package entry point', () => {
		expect(core).toBeDefined();
	});
});

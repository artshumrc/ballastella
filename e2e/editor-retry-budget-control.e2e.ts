import { expect, test } from './support/test.js';

test('a test that only passes on its retry is counted against the budget', async ({
	page
}, testInfo) => {
	test.skip(
		process.env.BALLASTELLA_E2E_RETRY_CONTROL !== '1',
		'the retry-budget positive control; see the header of this file for the two commands'
	);
	await page.goto('./');
	expect(testInfo.retry, 'the first attempt fails on purpose').toBeGreaterThan(0);
});

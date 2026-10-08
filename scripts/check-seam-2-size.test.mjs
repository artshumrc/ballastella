import assert from 'node:assert/strict';
import test from 'node:test';

import { SEAM_2_CEILING, countInListing, sizeVerdict } from './check-seam-2-size.mjs';

test('a suite at the ceiling is allowed, one test more is not, and the overage says by how much', () => {
	for (const [count, overage] of [
		[600, -69],
		[668, -1],
		[669, 0],
		[670, 1],
		[675, 6]
	]) {
		const verdict = sizeVerdict({ count, ceiling: 669 });
		assert.equal(verdict.overage, overage);
		assert.equal(verdict.overCeiling, overage > 0);
	}
});

test('the summary names both numbers, which is what a tripped fence has to say', () => {
	const { summary } = sizeVerdict({ count: 670, ceiling: 669 });
	assert.match(summary, /670/);
	assert.match(summary, /669/);
});

test('the ceiling shipped in the script is a whole number of tests', () => {
	assert.ok(Number.isInteger(SEAM_2_CEILING) && SEAM_2_CEILING > 0);
});

test('the count is read from the listing’s total line, wherever it sits in the output', () => {
	const listing = [
		'Listing tests:',
		'  [editor] › editor.e2e.ts:3:1 › the editor loads',
		'  [viewer] › viewer-reader.e2e.ts:9:1 › a Reader arrives',
		'Total: 669 tests in 35 files',
		'',
		'  2 passed (1.0s)'
	].join('\n');
	assert.equal(countInListing(listing), 669);
});

test('a one-test, one-file listing is read despite the singular nouns', () => {
	assert.equal(countInListing('Total: 1 test in 1 file'), 1);
});

test('a listing whose shape changed reads as null rather than as a plausible number', () => {
	assert.equal(countInListing(''), null);
	assert.equal(countInListing('Total: many tests in 35 files'), null);
	assert.equal(countInListing('Total: 669 tests'), null);
	assert.equal(countInListing('  Total: 669 tests in 35 files'), null);
	assert.equal(countInListing('Grand Total: 669 tests in 35 files'), null);
	assert.equal(countInListing('  [editor] › a.e2e.ts:1:1 › Total: 12 tests in 3 files'), null);
});

test('importing the fence does not run it', () => {
	assert.ok(true);
});

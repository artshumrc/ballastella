// The size fence's decision and its parser, pinned away from a Playwright process.
//
// The end-to-end half is exercised by `BALLASTELLA_SEAM_2_CEILING=<current − 1>`, which must fail —
// see the header of `check-seam-2-size.mjs`. This is the arithmetic and the reading underneath it,
// where a wrong boundary would make the fence permissive without making it noisy, and a lenient
// parser would let a changed listing format be read as a small suite.

import assert from 'node:assert/strict';
import test from 'node:test';

import { SEAM_2_CEILING, countInListing, sizeVerdict } from './check-seam-2-size.mjs';

test('a suite exactly at the ceiling is allowed, and one test more is not', () => {
	assert.equal(sizeVerdict({ count: 669, ceiling: 669 }).overCeiling, false);
	assert.equal(sizeVerdict({ count: 670, ceiling: 669 }).overCeiling, true);
	assert.equal(sizeVerdict({ count: 668, ceiling: 669 }).overCeiling, false);
});

test('the overage is how far over the ceiling the suite is, and negative when under it', () => {
	assert.equal(sizeVerdict({ count: 675, ceiling: 669 }).overage, 6);
	assert.equal(sizeVerdict({ count: 669, ceiling: 669 }).overage, 0);
	assert.equal(sizeVerdict({ count: 600, ceiling: 669 }).overage, -69);
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
	// The failure mode worth a branch: this fence dying silent. Anything that is not the total line
	// must not produce a count, however many digits it carries.
	assert.equal(countInListing(''), null);
	assert.equal(countInListing('Total: many tests in 35 files'), null);
	assert.equal(countInListing('Total: 669 tests'), null);
	assert.equal(countInListing('  Total: 669 tests in 35 files'), null);
	assert.equal(countInListing('Grand Total: 669 tests in 35 files'), null);
	// A test title that happens to quote the shape is not the summary line either.
	assert.equal(countInListing('  [editor] › a.e2e.ts:1:1 › Total: 12 tests in 3 files'), null);
});

test('importing the fence does not run it', () => {
	// The whole reason the two functions above are testable: the module's imperative half is guarded,
	// so this file costs no `playwright test --list`. Reaching this assertion at all is the proof.
	assert.ok(true);
});

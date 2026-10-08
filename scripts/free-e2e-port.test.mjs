import assert from 'node:assert/strict';
import test from 'node:test';
import process from 'node:process';

import { parsePids } from './free-e2e-port.mjs';

test('reads the pids out of `lsof -t` output', () => {
	assert.deepEqual(parsePids('1987028\n'), [1987028]);
	assert.deepEqual(parsePids('1987028\n1987029\n'), [1987028, 1987029]);
});

test('reads `fuser` output, which pads with spaces rather than newlines', () => {
	assert.deepEqual(parsePids(' 1987028  1987029\n'), [1987028, 1987029]);
});

test('never yields pid 0, whatever whitespace the tool leaves behind', () => {
	for (const output of ['1987028\n', '1987028 ', '1987028\n\n', '\n1987028\n', '']) {
		assert.equal(
			parsePids(output).includes(0),
			false,
			`pid 0 slipped through for ${JSON.stringify(output)}`
		);
	}
	assert.deepEqual(parsePids(''), []);
	assert.deepEqual(parsePids('\n'), []);
	assert.deepEqual(parsePids('   \n  \n'), []);
});

test('refuses a literal 0 even when a tool reports one', () => {
	assert.deepEqual(parsePids('0\n'), []);
	assert.deepEqual(parsePids('0 1987028\n'), [1987028]);
});

test('never yields this process, so freeing a port cannot stop the run doing the freeing', () => {
	assert.deepEqual(parsePids(`${process.pid}\n`), []);
	assert.deepEqual(parsePids(`${process.pid} 1987028\n`), [1987028]);
});

test('ignores anything that is not a run of digits', () => {
	assert.deepEqual(parsePids('20003/tcp: 1987028\n'), [1987028]);
	assert.deepEqual(parsePids('-1\n'), []);
	assert.deepEqual(parsePids('nope\n'), []);
});

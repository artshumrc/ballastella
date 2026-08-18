// Every branch of the sentence that says who else this Alignment belongs to (SPEC story 56).
//
// The browser suite reaches exactly one of these — align a map in one Project — which is why this
// file exists: the plural, and both spellings of the newer-build caveat, need a Workspace shaped by
// hand and are otherwise asserted by nothing at all.

import { describe, expect, it } from 'vitest';

import { describeAlignmentUsers } from './used-by.js';

const project = (name: string) => ({ directory: name.toLowerCase().replace(/\s+/g, '-'), name });

describe('who else this Alignment belongs to', () => {
	it('names the one Project when only this one draws the map', () => {
		const said = describeAlignmentUsers({
			usedBy: [project('Amsterdam 1625')],
			mightBeUsedBy: []
		});
		expect(said).toContain('Right now that is Amsterdam 1625.');
		expect(said).toContain('shared by every Project that draws this Map Image');
		// No plural claim over a single Project, which would be a sentence about a risk that is not
		// there — and this screen's whole job here is to be exact about how far an edit reaches.
		expect(said).not.toContain('Projects do');
	});

	it('counts them and says the edit moves all of them when several draw it', () => {
		const said = describeAlignmentUsers({
			usedBy: [project('Amsterdam 1625'), project('Boston 1775'), project('Lisbon 1755')],
			mightBeUsedBy: []
		});
		expect(said).toContain('3 Projects do: Amsterdam 1625, Boston 1775, Lisbon 1755');
		// The consequence, said out loud. ADR-0023's accepted risk is exactly this, and the scholar
		// refining a placement is the person who has to know it.
		expect(said).toContain('Refining it here moves all of them.');
	});

	it('adds a singular caveat for one Project this build cannot read', () => {
		const said = describeAlignmentUsers({
			usedBy: [project('Amsterdam 1625')],
			mightBeUsedBy: [project('from-the-future')]
		});
		expect(said).toContain('It may also be drawn by from-the-future');
		expect(said).toContain('a newer version of Ballastella');
	});

	it('pluralises that caveat for more than one', () => {
		const said = describeAlignmentUsers({
			usedBy: [project('Amsterdam 1625'), project('Boston 1775')],
			mightBeUsedBy: [project('from-the-future'), project('later-still')]
		});
		expect(said).toContain('They may also be drawn by from-the-future, later-still');
		// And the two halves are one sentence rather than two lists: the caveat follows the count.
		expect(said.indexOf('2 Projects do')).toBeLessThan(said.indexOf('They may also'));
	});

	it('says nothing at all while there is no answer, and nothing when the list is empty', () => {
		// `null` is "the walk has not answered", which every render before it resolves passes in.
		expect(describeAlignmentUsers(null)).toBe('');
		// An empty list cannot happen on this screen — see the function's own note — and silence is the
		// answer if it somehow does. Asserted so that a future author who makes it reachable finds a
		// test naming the decision rather than a branch of prose nobody can check.
		expect(
			describeAlignmentUsers({ usedBy: [], mightBeUsedBy: [project('from-the-future')] })
		).toBe('');
	});
});

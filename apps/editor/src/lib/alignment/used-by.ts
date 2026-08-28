// Which Projects a Map Image's Alignment is shared with, in words (ADR-0023).
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ A PURE FUNCTION BECAUSE THREE OF ITS FOUR BRANCHES HAVE NO GESTURE THAT REACHES THEM.      │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// Written inline in `AlignmentWorkspace.svelte`, only the one-Project sentence was ever exercised:
// a browser test can align a map in one Project, and everything else — two Projects sharing a map,
// a Project from a newer build that this one cannot read, the `It`/`They` of the caveat — needs a
// Workspace shaped by hand. Deleting the whole caveat expression left the suite green.
//
// Out here it is a string function over a record, and `used-by.test.ts` names every branch.

import type { MapImageUser } from '@ballastella/core';

/** Who draws one Map Image, as the Workspace's `refreshMapImages` walk answers it. */
export interface AlignmentUsers {
	/** The Projects whose Layers draw it, by directory order. */
	readonly usedBy: readonly MapImageUser[];
	/** Projects from a newer build, whose Layers this one cannot read — possible users of any map. */
	readonly mightBeUsedBy: readonly MapImageUser[];
}

/** The Projects' names, as the sentence lists them. */
const namesOf = (users: readonly MapImageUser[]): string =>
	users.map((project) => project.name).join(', ');

/**
 * Who else an Alignment belongs to, in one sentence, wherever that is read.
 *
 * The scope of every gesture on the alignment screen, and the scope of the Alignment behind a Map
 * Image row on the Workspace Home: one Alignment per Map Image, shared by every Project that draws
 * the map, so refining it moves all of them — published ones included.
 *
 * **The Project a reader came from is named too, not subtracted.** It is one of the Projects the
 * edit moves, and a list that quietly omitted it would read as "and these others", which
 * understates what is being changed.
 *
 * ⚠ **An empty `usedBy` is `''`, and the words for that case are the caller's.** The two callers
 * have different answers to it, which is why this one says nothing:
 *
 * - `ProjectHub.svelte` renders a row for every Map Image in the Workspace's pool, including maps no
 *   Project draws — that pool is what its reclaim figure is for — so it composes its own "No Project
 *   uses this map." and its own sentence for a map whose only possible users are Projects from a
 *   newer build.
 * The align sidebar is deliberately not a caller. The fact belongs to the Map Image rather than to
 *   the screen, so a scholar meets it on the Map Image's row before they start refining rather than
 *   beside the controls while they click.
 *
 * An earlier version composed prose here for an empty list and another paragraph for its
 * newer-build variant. Both spoke for a caller that had not been asked, and prose about who might
 * lose work belongs where the screen can say something true about it.
 */
export function describeAlignmentUsers(users: AlignmentUsers | null): string {
	if (!users || users.usedBy.length === 0) return '';

	const shared = 'One Alignment, shared by every Project that draws this Map Image';
	const caveat =
		users.mightBeUsedBy.length === 0
			? ''
			: ` ${users.mightBeUsedBy.length === 1 ? 'It' : 'They'} may also be drawn by ` +
				`${namesOf(users.mightBeUsedBy)}, made with a newer version of Ballastella, which this ` +
				'one cannot read.';

	// The plural branch is the whole reason the sentence exists: that refining one Alignment moves
	// several Projects is the fact a reader needs, and it cannot be inferred from a count.
	//
	// "Refining it", not "refining it here": this sentence reads on the Map Image's own row on the
	// Workspace Home, which carries no align control, so a deictic pointing at one would be false.
	// The fact travels with the Map Image rather than with the screen.
	return users.usedBy.length === 1
		? `${shared}. Right now that is ${namesOf(users.usedBy)}.${caveat}`
		: `${shared} — and ${users.usedBy.length} Projects do: ${namesOf(users.usedBy)}. ` +
				`Refining it moves all of them.${caveat}`;
}

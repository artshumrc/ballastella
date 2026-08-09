// Which Projects a Historical Map's Alignment is shared with, in words (SPEC story 56, ADR-0023).
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

import type { HistoricalMapUser } from '@ballastella/core';

/** Who draws one Historical Map, as `EditorSession.mapUsage` answers it. */
export interface AlignmentUsers {
	/** The Projects whose Layers draw it, by directory order. */
	readonly usedBy: readonly HistoricalMapUser[];
	/** Projects from a newer build, whose Layers this one cannot read — possible users of any map. */
	readonly mightBeUsedBy: readonly HistoricalMapUser[];
}

/** The Projects' names, as the sentence lists them. */
const namesOf = (users: readonly HistoricalMapUser[]): string =>
	users.map((project) => project.name).join(', ');

/**
 * What this screen says about who else this Alignment belongs to.
 *
 * The scope of every gesture on the alignment screen: one Alignment per Historical Map, shared by
 * every Project that draws the map, so refining it here moves all of them — published ones included.
 *
 * **The Project this screen was entered from is named too, not subtracted.** It is one of the
 * Projects the edit moves, and a list that quietly omitted it would read as "and these others",
 * which understates what is being changed.
 *
 * ⚠ **An empty `usedBy` is `''` rather than "no Project uses this map", and that is a decision.**
 * The hub has a real answer for it — a Historical Map can sit in the Workspace's pool with nothing
 * drawing it, which is exactly what its reclaim list is for. This screen effectively cannot: `/align`
 * is reached through a map Layer of an *open* Project, and the walk behind this reads that Project's
 * `project.json`, so ordinarily the open Project is in the list.
 *
 * "Ordinarily" and not "always, by construction", because the walk reads **disk**. A map added and
 * immediately aligned can be walked before ADR-0017 rule 2's debounce has committed the Layer, and
 * the walk runs once per Historical Map opened — so that visit gets an empty answer and keeps it.
 * That is the honest reachable case, and silence is still the right response to it: the alternative
 * is telling a scholar "no Project draws this map" about the Project they are standing in.
 *
 * An earlier version had a paragraph of prose for an empty list and another for its newer-build
 * variant. Both described a Workspace nobody could produce, and unreachable prose about who might
 * lose work is worse than silence, because nobody can check it.
 */
export function describeAlignmentUsers(users: AlignmentUsers | null): string {
	if (!users || users.usedBy.length === 0) return '';

	const shared = 'One Alignment, shared by every Project that draws this Historical Map';
	const caveat =
		users.mightBeUsedBy.length === 0
			? ''
			: ` ${users.mightBeUsedBy.length === 1 ? 'It' : 'They'} may also be drawn by ` +
				`${namesOf(users.mightBeUsedBy)}, made with a newer version of Ballastella, which this ` +
				'one cannot read.';

	// The plural is the whole reason this sentence is on this screen rather than only on the hub.
	return users.usedBy.length === 1
		? `${shared}. Right now that is ${namesOf(users.usedBy)}.${caveat}`
		: `${shared} — and ${users.usedBy.length} Projects do: ${namesOf(users.usedBy)}. ` +
				`Refining it here moves all of them.${caveat}`;
}

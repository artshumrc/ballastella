// What the Workspace hub renders: the Map Images list and its Project actions.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT MOVED HERE, AND WHAT DELIBERATELY DID NOT
//
// From `e2e/editor-workspace.e2e.ts`: three tests that each seeded four pyramids and two Projects
// into OPFS, booted the built editor, and then read a sentence out of a `<li>` — the label and the
// size, where the tiles are, and which Projects draw the map. Every one of those sentences is
// composed from a `WorkspaceMapImage` record and nothing else, so none of the scenery was
// load-bearing. The Front Page choice now belongs to the Publish dialog, where it is shown with the
// rest of the publishing decision.
//
// ⚠ **What did not move.**
//
// - **That the records are the Workspace's own.** This file passes them in. That the hub lists what
//   is really under `images/`, with the bytes the store really reports, is asserted by the merged
//   listing test in `e2e/editor-workspace.e2e.ts`, which is what keeps this file from being a test
//   of its own fixtures.
// - **That deleting reaches the Workspace, and that a refusal leaves the pyramid alone.** Bytes on
//   disk; `e2e/`'s, and `packages/core/src/project/map-images.test.ts`'s.
// - **Whether a map is used, and by which Projects.** A pure question over the Projects' own
//   documents, answered by `mapImageUsage` and asserted at Seam 1 — including ADR-0010's
//   newer-version case. What is asserted here is only the *sentence* the hub composes from the
//   answer.
// - **That the confirmation is a real `<dialog>` opened with `showModal()`.** ADR-0016's claim is
//   about the platform's own modality, which a DOM implementation approximates; it stays in `e2e/`.
//
// Everything is addressed by position and read straight off the document, per
// `layer-list.dom.test.ts`.

import type { ProjectSummary, WorkspaceMapImage } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test } from 'vitest';

import ProjectHubHarness from './ProjectHubHarness.svelte';

const map = (imageId: string, over: Partial<WorkspaceMapImage> = {}): WorkspaceMapImage => ({
	imageId,
	label: '',
	tiles: 'in-workspace',
	library: '',
	thumbnail: null,
	bytes: 50_000,
	files: 4,
	usedBy: [],
	mightBeUsedBy: [],
	...over
});

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

const hub = (props: {
	mapImages?: readonly WorkspaceMapImage[];
	projects?: readonly ProjectSummary[];
}): void => {
	mounted = mount(ProjectHubHarness, { target: document.body, props });
	flushSync();
};

/** Every Map Image card, in the order the hub renders them. */
const cards = (): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>('[data-testid="map-image"]')
];

const text = (element: Element | null): string =>
	(element?.textContent ?? '').replace(/\s+/g, ' ').trim();

const at = (testId: string): HTMLElement => {
	const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (!found) throw new Error(`nothing is rendered with data-testid="${testId}"`);
	return found;
};

describe('what a Map Image card says about the map', () => {
	// The file count beside the byte total, because "50 kB in 4 files" and "50 kB in 31 000 files"
	// are different news for a scholar deciding what to publish.
	test('names it, weighs it, and says how many files that is', () => {
		hub({
			mapImages: [
				map('shared', { label: 'Blaeu’s plan of Amsterdam' }),
				map('remote-one', { label: 'Plan de Paris', bytes: 400, files: 1 })
			]
		});

		expect(text(cards()[0])).toContain('Blaeu’s plan of Amsterdam');
		expect(text(cards()[0])).toContain('50 kB in 4 files');
		// Singular, because "1 files" is the sort of thing a scholar reads as a bug in the tool.
		expect(text(cards()[1])).toContain('in 1 file');
		expect(text(cards()[1])).not.toContain('1 files');
		// The folder name is on the card too: it is the Workspace's own identity for the map, and
		// what `?p=` and a Published Site's paths are built from.
		expect(text(cards()[0])).toContain('folder shared');
	});

	// A map whose records carry no label at all still has to be identifiable and deletable, so the
	// folder name stands in for the name rather than leaving an empty heading.
	test('falls back to the folder name when neither record gives it one', () => {
		hub({ mapImages: [map('untitled-scan')] });

		expect(text(document.querySelector('[data-testid="map-image"] h3'))).toBe('untitled-scan');
		// And the delete button is named for it, so a screen-reader user reading a column of them is
		// told which map each one destroys.
		expect(document.querySelector('[data-testid="map-image"] button')).toHaveAccessibleName(
			'Delete untitled-scan'
		);
	});

	// Visible text, not a badge colour and not a tooltip (SPEC story 111): this is the fact that
	// decides whether a Layer draws anything on a train.
	test('says whether the tiles are here or names the Library they are on', () => {
		hub({
			mapImages: [
				map('shared', { label: 'Blaeu’s plan of Amsterdam' }),
				map('remote-one', {
					label: 'Plan de Paris',
					tiles: 'referenced',
					library: 'iiif.bnf.example'
				})
			]
		});

		expect(text(cards()[0])).toContain('Tiles in this Workspace');
		expect(text(cards()[1])).toContain('Tiles on iiif.bnf.example');
	});

	// A referenced map whose record does not name a host still has to say that the tiles are
	// somebody else's, because that is the half of the sentence the user acts on.
	test('still says the tiles are elsewhere when the Library has no name', () => {
		hub({ mapImages: [map('remote-one', { tiles: 'referenced' })] });

		expect(text(cards()[0])).toContain('Tiles on a Library’s server');
	});
});

describe('which Projects draw a map, in the words the list uses (SPEC story 63)', () => {
	test('names them, and says plainly when none do', () => {
		hub({
			mapImages: [
				map('shared', {
					label: 'Blaeu’s plan of Amsterdam',
					usedBy: [
						{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' },
						{ directory: 'boston-1775', name: 'Boston 1775' }
					]
				}),
				map('solo', {
					label: 'Bonner’s Boston',
					usedBy: [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }]
				}),
				map('orphan', { label: 'A map nobody kept' })
			]
		});

		const usedBy = [...document.querySelectorAll('[data-testid="used-by"]')].map(text);
		expect(usedBy).toEqual([
			'Used by Amsterdam 1625, Boston 1775.',
			'Used by Amsterdam 1625.',
			'No Project uses this map.'
		]);
	});

	// ⚠ **ADR-0010's case, and the interesting one.** A `formatVersion: 2` Project is refused
	// *because it is intact* — its Layer stack is right there and certainly names Map Images.
	// Reading that refusal as "this Project uses nothing" is how a scholar is offered a delete button
	// for a map their next release still draws. So the sentence never calls such a map unused, and it
	// never claims to know that the Project draws it either.
	test('says a Project this build cannot read may draw it, rather than calling it unused', () => {
		hub({
			mapImages: [
				map('orphan', {
					label: 'A map nobody kept',
					mightBeUsedBy: [{ directory: 'from-the-future', name: 'from-the-future' }]
				})
			]
		});

		const sentence = text(at('used-by'));
		expect(sentence).not.toContain('No Project uses this map.');
		expect(sentence).toBe(
			'No Project this version can read uses this map. It may be drawn by from-the-future, made ' +
				'with a newer version of Ballastella.'
		);
	});

	// The same caveat where the map does have readable users: they are named as users, and the
	// unreadable one is named separately and in its own words rather than folded into the list.
	test('keeps the unreadable Project separate from the ones it can vouch for', () => {
		hub({
			mapImages: [
				map('shared', {
					usedBy: [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }],
					mightBeUsedBy: [
						{ directory: 'from-the-future', name: 'Tomorrow' },
						{ directory: 'later-still', name: 'Later Still' }
					]
				})
			]
		});

		expect(text(at('used-by'))).toBe(
			'Used by Amsterdam 1625. They may also be drawn by Tomorrow, Later Still, made with a newer ' +
				'version of Ballastella, which this one cannot read.'
		);
	});

	test('says “It” of a single unreadable Project and “They” of several', () => {
		hub({
			mapImages: [
				map('shared', {
					usedBy: [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }],
					mightBeUsedBy: [{ directory: 'from-the-future', name: 'Tomorrow' }]
				})
			]
		});

		expect(text(at('used-by'))).toContain('It may also be drawn by Tomorrow');
	});
});

describe('what the Workspace holds in total', () => {
	// The reclaim figure is the sentence the list exists for — "of which 50 kB is used by no
	// Project" — and it is core's `unusedMapImages`, not a second reduction over the same list.
	test('counts the maps, weighs them, and says how much of it nothing draws', () => {
		hub({
			mapImages: [
				map('shared', { usedBy: [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }] }),
				map('solo', { usedBy: [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }] }),
				map('orphan')
			]
		});

		expect(text(at('map-images-total'))).toBe(
			'3 Map Images, 150 kB in all, of which 50 kB is used by no Project.'
		);
	});

	// No reclaim clause when there is nothing to reclaim: a "0 kB is used by no Project" would read
	// as an invitation to go looking for something that is not there.
	test('says nothing about reclaiming when every map is in use', () => {
		hub({
			mapImages: [
				map('shared', { usedBy: [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' }] })
			]
		});

		expect(text(at('map-images-total'))).toBe('1 Map Image, 50 kB in all.');
	});

	// A map a Project this build cannot read might draw is not reclaimable, so it must not be
	// counted in the figure that invites the user to delete something.
	test('does not offer a map an unreadable Project might draw as reclaimable', () => {
		hub({
			mapImages: [
				map('orphan', {
					mightBeUsedBy: [{ directory: 'from-the-future', name: 'Tomorrow' }]
				})
			]
		});

		expect(text(at('map-images-total'))).toBe('1 Map Image, 50 kB in all.');
	});
});

// A Workspace with nothing in it says so, rather than rendering an empty section a user has to
// interpret. The hub has no "add a Map Image" of its own — a map is added inside the Project that
// draws it first — so the empty state states the fact and nothing more.
test('a Workspace with no Map Images says so', () => {
	hub({ mapImages: [] });

	expect(cards()).toHaveLength(0);
	expect(text(at('no-map-images'))).toBe('No Map Images yet.');
	// And no total, because there is no total to state.
	expect(document.querySelector('[data-testid="map-images-total"]')).toBeNull();
});

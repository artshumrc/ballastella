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
	provenance: null,
	...over
});

const project = (directory: string, over: Partial<ProjectSummary> = {}): ProjectSummary => ({
	directory,
	name: directory,
	description: '',
	updatedAt: '2026-01-02T03:04:05.000Z',
	onFrontPage: true,
	problem: null,
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
	mapImagesLoading?: boolean;
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
		expect(text(cards()[0])).not.toContain('folder shared');
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

	// Visible text, not a badge colour and not a tooltip: this is the fact that decides whether a
	// Layer draws anything on a train.
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

	test('expands a referenced Map Image’s stored provenance', () => {
		hub({
			mapImages: [
				map('remote-one', {
					provenance: { source: 'https://library.example/iiif/collection', canvasLabel: 'Plan 2' }
				})
			]
		});

		const button = [...cards()[0].querySelectorAll('button')].find(
			(button) => text(button) === 'Provenance'
		);
		expect(button).toHaveAttribute('aria-expanded', 'false');
		expect(document.querySelector('[data-testid="map-image-provenance"]')).toBeNull();

		button?.click();
		flushSync();

		expect(button).toHaveAccessibleName('Hide provenance');
		expect(text(at('map-image-provenance'))).toContain('Source');
		expect(text(at('map-image-provenance'))).toContain('https://library.example/iiif/collection');
		expect(text(at('map-image-provenance'))).toContain('Canvas Plan 2');
	});

	test('does not turn an invalid provenance value into a link', () => {
		hub({
			mapImages: [
				map('remote-one', {
					provenance: { source: 'javascript:alert(1)', canvasLabel: '' }
				})
			]
		});

		[...cards()[0].querySelectorAll('button')]
			.find((button) => text(button) === 'Provenance')
			?.click();
		flushSync();

		const provenance = at('map-image-provenance');
		expect(text(provenance)).toContain('javascript:alert(1)');
		expect([...provenance.querySelectorAll('a')]).toEqual([]);
	});
});

describe('which Projects draw a map, in the words the list uses', () => {
	// ⚠ **The sentence is `alignment/used-by.ts`'s, and this row is where it renders.** One Alignment
	// belongs to a Map Image and is shared by every Project drawing it (ADR-0023), so what refining it
	// moves is a fact about *this map* — read here, before the align screen, rather than beside the
	// controls while a scholar is clicking. `used-by.test.ts` names every branch of the sentence; what
	// is asserted here is that this row renders it, and the two branches it is silent about.
	test('names them, says what refining moves, and says plainly when none do', () => {
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
			// The plural branch, and the reason the sentence is worth this much: two Projects are named,
			// counted, and told that refining the Alignment here moves both.
			'One Alignment, shared by every Project that draws this Map Image — and 2 Projects do: ' +
				'Amsterdam 1625, Boston 1775. Refining it moves all of them.',
			'One Alignment, shared by every Project that draws this Map Image. Right now that is ' +
				'Amsterdam 1625.',
			// `describeAlignmentUsers` is silent about a map nothing readable draws, and this list is
			// not: a Map Image can sit in the pool with nothing drawing it, which is what the reclaim
			// figure below is for, so the empty answer is the row's own words.
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
			'One Alignment, shared by every Project that draws this Map Image. Right now that is ' +
				'Amsterdam 1625. They may also be drawn by Tomorrow, Later Still, made with a newer ' +
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

describe('each list under a heading carrying its own count', () => {
	// ⚠ **Beside the heading and not inside it.** Every spec that arrives at this screen does so
	// through `heading, { name: 'Projects' }` or `{ name: 'Map Images' }`, which is a whole-string
	// match — so a figure inside the `<h2>` would break all of them, for a number that is not part of
	// what the section is called. The noun is in `sr-only` text so the count is still a sentence read
	// aloud, and the two accessible names are asserted here rather than left to those specs.
	test('states each count beside its heading, leaving the headings named what they were', () => {
		hub({
			projects: [project('amsterdam-1625'), project('boston-1775'), project('la-floride')],
			mapImages: [map('shared'), map('solo')]
		});

		expect([...document.querySelectorAll('section h2')].map(text)).toEqual([
			'Projects',
			'Map Images'
		]);
		expect(text(at('projects-count'))).toBe('3 Projects');
		expect(text(at('map-images-count'))).toBe('2 Map Images');
	});

	// "1 Projects" is the sort of thing a scholar reads as a bug in the tool.
	test('says one Project and one Map Image in the singular', () => {
		hub({ projects: [project('amsterdam-1625')], mapImages: [map('shared')] });

		expect(text(at('projects-count'))).toBe('1 Project');
		expect(text(at('map-images-count'))).toBe('1 Map Image');
	});

	// A count of nothing is not a count of nothing *yet*: while the walk is still weighing `images/`
	// the list has no answer, and rendering `0` would state one it does not have.
	test('states no Map Image count while the Workspace is still being weighed', () => {
		hub({ mapImages: [], mapImagesLoading: true });

		expect(document.querySelector('[data-testid="map-images-count"]')).toBeNull();
	});
});

describe('a row’s actions, and the one that is destructive', () => {
	/** The Project row, found by the control only a Project's row has. */
	const projectRow = (): HTMLElement => {
		const found = [...document.querySelectorAll<HTMLElement>('li')].find((row) =>
			[...row.querySelectorAll('button')].some((button) => text(button).startsWith('Edit'))
		);
		if (!found) throw new Error('no Project row is rendered');
		return found;
	};

	// Open, Edit, Duplicate and nothing else. Nothing destructive is in the row at all: Delete is
	// inside the Edit dialog, behind its own confirmation, so no click on this list can be the first
	// half of losing a Project.
	test('offers a Project row Open, Edit and Duplicate, and nothing in error', () => {
		hub({ projects: [project('amsterdam-1625', { name: 'Amsterdam 1625' })] });

		const row = projectRow();
		const buttons = [...row.querySelectorAll('button')];
		// By accessible name, because each label's per-row half is `sr-only` text beside the verb.
		expect(buttons).toHaveLength(3);
		expect(buttons[0]).toHaveAccessibleName('Open Amsterdam 1625');
		expect(buttons[1]).toHaveAccessibleName('Edit Amsterdam 1625');
		expect(buttons[2]).toHaveAccessibleName('Duplicate Amsterdam 1625');
		expect(row.querySelectorAll('.btn-error')).toHaveLength(0);
	});

	// A description is the author's own prose, so the line breaks they typed are the ones a reader
	// gets. `whitespace-pre-line` is what does that, and CSS is not applied in this seam — so what is
	// pinned here is the class carrying it and the text arriving unmangled.
	test('renders a Project’s description, keeping the breaks its author typed', () => {
		hub({
			projects: [project('amsterdam-1625', { description: 'Blaeu, 1649.\n\nSheets 1–4 only.' })]
		});

		const described = at('project-description');
		expect(described.textContent).toContain('Blaeu, 1649.\n\nSheets 1–4 only.');
		expect(described.className).toContain('whitespace-pre-line');
	});

	test('says nothing at all about a Project whose author wrote no description', () => {
		hub({ projects: [project('amsterdam-1625')] });

		expect(document.querySelector('[data-testid="project-description"]')).toBeNull();
	});

	// A Map Image's row has the one action, and it is the same one in the same colour.
	test('leaves a Map Image row with Delete alone', () => {
		hub({ mapImages: [map('shared', { label: 'Blaeu’s plan of Amsterdam' })] });

		const buttons = [...cards()[0].querySelectorAll('button')];
		expect(buttons).toHaveLength(1);
		expect(buttons[0]).toHaveAccessibleName('Delete Blaeu’s plan of Amsterdam');
		expect(buttons[0].className).toContain('btn-error');
	});

	// ⚠ **ADR-0036: emphasis and selection are a ground tint, never a coloured left edge.** A row is
	// where that habit would land first, so nothing inside one may carry a left border — the only
	// left border on this screen is the boundary between the two columns, which is not in a row.
	test('marks nothing in a row with a left border', () => {
		hub({
			projects: [project('amsterdam-1625', { problem: 'format-too-new' })],
			mapImages: [map('shared')]
		});

		const edged = [...document.querySelectorAll('li, li *')].filter((element) =>
			/(^|[\s:])border-l/.test(element.className.toString())
		);
		expect(edged).toEqual([]);
	});
});

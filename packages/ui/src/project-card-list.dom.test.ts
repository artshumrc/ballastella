// The list of Project cards the Hub and the Front Page share, asserted against the component rather
// than against either app.
//
// The same markup used to be written twice — `card bg-base-100 card-border` in
// `apps/editor/src/lib/components/ProjectHub.svelte` and again in `apps/viewer/src/routes/+page.svelte`
// — so a change to the card could land in one app and not the other. It is one component now, so it
// is one test, and it lives beside the component rather than in either consumer.
//
// ⚠ **What stays in `e2e/`.** That the editor's Hub lists what is really in the Workspace, that
// publishing writes a site whose Front Page lists what the author chose, and that a Project's name is
// still text after a real build has been served over HTTP: `editor-workspace.e2e.ts`,
// `editor-publish.e2e.ts` and `viewer-reader.e2e.ts` keep all of it. The two empty states are each
// app's own prose rather than this component's, and are asserted where they are written.
//
// ⚠ **`apps/editor/src/lib/components/project-hub.dom.test.ts` did not move here**, and is not this
// file under another name. Everything in it is about the Hub's Map Images section and the
// wording of the Front Page choice — the editor's own surfaces, mounted through an `EditorSession`
// that nothing in this package may import.
//
// Everything is addressed by position and read straight off the document, per `layer-list.dom.test.ts`.

import { createRawSnippet, flushSync, mount, type Snippet, unmount } from 'svelte';
import { afterEach, describe, expect, test } from 'vitest';

import ProjectCardList from './ProjectCardList.svelte';

/** One entry, as either app composes it: a name, its folder, and where the name links. */
const entry = (directory: string, name = directory) => ({
	directory,
	name,
	href: `./?p=${encodeURIComponent(directory)}`
});

let mounted: Record<string, unknown> | undefined;

/**
 * Take down whatever is mounted and empty the document.
 *
 * Called from {@link afterEach}, and called again *inside* the paired test below: it mounts the same
 * two Projects twice, once with the Hub's snippets and once with the Front Page's, and the absent
 * half has to be asserted against a document the present half has been taken out of.
 */
const takeDown = (): void => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
};

afterEach(takeDown);

/** One row as either app hands it over: a name, its folder, and a link only where there is one. */
type Row = { directory: string; name: string; href?: string };

/**
 * The component offering **exactly** what it is handed here, and nothing else.
 *
 * No defaults are filled in for a snippet that was not passed: a helper that supplied one would make
 * every absence asserted below assert nothing at all.
 */
const list = (props: {
	projects: readonly Row[];
	heading?: 'h2' | 'h3';
	media?: Snippet<[Row]>;
	facts?: Snippet<[Row]>;
	details?: Snippet<[Row]>;
	actions?: Snippet<[Row]>;
	class?: string;
	testid?: string;
	itemTestid?: string;
}): void => {
	mounted = mount(ProjectCardList, { target: document.body, props });
	flushSync();
};

/** A snippet that renders one marker, built from TypeScript rather than from a harness template. */
const marker = <Args extends unknown[]>(testId: string): Snippet<Args> =>
	createRawSnippet<Args>(() => ({ render: () => `<span data-testid="${testId}"></span>` }));

const text = (element: Element | null): string =>
	(element?.textContent ?? '').replace(/\s+/g, ' ').trim();

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('li')];

/**
 * The card at `at`, which must exist.
 *
 * ⚠ **Position, never a handle held across a mount.** The `{#each}` is keyed by folder, so a list
 * rendered again moves the nodes and an element held in a `const` would go on answering questions
 * from a document that has been taken down.
 */
const card = (at: number): HTMLElement => {
	const found = cards()[at];
	if (!found) throw new Error(`no Project card at position ${at}`);
	return found;
};

const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe('the card both apps render', () => {
	test('names each Project, links the name to its folder, and says which folder that is', () => {
		list({
			projects: [entry('amsterdam-1625', 'Amsterdam 1625'), entry('boston-1775', 'Boston 1775')]
		});

		expect(cards()).toHaveLength(2);
		// Addressed by query parameter, never by a per-Project path (ADR-0008) — and the href is the
		// consumer's, composed from the folder rather than from the display name.
		expect(card(0).querySelector('a')).toHaveAttribute('href', './?p=amsterdam-1625');
		expect(text(card(0).querySelector('a'))).toBe('Amsterdam 1625');
		// The folder is the Project's identity, and what a link somebody has already shared is built
		// from, so it is on the card in both apps.
		expect(text(card(0))).toContain('folder amsterdam-1625');
		expect(text(card(1).querySelector('a'))).toBe('Boston 1775');
	});

	/**
	 * ⚠ **A display name is interpolated as text, and never as markup** (ADR-0009).
	 *
	 * It comes out of a `project.json` — which may have arrived from a stranger by bundle or from a
	 * remote library — and a Published Site runs on the author's own domain, so a name rendered as
	 * HTML there is stored XSS on `student.github.io`. Svelte's interpolation is the whole mechanism:
	 * DOMPurify is not involved and must not be reached for here.
	 *
	 * **The real prose is asserted first**, because a card that rendered nothing at all would pass
	 * every "nothing dangerous survived" check on its own.
	 */
	test('renders a name carrying markup as text, creating no element', () => {
		const payload = 'Amsterdam <img src=x onerror="window.pwned=1"> 1625<script>alert(1)</script>';
		list({ projects: [entry('amsterdam-1625', payload)] });

		expect(text(card(0).querySelector('a'))).toBe(payload);
		expect(document.querySelectorAll('li img')).toHaveLength(0);
		expect(document.querySelectorAll('li script')).toHaveLength(0);
		const handlers = [...document.querySelectorAll('li *')].flatMap((element) =>
			[...element.attributes]
				.map((attribute) => attribute.name)
				.filter((name) => name.toLowerCase().startsWith('on'))
		);
		expect(handlers).toEqual([]);
	});

	// The two apps sit the list under different headings — "Projects" in the Hub, and the bar's own
	// `<h1>` on the Front Page — so the level is the consumer's to state rather than this component's
	// to assume. Nothing else about the card changes with it.
	test('takes the heading level from the page it is on', () => {
		list({ projects: [entry('amsterdam-1625', 'Amsterdam 1625')], heading: 'h3' });
		expect(text(document.querySelector('li h3'))).toBe('Amsterdam 1625');

		takeDown();
		list({ projects: [entry('amsterdam-1625', 'Amsterdam 1625')] });
		expect(text(document.querySelector('li h2'))).toBe('Amsterdam 1625');
	});
});

describe('the leading media slot, and the row with nowhere to go', () => {
	// The editor's Map Image list is this component with a thumbnail handed to it, which is what
	// retired the second copy of this markup. Both halves in one test for the reason the paired test
	// below gives: an absence asserted alone would go on passing with the slot deleted.
	test('renders the media it is handed at the head of every row, and nothing when it is handed none', () => {
		list({
			projects: [entry('shared', 'Blaeu’s plan of Amsterdam'), entry('solo', 'Bonner’s Boston')],
			media: marker('map-thumbnail')
		});

		// One per row, so the slot is rendered inside the list rather than once beside it.
		expect(document.querySelectorAll('[data-testid="map-thumbnail"]')).toHaveLength(2);
		// **Ahead of the name**, which is the whole of what "leading" means here: a scholar tells
		// eleven scans of one city apart by the picture before they read anything.
		const inRow = [...card(0).querySelectorAll('[data-testid="map-thumbnail"], h2')];
		expect(inRow[0]).toHaveAttribute('data-testid', 'map-thumbnail');
		expect(inRow[1]?.tagName).toBe('H2');

		takeDown();
		list({ projects: [entry('shared', 'Blaeu’s plan of Amsterdam')] });

		expect(one('map-thumbnail')).not.toBeInTheDocument();
		// And the row is still a row, so the absence above is not an empty list passing for one.
		expect(cards()).toHaveLength(1);
	});

	// ⚠ **A Map Image is not a destination.** `/align` refuses to open without a Project, so a linked
	// Map Image name would promise a screen that does not exist — and the row says so by being handed
	// no `href`, which is the same interface the actions use. A Project's row still links, immediately
	// below, so this is a subtraction rather than the component having stopped linking anything.
	test('names a row with no href as text, creating no link', () => {
		list({ projects: [{ directory: 'shared', name: 'Blaeu’s plan of Amsterdam' }] });

		expect(text(card(0).querySelector('h2'))).toBe('Blaeu’s plan of Amsterdam');
		expect(card(0).querySelector('a')).toBeNull();
		expect(text(card(0))).toContain('folder shared');

		takeDown();
		list({ projects: [entry('amsterdam-1625', 'Amsterdam 1625')] });

		expect(card(0).querySelector('a')).toHaveAttribute('href', './?p=amsterdam-1625');
	});

	// The row, and not something inside it, is what a consumer's tests count and filter by text.
	test('marks each row with the handle its consumer addresses rows by', () => {
		list({ projects: [entry('shared'), entry('solo')], itemTestid: 'map-image' });

		expect(document.querySelectorAll('[data-testid="map-image"]')).toHaveLength(2);
		expect(document.querySelector('[data-testid="map-image"]')).toBe(card(0));

		takeDown();
		list({ projects: [entry('shared')] });

		expect(one('map-image')).not.toBeInTheDocument();
	});
});

describe('a control the consumer does not ask for is not there', () => {
	// ⚠ **Both halves of the claim, in one test, on purpose.** An absence asserted on its own is the
	// vacuous green this repository's testing decisions exist to prevent: rename one `data-testid` and
	// every `not.toBeInTheDocument()` below goes on passing while the control it names sits on the
	// screen. So the same two Projects are mounted twice — once with the Hub's snippets and once with
	// the Front Page's — and the present half is what gives the absent half its meaning.
	//
	// **There is no `readOnly` prop to test, and that is the subject rather than an omission.** A
	// consumer's interface *is* what it passes: the Hub hands over its last-saved line, its Front Page
	// choice and its per-Project controls, and the Front Page hands over none of them.

	const both = () => [
		entry('amsterdam-1625', 'Amsterdam 1625'),
		entry('boston-1775', 'Boston 1775')
	];

	test('renders the Hub’s facts, description and controls, and none of them for the Front Page', () => {
		list({
			projects: both(),
			heading: 'h3',
			facts: marker('hub-last-saved'),
			details: marker('hub-front-page-choice'),
			actions: marker('hub-project-controls')
		});

		// One of each per card, so the snippets are rendered inside the list rather than once beside it.
		expect(document.querySelectorAll('[data-testid="hub-last-saved"]')).toHaveLength(2);
		expect(document.querySelectorAll('[data-testid="hub-front-page-choice"]')).toHaveLength(2);
		expect(document.querySelectorAll('[data-testid="hub-project-controls"]')).toHaveLength(2);

		takeDown();
		list({ projects: both(), testid: 'published-projects' });

		expect(one('hub-last-saved')).not.toBeInTheDocument();
		expect(one('hub-front-page-choice')).not.toBeInTheDocument();
		expect(one('hub-project-controls')).not.toBeInTheDocument();
		// And the card a Reader is left with is still a card: the name, the link and the folder are
		// what the Front Page keeps, so the absences above are not an empty list passing for a subtraction.
		expect(one('published-projects')).toBeInTheDocument();
		expect(cards()).toHaveLength(2);
		expect(text(card(0).querySelector('a'))).toBe('Amsterdam 1625');
		expect(text(card(0))).toContain('folder amsterdam-1625');

		// ⚠ **The card itself, and not only the snippets it was handed.** The three absences above name
		// testids that exist nowhere but this file, so a control or a line of editor-flavoured prose
		// written into *this component* — outside every snippet — would satisfy all three while sitting
		// on the screen of every Published Site. That is the shape that got past a `role=button` sweep
		// twice while the two lists were separate, and this component is the surface it would land on
		// now. So the Front Page's card is swept for anything a Reader could operate, and read for
		// anything it says: the name link is the one control, and the name and the folder are the
		// whole of the words.
		const controls = [
			...card(0).querySelectorAll('button, input, select, textarea, a[href], [role="button"]')
		];
		expect(controls).toHaveLength(1);
		expect(controls[0]).toBe(card(0).querySelector('a'));
		expect(text(card(0))).toBe('Amsterdam 1625 folder amsterdam-1625');
	});

	// The facts line is the card's own — the folder is on it in both apps — and what a consumer adds
	// goes in front of it. A Front Page card must not be left with the separator of a fact nobody gave.
	test('keeps the facts line to the folder alone when no facts are handed to it', () => {
		list({ projects: [entry('amsterdam-1625', 'Amsterdam 1625')] });

		expect(text(card(0))).toContain('folder amsterdam-1625');
		expect(text(card(0))).not.toContain('·');
	});
});

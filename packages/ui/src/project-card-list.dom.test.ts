import { createRawSnippet, type Snippet } from 'svelte';
import { afterEach, describe, expect, test } from 'vitest';

import { all, one, show, takeDown, textOf as text } from '../vitest-setup/dom.js';
import ProjectCardList from './ProjectCardList.svelte';

const entry = (directory: string, name = directory) => ({
	directory,
	name,
	href: `./?p=${encodeURIComponent(directory)}`
});

afterEach(takeDown);

type Row = { directory: string; name: string; href?: string };

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
}): void => show(ProjectCardList, props);

const marker = <Args extends unknown[]>(testId: string): Snippet<Args> =>
	createRawSnippet<Args>(() => ({ render: () => `<span data-testid="${testId}"></span>` }));

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('li')];

const card = (at: number): HTMLElement => {
	const found = cards()[at];
	if (!found) throw new Error(`no Project card at position ${at}`);
	return found;
};

describe('the card both apps render', () => {
	test('names each Project, links the name to its folder, and says which folder that is', () => {
		list({
			projects: [entry('amsterdam-1625', 'Amsterdam 1625'), entry('boston-1775', 'Boston 1775')]
		});

		expect(cards()).toHaveLength(2);
		expect(card(0).querySelector('a')).toHaveAttribute('href', './?p=amsterdam-1625');
		expect(text(card(0).querySelector('a'))).toBe('Amsterdam 1625');
		expect(text(card(0))).toContain('folder amsterdam-1625');
		expect(text(card(1).querySelector('a'))).toBe('Boston 1775');
	});

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

	test('takes the heading level from the page it is on', () => {
		list({ projects: [entry('amsterdam-1625', 'Amsterdam 1625')], heading: 'h3' });
		expect(text(document.querySelector('li h3'))).toBe('Amsterdam 1625');
		takeDown();
		list({ projects: [entry('amsterdam-1625', 'Amsterdam 1625')] });
		expect(text(document.querySelector('li h2'))).toBe('Amsterdam 1625');
	});
});

describe('the leading media slot, and the row with nowhere to go', () => {
	test('renders the media it is handed at the head of every row, and nothing when it is handed none', () => {
		list({
			projects: [entry('shared', 'Blaeu’s plan of Amsterdam'), entry('solo', 'Bonner’s Boston')],
			media: marker('map-thumbnail')
		});

		expect(all('map-thumbnail')).toHaveLength(2);
		const inRow = [...card(0).querySelectorAll('[data-testid="map-thumbnail"], h2')];
		expect(inRow[0]).toHaveAttribute('data-testid', 'map-thumbnail');
		expect(inRow[1]?.tagName).toBe('H2');
		takeDown();
		list({ projects: [entry('shared', 'Blaeu’s plan of Amsterdam')] });
		expect(one('map-thumbnail')).not.toBeInTheDocument();
		expect(cards()).toHaveLength(1);
	});

	test('names a row with no href as text, creating no link', () => {
		list({ projects: [{ directory: 'shared', name: 'Blaeu’s plan of Amsterdam' }] });
		expect(text(card(0).querySelector('h2'))).toBe('Blaeu’s plan of Amsterdam');
		expect(card(0).querySelector('a')).toBeNull();
		expect(text(card(0))).toContain('folder shared');
	});

	test('marks each row with the handle its consumer addresses rows by', () => {
		list({ projects: [entry('shared'), entry('solo')], itemTestid: 'map-image' });
		expect(all('map-image')).toHaveLength(2);
		expect(one('map-image')).toBe(card(0));
		takeDown();
		list({ projects: [entry('shared')] });
		expect(one('map-image')).not.toBeInTheDocument();
	});
});

describe('a control the consumer does not ask for is not there', () => {
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

		expect(all('hub-last-saved')).toHaveLength(2);
		expect(all('hub-front-page-choice')).toHaveLength(2);
		expect(all('hub-project-controls')).toHaveLength(2);
		takeDown();
		list({ projects: both(), testid: 'front-page-projects' });
		expect(one('hub-last-saved')).not.toBeInTheDocument();
		expect(one('hub-front-page-choice')).not.toBeInTheDocument();
		expect(one('hub-project-controls')).not.toBeInTheDocument();
		expect(one('front-page-projects')).toBeInTheDocument();
		expect(cards()).toHaveLength(2);
		expect(text(card(0).querySelector('a'))).toBe('Amsterdam 1625');
		expect(text(card(0))).toContain('folder amsterdam-1625');

		const controls = [
			...card(0).querySelectorAll('button, input, select, textarea, a[href], [role="button"]')
		];
		expect(controls).toHaveLength(1);
		expect(controls[0]).toBe(card(0).querySelector('a'));
		expect(text(card(0))).toBe('Amsterdam 1625 folder amsterdam-1625');
	});
});

import type { ProjectSummary, WorkspaceMapImage } from '@ballastella/core';
import { flushSync, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test } from 'vitest';

import { all, at, one, settle, show, takeDown, textOf as text } from '$lib/test-support/dom';

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
	onFrontPage: false,
	problem: null,
	...over
});

afterEach(takeDown);

const hub = (props: ComponentProps<typeof ProjectHubHarness>): void =>
	show(ProjectHubHarness, props);

const cards = (): HTMLElement[] => all('map-image');

const openProvenance = (): HTMLElement => {
	[...cards()[0].querySelectorAll('button')]
		.find((button) => text(button) === 'Provenance')
		?.click();
	flushSync();
	return at('map-image-provenance');
};

const AMSTERDAM = { directory: 'amsterdam-1625', name: 'Amsterdam 1625' };

describe('what a Map Image card says about the map', () => {
	test('names it, weighs it, says how many files, and whether the tiles are here or on a named Library', () => {
		hub({
			mapImages: [
				map('shared', { label: 'Blaeu’s plan of Amsterdam' }),
				map('remote-one', {
					label: 'Plan de Paris',
					bytes: 400,
					files: 1,
					tiles: 'referenced',
					library: 'iiif.bnf.example'
				})
			]
		});

		expect(text(cards()[0])).toContain('Blaeu’s plan of Amsterdam');
		expect(text(cards()[0])).toContain('Tiles in this Workspace');
		expect(text(cards()[1])).toContain('Tiles on iiif.bnf.example');
		expect(text(cards()[0])).toContain('50 kB in 4 files');
		expect(text(cards()[1])).toContain('in 1 file');
		expect(text(cards()[1])).not.toContain('1 files');
		expect(text(cards()[0])).not.toContain('folder shared');
	});

	test('falls back to the folder name, and to an unnamed Library, when the records say nothing', () => {
		hub({ mapImages: [map('untitled-scan'), map('remote-one', { tiles: 'referenced' })] });
		expect(text(cards()[1])).toContain('Tiles on a Library’s server');
		expect(text(document.querySelector('[data-testid="map-image"] h3'))).toBe('untitled-scan');
		expect(document.querySelector('[data-testid="map-image"] button')).toHaveAccessibleName(
			'Delete untitled-scan'
		);
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
		expect(one('map-image-provenance')).toBeNull();

		const provenance = text(openProvenance());
		expect(button).toHaveAccessibleName('Hide provenance');
		expect(provenance).toContain('Source');
		expect(provenance).toContain('https://library.example/iiif/collection');
		expect(provenance).toContain('Canvas Plan 2');
	});

	test('does not turn an invalid provenance value into a link', () => {
		hub({
			mapImages: [
				map('remote-one', { provenance: { source: 'javascript:alert(1)', canvasLabel: '' } })
			]
		});

		const provenance = openProvenance();
		expect(text(provenance)).toContain('javascript:alert(1)');
		expect([...provenance.querySelectorAll('a')]).toEqual([]);
	});
});

describe('which Projects draw a map, in the words the list uses', () => {
	test('lists them by name, and says plainly when none do', () => {
		hub({
			mapImages: [
				map('shared', {
					label: 'Blaeu’s plan of Amsterdam',
					usedBy: [AMSTERDAM, { directory: 'boston-1775', name: 'Boston 1775' }]
				}),
				map('solo', { label: 'Bonner’s Boston', usedBy: [AMSTERDAM] }),
				map('orphan', { label: 'A map nobody kept' })
			]
		});

		const usedBy = all('used-by').map(text);
		expect(usedBy).toEqual([
			'Projects that use this image: Amsterdam 1625, Boston 1775.',
			'Projects that use this image: Amsterdam 1625.',
			'Projects that use this image: None.'
		]);
	});

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
		expect(sentence).not.toContain('Projects that use this image: None.');
		expect(sentence).toBe(
			'Projects that use this image: none that this version can confirm. It may also be drawn by ' +
				'from-the-future, made with a newer version of Ballastella.'
		);
	});

	test('keeps unreadable Projects separate from the ones it vouches for, as “They” or “It”', () => {
		const tomorrow = { directory: 'from-the-future', name: 'Tomorrow' };
		hub({
			mapImages: [
				map('shared', {
					usedBy: [AMSTERDAM],
					mightBeUsedBy: [tomorrow, { directory: 'later-still', name: 'Later Still' }]
				}),
				map('solo', { usedBy: [AMSTERDAM], mightBeUsedBy: [tomorrow] })
			]
		});

		const [several, single] = all('used-by').map(text);
		expect(several).toBe(
			'Projects that use this image: Amsterdam 1625. They may also be drawn by Tomorrow, Later ' +
				'Still, made with a newer version of Ballastella.'
		);
		expect(single).toContain('It may also be drawn by Tomorrow');
	});
});

test('a Workspace with no Map Images says so', () => {
	hub({ mapImages: [] });
	expect(cards()).toHaveLength(0);
	expect(text(at('no-map-images'))).toBe('No Map Images yet.');
	expect(text(at('map-images-total'))).toBe('0 (0 local, 0 IIIF external)');
	expect(text(at('map-images-size'))).toBe('0 bytes');
});

describe('each list under a heading carrying its own count', () => {
	test('states each count and weight beside its heading, leaving the headings named what they were', () => {
		hub({
			projects: [project('amsterdam-1625'), project('boston-1775'), project('la-floride')],
			mapImages: [
				map('shared', { usedBy: [AMSTERDAM] }),
				map('solo', { tiles: 'referenced', library: 'Harvard Library' }),
				map('orphan')
			]
		});

		expect([...document.querySelectorAll('section h2')].map(text)).toEqual([
			'Projects',
			'Map Images'
		]);
		expect(text(at('projects-count'))).toBe('3 Projects');
		expect(text(at('map-images-total'))).toBe('3 (2 local, 1 IIIF external)');
		expect(text(at('map-images-size'))).toBe('150 kB');
	});

	test('says one Project and one Map Image in the singular', () => {
		hub({ projects: [project('amsterdam-1625')], mapImages: [map('shared')] });
		expect(text(at('projects-count'))).toBe('1 Project');
		expect(text(at('map-images-total'))).toBe('1 (1 local, 0 IIIF external)');
	});

	test('states no Map Image count while the Workspace is still being weighed', () => {
		hub({ mapImages: [], mapImagesLoading: true });
		expect(one('map-images-stats')).toBeNull();
	});
});

describe('a row’s actions, and the one that is destructive', () => {
	const projectRow = (): HTMLElement => {
		const found = [...document.querySelectorAll<HTMLElement>('li')].find((row) =>
			[...row.querySelectorAll('button')].some((button) => text(button).startsWith('Edit'))
		);
		if (!found) throw new Error('no Project row is rendered');
		return found;
	};

	test('offers a Project row Open, Edit and Duplicate, and nothing in error', () => {
		hub({ projects: [project('amsterdam-1625', { name: 'Amsterdam 1625' })] });
		const row = projectRow();
		const buttons = [...row.querySelectorAll('button')];
		expect(buttons).toHaveLength(3);
		expect(buttons[0]).toHaveAccessibleName('Open Amsterdam 1625');
		expect(buttons[1]).toHaveAccessibleName('Edit Amsterdam 1625');
		expect(buttons[2]).toHaveAccessibleName('Duplicate Amsterdam 1625');
		expect(row.querySelectorAll('.btn-error')).toHaveLength(0);
	});

	test('renders a description with the breaks its author typed, and nothing where there is none', () => {
		hub({
			projects: [
				project('amsterdam-1625', { description: 'Blaeu, 1649.\n\nSheets 1–4 only.' }),
				project('boston-1775')
			]
		});

		const described = all('project-description');
		expect(described).toHaveLength(1);
		expect(described[0].textContent).toContain('Blaeu, 1649.\n\nSheets 1–4 only.');
		expect(described[0].className).toContain('whitespace-pre-line');
	});

	test('leaves a Map Image row with Delete alone', () => {
		hub({ mapImages: [map('shared', { label: 'Blaeu’s plan of Amsterdam' })] });
		const buttons = [...cards()[0].querySelectorAll('button')];
		expect(buttons).toHaveLength(1);
		expect(buttons[0]).toHaveAccessibleName('Delete Blaeu’s plan of Amsterdam');
		expect(buttons[0].className).toContain('btn-error');
	});

	describe('the warning about a link that would stop working', () => {
		const askToDelete = async (name: string): Promise<void> => {
			[...projectRow().querySelectorAll('button')]
				.find((button) => text(button).startsWith('Edit'))
				?.click();
			flushSync();
			[...document.querySelectorAll('button')]
				.find((button) => text(button) === 'Delete Project…')
				?.click();
			flushSync();
			await settle();
			expect(text(document.body)).toContain(name);
		};

		const amsterdam = [project('amsterdam-1625', { name: 'Amsterdam 1625' })];

		test.each([
			{
				when: 'the Workspace shares links and the Project is on GitHub',
				props: { shareLinks: true, synced: ['amsterdam-1625'] },
				warns: true
			},
			{
				when: 'the Remote has never held the Project',
				props: { shareLinks: true, synced: [] },
				warns: false
			},
			{
				when: 'only the Remote was seen to carry the site',
				props: { shareLinks: false, remoteShareLinks: true, synced: ['amsterdam-1625'] },
				warns: true
			},
			{
				when: 'the author has asked for the site to come down',
				props: { remoteShareLinks: true, withdrawing: true, synced: ['amsterdam-1625'] },
				warns: false
			},
			{
				when: 'the Workspace has no Share Links at all',
				props: { shareLinks: false, synced: ['amsterdam-1625'] },
				warns: false
			}
		])('warns: $warns, asking GitHub nothing, where $when', async ({ props, warns }) => {
			const asked: string[] = [];
			hub({ projects: amsterdam, requests: (member) => asked.push(member), ...props });

			await askToDelete('Amsterdam 1625');

			if (warns) expect(text(at('delete-breaks-share-link'))).toContain('stops working');
			else expect(one('delete-breaks-share-link')).toBeNull();
			expect(asked).toEqual([]);
		});
	});

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

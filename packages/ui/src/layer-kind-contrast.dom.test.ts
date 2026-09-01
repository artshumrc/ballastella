import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { Layer } from '@ballastella/core';

import LayerList from './LayerList.svelte';

const here = path.dirname(fileURLToPath(import.meta.url));

const layer = (kind: 'map' | 'annotation', order: number): Layer =>
	kind === 'map'
		? { kind, id: `l${order}`, name: 'A map', visible: true, order, opacity: 1, imageId: 'i1' }
		: { kind, id: `l${order}`, name: 'Some notes', visible: true, order, geojsonRef: 'a.geojson' };

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

test('Layer cards use each kind’s theme fill and content tokens', () => {
	mounted = mount(LayerList, {
		target: document.body,
		props: {
			layers: [layer('map', 0), layer('annotation', 1)],
			outcomes: {},
			openLayerId: null,
			onopen: vi.fn(),
			ontypename: vi.fn(),
			oncommit: vi.fn(),
			onshow: vi.fn(),
			ondragopacity: vi.fn(),
			onmove: vi.fn(),
			ondelete: vi.fn()
		}
	});
	flushSync();

	const headers = document.querySelectorAll<HTMLElement>('[data-testid="layer-header"]');
	expect(headers[0]).toHaveClass('bg-accent');
	expect(headers[1]).toHaveClass('bg-info');
	const kinds = document.querySelectorAll<HTMLElement>('[data-testid="layer-kind"]');
	expect(kinds[0]).toHaveClass('text-accent-content');
	expect(kinds[1]).toHaveClass('text-info-content');
});

test('the rename pencil follows its header’s ink rather than base-content', () => {
	mounted = mount(LayerList, {
		target: document.body,
		props: {
			layers: [layer('map', 0)],
			outcomes: {},
			openLayerId: 'l0',
			onopen: vi.fn(),
			ontypename: vi.fn(),
			oncommit: vi.fn(),
			onshow: vi.fn(),
			ondragopacity: vi.fn(),
			onmove: vi.fn(),
			ondelete: vi.fn()
		}
	});
	flushSync();

	const pencil = document.querySelector<HTMLElement>('[data-testid="layer-rename"]');
	for (const cls of [
		'bg-transparent',
		'btn-ghost',
		'text-current',
		'hover:bg-current/20',
		'focus-visible:outline-current'
	]) {
		expect(pencil, cls).toHaveClass(cls);
	}
});

test('both apps define Layer fill and content tokens in every custom theme', () => {
	for (const app of ['editor', 'viewer']) {
		const css = readFileSync(path.join(here, `../../../apps/${app}/src/routes/layout.css`), 'utf8');
		const themes = [...css.matchAll(/@plugin\s+'daisyui\/theme'\s*\{([^}]*)\}/g)];
		expect(themes, `apps/${app}`).toHaveLength(2);
		for (const [, body] of themes) {
			for (const token of [
				'--color-accent',
				'--color-accent-content',
				'--color-info',
				'--color-info-content'
			]) {
				expect(body, `apps/${app}: ${token}`).toMatch(
					new RegExp(`${token}:\\s*#[0-9a-f]{6};`, 'i')
				);
			}
		}
	}
});

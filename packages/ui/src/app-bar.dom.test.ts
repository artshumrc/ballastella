import { flushSync, type ComponentProps } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { all, one as testid, show, takeDown } from '../vitest-setup/dom.js';
import AppBarHarness from './AppBarHarness.svelte';
import { pageChrome } from './page-chrome.svelte.js';

const WIDE = window.innerWidth;

const viewport = (width: number) =>
	(
		window as unknown as { happyDOM: { setViewport(size: { width: number }): void } }
	).happyDOM.setViewport({ width });

const render = (props: ComponentProps<typeof AppBarHarness> = {}) => {
	show(AppBarHarness, props);
	return document.querySelector('header')!;
};

afterEach(() => {
	takeDown();
	pageChrome.show('');
	viewport(WIDE);
});

test('is one banner landmark, under the test id both suites address the bar by, holding each app’s own items', () => {
	const bar = render();
	expect(bar).toHaveAttribute('data-testid', 'navigation-bar');
	expect(document.querySelectorAll('header')).toHaveLength(1);
	expect(testid('site-name')).toHaveTextContent('Ballastella');
	expect(testid('app-control')).toHaveTextContent('Sync');
});

test('carries the one theme picker both apps share', () => {
	const onSelectTheme = vi.fn();
	render({ theme: 'carto-light', onSelectTheme });
	const toggle = testid('theme-toggle')!;
	expect(toggle).toHaveAccessibleName('Theme');
	expect(toggle).toHaveAttribute('aria-controls');
	expect(testid('theme-toggle-menu')).toHaveAttribute('data-theme', 'carto-light');
	expect(testid('theme-option-carto-light')).toHaveAttribute('aria-current', 'true');
	expect(testid('theme-option-synthwave')).not.toHaveAttribute('aria-current');

	(testid('theme-option-synthwave') as HTMLButtonElement).click();
	flushSync();
	expect(onSelectTheme).toHaveBeenCalledWith('synthwave');
});

test('says which screen this is, and nothing at all when the screen says nothing', () => {
	render();
	expect(testid('page-chrome')).toBeNull();

	pageChrome.show('Amsterdam 1625');
	flushSync();
	expect(testid('page-heading')).toHaveTextContent('Amsterdam 1625');
	// The first heading a screen reader reaches, because the bar is before the page's own content.
	expect(testid('page-heading')!.tagName).toBe('H1');
});

test('builds the way off a screen against the app’s own root, under the route’s own test id', () => {
	render();

	pageChrome.show('Align', {
		label: 'Back to this Project',
		project: 'amsterdam 1625',
		testid: 'back-to-project'
	});
	flushSync();
	const back = testid('back-to-project')!;
	expect(back).toHaveTextContent('Back to this Project');
	// The directory is encoded, and the root comes from the app: `packages/ui` cannot resolve a base path of its own (ADR-0034), so the consumer hands it one.
	expect(back).toHaveAttribute('href', './?p=amsterdam%201625');
});

test('renders a linked hierarchy ending in the current page heading', () => {
	render();

	pageChrome.showBreadcrumbs('editor-align', [
		{ label: 'Projects', destination: {}, testid: 'all-projects' },
		{
			label: 'Amsterdam 1625',
			destination: { project: 'amsterdam 1625' },
			testid: 'back-to-project'
		},
		{ label: 'Align: Harbor chart' }
	]);
	flushSync();
	expect(testid('page-chrome')).toHaveAccessibleName('Breadcrumb');
	expect(testid('all-projects')).toHaveAttribute('href', './');
	expect(testid('back-to-project')).toHaveAttribute('href', './?p=amsterdam%201625');
	expect(testid('back-to-project')).toHaveTextContent('Amsterdam 1625');
	expect(testid('page-heading')).toHaveTextContent('Align: Harbor chart');
	expect(testid('page-heading')).toHaveAttribute('aria-current', 'page');
});

test('renders a current-page action beside its breadcrumb label', () => {
	const edit = vi.fn();
	render();

	pageChrome.showBreadcrumbs('editor-project', [
		{ label: 'Projects', destination: {} },
		{
			label: 'Amsterdam 1625',
			action: { label: 'Edit Project name', testid: 'edit-project-name', onClick: edit }
		}
	]);
	flushSync();
	const button = testid('edit-project-name')!;
	expect(button).toHaveAccessibleName('Edit Project name');
	expect(testid('page-heading')).toHaveClass('hover:underline');
	expect(button.parentElement).toHaveClass('breadcrumb-current');
	button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	expect(edit).toHaveBeenCalledTimes(1);
});

test('keeps the arriving screen’s heading when the screen being left gives the slot back', () => {
	render();

	pageChrome.show('Align', { label: 'Back to this Project', project: 'amsterdam-1625' });
	flushSync();
	expect(testid('page-heading')).toHaveTextContent('Align');

	pageChrome.show('Amsterdam 1625');
	pageChrome.clear('Align');
	flushSync();
	expect(testid('page-heading')).toHaveTextContent('Amsterdam 1625');
});

test('folds the app’s items and the theme control into one menu at a phone’s width', () => {
	render({ withMenu: true });
	viewport(375);
	flushSync();
	expect(testid('site-name')).toBeInTheDocument();
	pageChrome.show('Amsterdam 1625');
	flushSync();
	expect(testid('page-heading')).toHaveTextContent('Amsterdam 1625');
	const menu = testid('bar-menu-menu')!;
	expect(testid('bar-menu')).toHaveAccessibleName('Menu');
	expect(menu).toContainElement(testid('theme-toggle'));
	expect(menu).toContainElement(testid('app-control'));
	expect(all('theme-toggle')).toHaveLength(1);
});

test('splits into an eyebrow and a main row for an app that hands it a status', () => {
	render({ withStatus: true });
	pageChrome.show('Amsterdam 1625');
	flushSync();
	const eyebrow = testid('bar-eyebrow')!;
	const main = testid('bar-main')!;
	expect(eyebrow).toContainElement(testid('site-name'));
	expect(eyebrow).toContainElement(testid('app-status'));
	expect(main).toContainElement(testid('page-chrome'));
	expect(main).toContainElement(testid('app-control'));
	expect(main).toContainElement(testid('theme-toggle'));
	expect(document.querySelectorAll('header')).toHaveLength(1);
	const bar = document.querySelector('[data-testid="navigation-bar"]')!;
	expect(bar).toContainElement(testid('bar-eyebrow'));
	expect(bar).toContainElement(testid('bar-main'));
	for (const id of ['theme-toggle', 'app-status', 'app-control', 'page-chrome', 'site-name']) {
		expect(all(id), id).toHaveLength(1);
	}
});

test('stays one row for an app that hands it no status', () => {
	render();
	pageChrome.show('Amsterdam 1625');
	flushSync();
	expect(testid('bar-eyebrow')).toBeNull();
	expect(testid('bar-main')).toBeNull();
	expect(testid('bar-single')).toBeInTheDocument();
	expect(testid('site-name')).toBeInTheDocument();
	expect(testid('page-chrome')).toBeInTheDocument();
	expect(testid('theme-toggle')).toBeInTheDocument();
	expect(testid('app-control')).toBeInTheDocument();
});

test('can place the theme control after an app’s controls in a single-row bar', () => {
	render({ themeLast: true });
	const control = testid('app-control')!;
	const theme = testid('theme-toggle')!;
	expect(control.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
});

test('does not fold for an app that offers it nothing to fold into', () => {
	render();
	viewport(375);
	flushSync();
	expect(testid('bar-menu')).toBeNull();
	expect(testid('app-control')).toBeInTheDocument();
	expect(testid('theme-toggle')).toBeInTheDocument();
});

test('names the app in the taller main row of a tiered bar, in no heading and no button', () => {
	const header = render({ withStatus: true, withWordmark: true });
	const wordmark = testid('app-wordmark');
	expect(wordmark).not.toBeNull();
	expect(testid('bar-main')?.contains(wordmark!)).toBe(true);
	expect(testid('bar-eyebrow')?.contains(wordmark!)).toBe(false);
	expect(wordmark).toHaveClass('font-serif');
	expect(header.querySelectorAll('h1')).toHaveLength(0);
	expect(wordmark!.closest('button')).toBeNull();
});

test('names the app in a single-row bar when a wordmark is provided', () => {
	render({ withWordmark: true });
	const wordmark = testid('app-wordmark');
	expect(wordmark).not.toBeNull();
	expect(testid('bar-single')?.contains(wordmark!)).toBe(true);
	expect(testid('bar-eyebrow')).toBeNull();
	expect(testid('bar-main')).toBeNull();
});

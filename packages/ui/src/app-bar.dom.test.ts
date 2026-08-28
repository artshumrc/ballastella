// What the bar shell renders, asserted against the component rather than against either app.
//
// The bar is one shell with two consumers: the editor fills it with the Workspace switcher, the save
// indicator and undo; a published site fills it with the site's name, All Projects and the way back
// to the editor that made it. What is *shared* is what this file is about — the landmark, the
// page-chrome slot, the theme control, and the fold — so it is asserted once here rather than twice
// in `e2e/`.
//
// ⚠ What stays in `e2e/` is unchanged: that the editor's own items still behave, that a published
// site really carries a bar in a real build served over HTTP, and anything about width or paint.
// There is no layout here.
//
// Everything is addressed off the document: `mount` is Svelte's own and a query is
// `document.querySelector`. There is no component-testing library.

import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import AppBarHarness from './AppBarHarness.svelte';
import { pageChrome } from './page-chrome.svelte.js';

/** The width happy-dom starts at, so a test that narrows the window can put it back. */
const WIDE = window.innerWidth;

const viewport = (width: number) =>
	(
		window as unknown as { happyDOM: { setViewport(size: { width: number }): void } }
	).happyDOM.setViewport({ width });

let mounted: Record<string, unknown> | undefined;

const render = (props: ComponentProps<typeof AppBarHarness> = {}) => {
	mounted = mount(AppBarHarness, { target: document.body, props });
	flushSync();
	return document.querySelector('header')!;
};

const testid = (id: string) => document.querySelector(`[data-testid="${id}"]`);

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
	pageChrome.show('');
	viewport(WIDE);
});

test('is one banner landmark, under the test id both suites address the bar by', () => {
	// `<header>` rather than `<nav>`: the editor's bar has screens where nothing in it navigates, and
	// announcing a navigation landmark with no links in it is a promise the bar does not keep.
	const bar = render();

	expect(bar).toHaveAttribute('data-testid', 'navigation-bar');
	expect(document.querySelectorAll('header')).toHaveLength(1);
});

test('carries the one control both apps share, saying what it will do rather than what it is', () => {
	const onToggleTheme = vi.fn();
	render({ theme: 'light', onToggleTheme });

	const toggle = testid('theme-toggle')!;
	expect(toggle).toHaveAccessibleName('Switch to dark theme');
	expect(toggle).toHaveAttribute('aria-label', 'Switch to dark theme');
	expect(toggle.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

	(toggle as HTMLButtonElement).click();
	flushSync();

	// The bar changes nothing itself: which theme is in force, and whether it is remembered, is the
	// app's own signal (ADR-0034 keeps `theme.svelte.ts` two modules).
	expect(onToggleTheme).toHaveBeenCalledTimes(1);
});

test('renders each app’s own items in the slots it is handed', () => {
	render();

	expect(testid('site-name')).toHaveTextContent('Ballastella');
	expect(testid('app-control')).toHaveTextContent('Publish…');
});

test('says which screen this is, and nothing at all when the screen says nothing', () => {
	render();

	// A screen that names itself — the hub — leaves the slot empty rather than putting an empty
	// heading on the bar.
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
	// The directory is encoded, and the root comes from the app: `packages/ui` cannot resolve a base
	// path of its own (ADR-0034), so the consumer hands it one.
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
	button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	expect(edit).toHaveBeenCalledTimes(1);
});

test('keeps the arriving screen’s heading when the screen being left gives the slot back', () => {
	// ⚠ **The mutation this file exists to catch.** Svelte runs the arriving route's effects before the
	// leaving route's teardown, so `clear()` compares before it empties — and without the comparison
	// the bar is emptied *after* the next screen has already filled it, leaving a Reader on a Project
	// looking at a bar that says nothing.
	render();

	pageChrome.show('Align', { label: 'Back to this Project', project: 'amsterdam-1625' });
	flushSync();
	expect(testid('page-heading')).toHaveTextContent('Align');

	// The arriving screen fills the slot first…
	pageChrome.show('Amsterdam 1625');
	// …and only then does the screen being left hand it back.
	pageChrome.clear('Align');
	flushSync();

	expect(testid('page-heading')).toHaveTextContent('Amsterdam 1625');
});

test('folds the app’s items and the theme control into one menu at a phone’s width', () => {
	render({ withMenu: true });

	viewport(375);
	flushSync();

	// What a Reader keeps: where they are, and the way home — the two things they need must never be
	// the two things that were dropped.
	expect(testid('site-name')).toBeInTheDocument();
	pageChrome.show('Amsterdam 1625');
	flushSync();
	expect(testid('page-heading')).toHaveTextContent('Amsterdam 1625');

	// Everything else is in the menu, and reachable: real buttons behind a real popover button, not
	// hidden copies of controls that also exist inline.
	const menu = testid('bar-menu-menu')!;
	expect(testid('bar-menu')).toHaveAccessibleName('Menu');
	expect(menu).toContainElement(testid('theme-toggle') as HTMLElement);
	expect(menu).toContainElement(testid('app-control') as HTMLElement);
	// One theme control in the document, at every width. Two — one folded and one inline — is two
	// controls that have to agree, which is the defect the single bar exists to remove.
	expect(document.querySelectorAll('[data-testid="theme-toggle"]')).toHaveLength(1);
});

test('splits into an eyebrow and a main row for an app that hands it a status', () => {
	// Option B: the upper eyebrow is what does not change with the route — who you are and whether
	// your work is kept — and the taller main row is where you are and what you can do here.
	render({ withStatus: true });
	pageChrome.show('Amsterdam 1625');
	flushSync();

	const eyebrow = testid('bar-eyebrow')!;
	const main = testid('bar-main')!;

	expect(eyebrow).toContainElement(testid('site-name') as HTMLElement);
	expect(eyebrow).toContainElement(testid('app-status') as HTMLElement);

	expect(main).toContainElement(testid('page-chrome') as HTMLElement);
	expect(main).toContainElement(testid('app-control') as HTMLElement);
	expect(main).toContainElement(testid('theme-toggle') as HTMLElement);
});

test('keeps both rows inside the one banner, each affordance rendered once', () => {
	// ⚠ **The mutation that breaks every "exactly one of these in the bar" assertion.** Two rows is a
	// second row inside one `<header>`, not a second `<header>` and not an inline row beside a
	// duplicate hidden one.
	render({ withStatus: true });
	pageChrome.show('Amsterdam 1625');
	flushSync();

	expect(document.querySelectorAll('header')).toHaveLength(1);
	const bar = document.querySelector('[data-testid="navigation-bar"]')!;
	expect(bar).toContainElement(testid('bar-eyebrow') as HTMLElement);
	expect(bar).toContainElement(testid('bar-main') as HTMLElement);
	for (const id of ['theme-toggle', 'app-status', 'app-control', 'page-chrome', 'site-name']) {
		expect(document.querySelectorAll(`[data-testid="${id}"]`), id).toHaveLength(1);
	}
});

test('stays one row for an app that hands it no status', () => {
	// The viewer's bar: one row (now `bar-single` with centered wordmark slot) at every width,
	// and the fold still the only arrangement it has a second form of.
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

test('does not fold for an app that offers it nothing to fold into', () => {
	// The editor's case. Authoring is desktop-only (ADR-0014), and its bar must behave at every width
	// exactly as it did before there was a shell at all.
	render();

	viewport(375);
	flushSync();

	expect(testid('bar-menu')).toBeNull();
	expect(testid('app-control')).toBeInTheDocument();
	expect(testid('theme-toggle')).toBeInTheDocument();
});

// ── The app's own name, in the masthead ────────────────────────────────────────────────────────
//
// ADR-0036 gives the display face three jobs — heading a section, naming the app, titling a dialog —
// and this is the second one. What is worth pinning is not how the wordmark looks but the two rules
// that keep it from breaking something else: it belongs to the masthead, which is the row chartered
// to hold what does not change with the screen, and it is neither a heading nor a control.

test('names the app in the taller main row, and only when the bar is tiered', () => {
	render({ withStatus: true, withWordmark: true });

	const wordmark = testid('app-wordmark');
	expect(wordmark).not.toBeNull();
	// Centered in the main row (the taller row), not in the eyebrow: the app's name is at the bar's
	// visual centre.
	expect(testid('bar-main')?.contains(wordmark!)).toBe(true);
	expect(testid('bar-eyebrow')?.contains(wordmark!)).toBe(false);

	// The display face, because ADR-0036 says naming the app is what it is for. This is the rule, not
	// a size or a weight — those are free to be retuned without touching this test.
	expect(wordmark).toHaveClass('font-serif');
});

test('names the app in a single-row bar when a wordmark is provided', () => {
	// The published site now shows the wordmark centered in its single row.
	render({ withWordmark: true });

	const wordmark = testid('app-wordmark');
	expect(wordmark).not.toBeNull();
	expect(testid('bar-single')?.contains(wordmark!)).toBe(true);
	expect(testid('bar-eyebrow')).toBeNull();
	expect(testid('bar-main')).toBeNull();
});

test('the app\u2019s name is not a heading, and not a button', () => {
	const header = render({ withStatus: true, withWordmark: true });

	const wordmark = testid('app-wordmark') as HTMLElement | null;
	expect(wordmark).not.toBeNull();
	// Every screen carries exactly one `<h1>` and three specs count it, so the bar contributes none.
	expect(header.querySelectorAll('h1')).toHaveLength(0);
	// **A link is allowed and a button is not.** ADR-0036 keeps the display face off control labels,
	// which is the text on a button or input naming an action; the app's name is one of that face's
	// three sanctioned jobs, and the viewer's `site-name` has always been an anchor to the root. What
	// would break the rule is a wordmark that performed something.
	expect(wordmark!.closest('button')).toBeNull();
});

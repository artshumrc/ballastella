import { expect, test } from '@playwright/test';

test('the viewer loads and renders its placeholder', async ({ page }) => {
	await page.goto('./');

	await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Viewer' })).toBeVisible();
});

test('the viewer renders Annotation text through core’s own sanitised renderer', async ({
	page
}) => {
	// ADR-0009 requires the renderer be exported from `core` and reused here rather than reimplemented,
	// because ticket 17 asserts that the payload which is inert in the editor is inert in a Published
	// Site — and that means nothing unless it is the same code path. This asserts the path is live in the
	// viewer's own bundle now: the emphasis and the link below were produced by `marked` and then passed
	// by DOMPurify, in that order, inside this build.
	//
	// The *payload* assertion for the viewer belongs to ticket 17, which is where a Published Site has a
	// stranger's Project to render. What is closed here is that there is one renderer and the viewer uses
	// it.
	const failures: string[] = [];
	page.on('pageerror', (error) => failures.push(error.message));
	page.on('dialog', (dialog) => failures.push(`dialog: ${dialog.message()}`));

	await page.goto('./');

	const text = page.getByTestId('viewer-annotation-text');
	// That something rendered at all, before anything about what it does not contain. A blank surface
	// passes every "nothing dangerous survived" assertion, and blank is exactly what `{@html}` looks
	// like when Svelte has adopted prerendered nodes for it — which is how this very page first behaved.
	await expect(text).toContainText('lean read-only viewer');
	await expect(text.locator('em')).toHaveText('look');
	await expect(text.locator('strong')).toHaveText('cannot change it');
	await expect(text.locator('a')).toHaveAttribute(
		'href',
		'https://github.com/artshumrc/ballastella#readme'
	);

	// Nothing the sanitiser would have stripped, and nothing thrown — including during prerender, where
	// there is no DOM and the renderer refuses rather than returning its input unsanitised.
	expect(
		await page.evaluate(() => {
			const host = document.querySelector('[data-testid="viewer-annotation-text"]');
			const handlers: string[] = [];
			for (const element of host?.querySelectorAll('*') ?? []) {
				for (const attribute of element.attributes) {
					if (attribute.name.toLowerCase().startsWith('on')) handlers.push(attribute.name);
				}
			}
			return { scripts: host?.querySelectorAll('script').length ?? -1, handlers };
		})
	).toEqual({ scripts: 0, handlers: [] });
	expect(failures).toEqual([]);
});

import { expect, type Page } from './test.js';

import { PROJECT_DIRECTORY } from './annotations';
import { readStoredJsonOrNull } from './stored-file';

const storedProject = (page: Page, directory: string): Promise<{ layers?: unknown[] } | null> =>
	readStoredJsonOrNull<{ layers?: unknown[] }>(page, `${directory}/project.json`);

export async function waitForStoredLayers(
	page: Page,
	count: number,
	directory = PROJECT_DIRECTORY
): Promise<void> {
	await expect
		.poll(async () => (await storedProject(page, directory))?.layers?.length ?? -1, {
			message: `project.json in ${directory} should hold ${count} Layers`
		})
		.toBe(count);
}

// A MutationObserver records every state, since "saving" can pass between two polls. Poll the result.
export async function recordSaveStates(page: Page): Promise<() => Promise<string[]>> {
	await page.evaluate(() => {
		const indicator = document.querySelector('[data-save-state]');
		if (!indicator) throw new Error('no [data-save-state] element to observe');
		const seen: string[] = [indicator.getAttribute('data-save-state') ?? ''];
		new MutationObserver(() => {
			const state = indicator.getAttribute('data-save-state') ?? '';
			if (state !== seen[seen.length - 1]) seen.push(state);
		}).observe(indicator, { attributes: true, attributeFilter: ['data-save-state'] });
		(window as unknown as { __saveStates?: string[] }).__saveStates = seen;
	});
	return () =>
		page.evaluate(() => (window as unknown as { __saveStates?: string[] }).__saveStates ?? []);
}

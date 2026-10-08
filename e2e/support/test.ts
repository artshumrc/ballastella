import { DIALOG_PROBE_PREFIX, DIALOG_PROBE_SCRIPT } from './dialog-probe.js';
import { test as fenced } from './network-fence.js';
import { expect, type Page } from '@playwright/test';

export const DEFAULT_WORKSPACE = 'My Workspace';
const OPEN_WORKSPACE_KEY = 'ballastella.workspace';

const WORKSPACE_ROOT_SCRIPT = ({ fallback, key }: { fallback: string; key: string }): void => {
	const currentName = (): string => {
		try {
			return localStorage.getItem(key) || fallback;
		} catch {
			return fallback;
		}
	};
	const define = (name: string, value: unknown) =>
		Object.defineProperty(globalThis, name, { configurable: true, value });

	define('workspaceRoot', async () =>
		(await navigator.storage.getDirectory()).getDirectoryHandle(currentName(), { create: true })
	);
	define('workspaceRootIfAny', async () => {
		try {
			return await (await navigator.storage.getDirectory()).getDirectoryHandle(currentName());
		} catch {
			return null;
		}
	});
};

const VISITED_KEY = 'ballastella.visited';

export async function asFirstVisit(page: Page): Promise<void> {
	await page.addInitScript((key: string) => {
		try {
			localStorage.removeItem(key);
		} catch {}
	}, VISITED_KEY);
}

export const test = fenced.extend({
	page: async ({ page }, use, testInfo) => {
		await page.addInitScript(WORKSPACE_ROOT_SCRIPT, {
			fallback: DEFAULT_WORKSPACE,
			key: OPEN_WORKSPACE_KEY
		});

		if (testInfo.project.name !== 'viewer') {
			await page.addInitScript((key: string) => {
				try {
					localStorage.setItem(key, 'yes');
				} catch {}
			}, VISITED_KEY);
		}

		await page.addInitScript(DIALOG_PROBE_SCRIPT, { prefix: DIALOG_PROBE_PREFIX });
		const dialogLog: string[] = [];
		const started = Date.now();
		page.on('console', (message) => {
			const text = message.text();
			if (!text.startsWith(DIALOG_PROBE_PREFIX)) return;
			dialogLog.push(`+${Date.now() - started}ms ${text.slice(DIALOG_PROBE_PREFIX.length + 1)}`);
		});

		await use(page);

		if (testInfo.status !== testInfo.expectedStatus && dialogLog.length > 0) {
			const body = dialogLog.join('\n');
			await testInfo.attach('dialog-probe', { body, contentType: 'text/plain' });
			console.log(`\n${DIALOG_PROBE_PREFIX} ${testInfo.titlePath.join(' › ')}\n${body}\n`);
		}
	}
});

export { expect };
export type { ExternalAllowance } from './network-fence.js';
export type {
	BrowserContext,
	Download,
	Locator,
	Page,
	Request,
	Response,
	Route,
	TestInfo
} from '@playwright/test';

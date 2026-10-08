import { test as base, expect } from '@playwright/test';

export type ExternalAllowance = {
	readonly host: string;
	readonly why: string;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Whether the fence lets this past without an allowance. Exported for direct assertion (editor-network-fence.e2e.ts). Non-HTTP schemes pass: data:/blob:/about: reach no host. @param allowed the test file's declared allowances, if any */
export function reachesTheNetwork(
	url: string,
	allowed: readonly ExternalAllowance[] = []
): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
	if (LOCAL_HOSTS.has(parsed.hostname)) return false;
	return !allowed.some((allowance) => allowance.host === parsed.hostname);
}

export function networkFenceMessage(urls: readonly string[]): string {
	const list = urls.map((url) => `  ${url}`).join('\n');
	return [
		`This test reached ${urls.length === 1 ? 'an external origin' : 'external origins'}:`,
		list,
		'',
		'No test in this suite may depend on the network — a recorded decision by the repository',
		'owner, and the reason `demo-bucket.protomaps.com` turning 404 could turn this suite red',
		'for a reason that had nothing to do with the code under test.',
		'',
		'Route it to a committed fixture. For this deployment’s Base Map archive that is one line:',
		'',
		"    import { routeBaseMapArchive } from './support/editor-deployment.js';",
		'    test.beforeEach(async ({ page }) => routeBaseMapArchive(page));',
		'',
		'For anything else, add a fixture under `e2e/fixtures/` and `page.route` it. If the test',
		'genuinely cannot work against a fixture, declare it at the top of the spec with a reason:',
		'',
		"    test.use({ allowedExternalHosts: [{ host: 'example.com', why: '…' }] });",
		'',
		'The request was blocked, so anything the test reported before this is about a page that',
		'did not get an answer.'
	].join('\n');
}

export const test = base.extend<{ allowedExternalHosts: readonly ExternalAllowance[] }>({
	allowedExternalHosts: [[], { option: true }],

	context: async ({ context, allowedExternalHosts }, use, testInfo) => {
		const reached: string[] = [];
		const isExpectedFailure = () => testInfo.expectedStatus === 'failed';

		await context.route('**/*', async (route) => {
			const url = route.request().url();
			if (!reachesTheNetwork(url, allowedExternalHosts)) {
				await route.fallback();
				return;
			}
			if (!reached.includes(url)) {
				reached.push(url);
				if (!isExpectedFailure()) console.error(`\n⛔ ${networkFenceMessage([url])}\n`);
			}
			await route.abort('blockedbyclient');
		});

		await use(context);

		if (reached.length > 0) throw new Error(networkFenceMessage(reached));
	}
});

export { expect };

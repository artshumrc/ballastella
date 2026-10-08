import {
	createFakeGitHub,
	type FakeGitHub,
	type FakeGrants,
	type FakeRateLimit
} from '../../packages/core/src/remote/fake-github.js';
import {
	GITHUB_APP,
	isGitHubAppConfigured,
	type GitHubApp
} from '../../packages/core/src/remote/github-app.js';
import {
	GITHUB_APPS_URL,
	GITHUB_AUTHORIZE_URL
} from '../../packages/core/src/remote/github-sign-in.js';
import { expect, type BrowserContext, type Page, type Route } from './test.js';
import { writeStoredFiles } from './stored-file.js';
import { emptyBrowserStorage, HUB, seedGitHubCredential } from './workspace.js';

export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_RAW_ORIGIN = 'https://raw.githubusercontent.com';

export type FakeRepository = {
	readonly owner: string;
	readonly name: string;
	readonly files?: Readonly<Record<string, string>>;
	readonly push?: boolean;
	readonly private?: boolean;
	readonly contributors?: readonly string[];
	readonly pagesEnabled?: boolean;
	readonly refusePages?: boolean;
	readonly truncateAfter?: number;
	readonly rateLimit?: FakeRateLimit;
};

export type GitHubHostsOptions = {
	readonly repositories?: readonly FakeRepository[];
	readonly rejectCredential?: boolean;
	readonly signIn?: boolean;
	readonly brokerUnreachable?: boolean;
	readonly tokenLifetimeSeconds?: number;
	readonly login?: string;
	readonly grants?: FakeGrants;
};

export type GitHubHosts = {
	readonly requests: string[];
	readonly rawRequests: string[];
	pagesOn(owner: string, name: string): boolean;
	turnPagesOn(owner: string, name: string): void;
	files(owner: string, name: string): string[];
	fileText(owner: string, name: string, path: string): string | null;
	blobPosts(): number;
	head(owner: string, name: string): string | null;
	commitFiles(
		owner: string,
		name: string,
		files: Readonly<Record<string, string | null>>
	): Promise<void>;
	rawGets(owner: string, name: string): number;
	peakRawInFlight(): number;
	expireSignIn(): void;
	refuseRefresh(): void;
};

const SIGN_IN_APP: GitHubApp = GITHUB_APP;
const key = (owner: string, name: string): string => `${owner}/${name}`;

const notFound = (route: Route): Promise<void> =>
	route.fulfill({
		status: 404,
		contentType: 'application/json',
		body: JSON.stringify({ message: 'Not Found' })
	});

async function relay(route: Route, fake: FakeGitHub, forwardRequest = true): Promise<void> {
	const request = route.request();
	const method = request.method();
	const response = forwardRequest
		? await fake.fetch(request.url(), {
				method,
				headers: await request.allHeaders(),
				body: method === 'GET' || method === 'HEAD' ? undefined : (request.postData() ?? undefined)
			})
		: await fake.fetch(request.url());
	await route.fulfill({
		status: response.status,
		headers: Object.fromEntries(response.headers),
		body: Buffer.from(await response.arrayBuffer())
	});
}

// codeload.github.com is deliberately routed nowhere, so a Clone reaching for a tarball meets the network fence.
export async function routeGitHubHosts(
	target: Pick<Page, 'route' | 'url'> | Pick<BrowserContext, 'route'>,
	options: GitHubHostsOptions = {}
): Promise<GitHubHosts> {
	const requests: string[] = [];
	const rawRequests: string[] = [];
	let rawInFlight = 0;
	let peakRawInFlight = 0;
	const fakes = new Map<string, FakeGitHub>();

	const registeredCallback = (): string => {
		if (!('url' in target)) return '';
		const at = target.url();
		if (at === '' || at === 'about:blank') return '';
		const url = new URL(at);
		return `${url.origin}${url.pathname}`;
	};

	let primary: FakeGitHub | null = null;

	for (const repository of options.repositories ?? []) {
		const fake = await createFakeGitHub({
			owner: repository.owner,
			repository: repository.name,
			tree: repository.files ?? { 'README.md': '# Atlas\n' },
			...(options.signIn === true && primary === null
				? {
						signIn: {
							brokerOrigin: SIGN_IN_APP.brokerOrigin,
							clientId: SIGN_IN_APP.clientId,
							appSlug: SIGN_IN_APP.appSlug,
							callbackUrl: registeredCallback,
							login: options.login ?? repository.owner,
							tokenLifetimeSeconds: options.tokenLifetimeSeconds
						},
						...(options.grants === undefined ? {} : { grants: options.grants })
					}
				: {})
		});
		primary ??= fake;
		if (options.login !== undefined) fake.login = options.login;
		fake.contributors = [...(repository.contributors ?? [repository.owner])];
		fake.permissions = { push: repository.push ?? true, admin: false };
		fake.privateRepository = repository.private ?? false;
		fake.pagesEnabled = repository.pagesEnabled ?? false;
		fake.refusePages = repository.refusePages ?? false;
		fake.rejectCredential = options.rejectCredential ?? false;
		fake.truncateAfter = repository.truncateAfter ?? null;
		if (repository.rateLimit) fake.rateLimit = { ...repository.rateLimit };
		fakes.set(key(repository.owner, repository.name), fake);
	}

	if (options.signIn === true && primary !== null) {
		if (!isGitHubAppConfigured(SIGN_IN_APP)) {
			throw new Error(
				'This checkout has no GitHub App configured, so the sign-in surface cannot be served and ' +
					'no spec can drive it. See packages/core/src/remote/github-app.ts.'
			);
		}
		const signInFake = primary;

		const forward = async (route: Route): Promise<void> => {
			requests.push(new URL(route.request().url()).pathname);
			await relay(route, signInFake);
		};

		await target.route(`${GITHUB_AUTHORIZE_URL}*`, forward);
		await target.route(`${GITHUB_APPS_URL}/${SIGN_IN_APP.appSlug}/installations/new*`, forward);
		await target.route(`${SIGN_IN_APP.brokerOrigin}/**`, async (route) => {
			if (options.brokerUnreachable !== true) return forward(route);
			requests.push(new URL(route.request().url()).pathname);
			await route.abort('connectionfailed');
		});
	}

	await target.route(`${GITHUB_API_ORIGIN}/**`, async (route) => {
		const url = new URL(route.request().url());
		requests.push(url.pathname);

		const [scope, owner, name] = url.pathname.split('/').filter(Boolean);
		const fake =
			scope === 'user'
				? (primary ?? undefined)
				: scope === 'repos' && owner && name
					? fakes.get(key(owner, name))
					: undefined;
		return fake ? relay(route, fake) : notFound(route);
	});

	await target.route(`${GITHUB_RAW_ORIGIN}/**`, async (route) => {
		const url = new URL(route.request().url());
		rawRequests.push(url.pathname);

		const [owner, name] = url.pathname.split('/').filter(Boolean);
		const fake = owner && name ? fakes.get(key(owner, name)) : undefined;
		if (!fake) return notFound(route);

		rawInFlight += 1;
		peakRawInFlight = Math.max(peakRawInFlight, rawInFlight);
		try {
			await relay(route, fake, false);
		} finally {
			rawInFlight -= 1;
		}
	});

	const decoder = new TextDecoder();
	return {
		requests,
		rawRequests,
		pagesOn: (owner, name) => fakes.get(key(owner, name))?.pagesEnabled ?? false,
		turnPagesOn: (owner, name) => {
			const fake = fakes.get(key(owner, name));
			if (fake === undefined) {
				throw new Error(`No fake repository at ${key(owner, name)} to turn Pages on for.`);
			}
			fake.pagesEnabled = true;
		},
		files: (owner, name) => [...(fakes.get(key(owner, name))?.files().keys() ?? [])].sort(),
		fileText: (owner, name, path) => {
			const bytes = fakes.get(key(owner, name))?.files().get(path);
			return bytes === undefined ? null : decoder.decode(bytes);
		},
		blobPosts: () => [...fakes.values()].reduce((sum, fake) => sum + fake.blobPosts, 0),
		head: (owner, name) => fakes.get(key(owner, name))?.head() ?? null,
		commitFiles: async (owner, name, files) => {
			const fake = fakes.get(key(owner, name));
			if (fake === undefined) {
				throw new Error(`No fake repository at ${key(owner, name)} to commit to.`);
			}
			await fake.commitFiles(files);
		},
		rawGets: (owner, name) => fakes.get(key(owner, name))?.rawGets ?? 0,
		peakRawInFlight: () => peakRawInFlight,
		expireSignIn: () => primary?.expireIssuedTokens(),
		refuseRefresh: () => {
			if (primary !== null) primary.refuseRefresh = true;
		}
	};
}

export const OUTSIDE_NAMESPACE = ['README.md', 'CNAME', 'LICENSE', '.github/workflows/pages.yml'];
export const OWNER = 'ada';
export const REPOSITORY = 'atlas';
export const REMOTE = `${OWNER}/${REPOSITORY}`;
export const TOKEN = 'github_pat_11ABCDE0000abcdefghijklmnop';

export const seed = writeStoredFiles;

export const grantsFor = (repository: { push?: boolean; private?: boolean } = {}): FakeGrants => ({
	installationId: 1,
	account: OWNER,
	repositories: [{ owner: OWNER, repository: REPOSITORY, push: true, ...repository }]
});

export async function startOnTheHub(
	page: Page,
	options: GitHubHostsOptions,
	{ dropDatabase = false, credential }: { dropDatabase?: boolean; credential?: string } = {}
): Promise<GitHubHosts> {
	const github = await routeGitHubHosts(page, options);
	await page.goto(HUB);
	await emptyBrowserStorage(page, { forget: true, dropDatabase });
	if (credential !== undefined) await seedGitHubCredential(page, credential);
	await page.reload();
	return github;
}

export async function reloadOnTheHub(page: Page): Promise<void> {
	await page.reload();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
}

export async function reloadSignedIn(page: Page): Promise<void> {
	await seedGitHubCredential(page, TOKEN);
	await reloadOnTheHub(page);
}

export const syncDialog = (page: Page) => page.getByRole('dialog', { name: 'Sync with GitHub' });

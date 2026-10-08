import type { FetchFn } from '../injection/store-image-fetch.js';
import { messageOf } from '../store/project-store.js';
import { GITHUB_API_ORIGIN, githubFetch, problemOf } from './github-api.js';

export type GrantedInstallation = {
	readonly id: number;
	readonly account: string;
	readonly targetId: number;
	readonly isOrganization: boolean;
	readonly coversEverything: boolean;
};

export type GrantedRepository = {
	readonly owner: string;
	readonly repository: string;
	readonly canPush: boolean;
	readonly canGrantAccess: boolean;
	readonly isPrivate: boolean;
};

export type GrantedRepositoriesOutcome =
	| {
			readonly kind: 'listed';
			readonly repositories: readonly GrantedRepository[];
			readonly installations: readonly GrantedInstallation[];
	  }
	| {
			readonly kind: 'refused';
			readonly refusal: 'credential' | 'network';
			readonly message: string;
	  };

type GrantedRepositoriesOptions = {
	readonly token: string;
	readonly fetch?: FetchFn;
};

const PER_PAGE = 100;

class Refused extends Error {
	constructor(
		readonly refusal: 'credential' | 'network',
		message: string
	) {
		super(message);
	}
}

async function readEveryPage<T>(
	options: GrantedRepositoriesOptions,
	path: string,
	pageOf: (body: Record<string, unknown>) => {
		readonly total: number;
		readonly items: readonly T[];
	}
): Promise<T[]> {
	const request = githubFetch(options.fetch, options.token);
	const collected: T[] = [];

	for (let page = 1; ; page += 1) {
		const url = `${GITHUB_API_ORIGIN}${path}?per_page=${PER_PAGE}&page=${page}`;
		const response = await request(url).catch((cause: unknown) => {
			throw new Refused('network', unreachableMessage(cause));
		});
		if (response.status === 401 || response.status === 403) {
			throw new Refused('credential', signInEndedMessage());
		}
		if (!response.ok) throw new Refused('network', refusedMessage(await problemOf(response)));
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		const { total, items } = pageOf(body);
		collected.push(...items);
		if (items.length === 0 || collected.length >= total) return collected;
	}
}

const countOf = (body: Record<string, unknown>): number =>
	typeof body.total_count === 'number' ? body.total_count : 0;

const arrayAt = (body: Record<string, unknown>, key: string): Record<string, unknown>[] => {
	const found = body[key];
	return Array.isArray(found) ? (found as Record<string, unknown>[]) : [];
};

function narrowInstallation(reported: Record<string, unknown>): GrantedInstallation | null {
	const id = reported.id;
	if (typeof id !== 'number') return null;
	const account = reported.account as { login?: unknown } | undefined;
	const targetId = reported.target_id;
	return {
		id,
		account: typeof account?.login === 'string' ? account.login : '',
		targetId: typeof targetId === 'number' ? targetId : 0,
		isOrganization: reported.target_type === 'Organization',
		coversEverything: reported.repository_selection === 'all'
	};
}

const readInstallations = (options: GrantedRepositoriesOptions): Promise<GrantedInstallation[]> =>
	readEveryPage(options, '/user/installations', (body) => ({
		total: countOf(body),
		items: arrayAt(body, 'installations')
			.map(narrowInstallation)
			.filter((one): one is GrantedInstallation => one !== null)
	}));

function narrow(reported: Record<string, unknown>): GrantedRepository | null {
	const fullName = reported.full_name;
	if (typeof fullName !== 'string') return null;
	const slash = fullName.indexOf('/');
	if (slash <= 0 || slash === fullName.length - 1) return null;
	const permissions = reported.permissions as { push?: unknown; admin?: unknown } | undefined;
	return {
		owner: fullName.slice(0, slash),
		repository: fullName.slice(slash + 1),
		canPush: permissions?.push === true,
		canGrantAccess: permissions?.admin === true,
		isPrivate: reported.private === true
	};
}

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const byOwnerThenRepository = (left: GrantedRepository, right: GrantedRepository): number =>
	compare(left.owner, right.owner) || compare(left.repository, right.repository);

export async function readGrantedRepositories(
	options: GrantedRepositoriesOptions
): Promise<GrantedRepositoriesOutcome> {
	try {
		const repositories: GrantedRepository[] = [];
		const installations = await readInstallations(options);
		for (const installation of installations) {
			const reported = await readEveryPage(
				options,
				`/user/installations/${installation.id}/repositories`,
				(body) => ({ total: countOf(body), items: arrayAt(body, 'repositories') })
			);
			for (const one of reported) {
				const granted = narrow(one);
				if (granted !== null) repositories.push(granted);
			}
		}
		return {
			kind: 'listed',
			repositories: repositories.sort(byOwnerThenRepository),
			installations
		};
	} catch (cause) {
		if (cause instanceof Refused) {
			return { kind: 'refused', refusal: cause.refusal, message: cause.message };
		}
		throw cause;
	}
}

const signInEndedMessage = (): string =>
	`Your GitHub sign-in has ended, so your repositories could not be read. Nothing is wrong with ` +
	`your work — everything you have is still saved on this computer. Sign in to GitHub again to ` +
	`carry on.`;

const unreachableMessage = (cause: unknown): string =>
	`GitHub could not be reached, so your repositories could not be read. The browser reported: ` +
	`${messageOf(cause)}. Everything you have is still saved on this computer. Check your connection and ` +
	`try again.`;

const refusedMessage = (detail: string): string =>
	`GitHub could not list your repositories just now: ${detail}. Everything you have is still ` +
	`saved on this computer. This is GitHub rather than your work, so trying again in a moment is ` +
	`usually enough.`;

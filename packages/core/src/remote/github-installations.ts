// Which repositories a signed-in author has given this App access to, read from GitHub and from
// nowhere else (ADR-0031).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A REJECTED SIGN-IN IS A REFUSAL AND NEVER AN EMPTY LIST
//
// The one behaviour everything else here is arranged around. An expired or revoked sign-in that
// answered "you have no repositories" would send a student to GitHub to create a second repository
// they do not need — and the new one would not appear either, because the sign-in is what is wrong.
// So a 401 or a 403 is `refusal: 'credential'`, a transport failure is `refusal: 'network'`, and an
// empty `listed` means GitHub was asked and said the author has granted nothing.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// NOTHING IS REMEMBERED AND NOTHING IS CREATED
//
// This is a read. There is no cache anywhere — not in storage, not in a module-level variable —
// because a remembered listing is a second answer free to disagree with GitHub's, and access granted
// on GitHub's own screen a moment ago is exactly the case the sequence has to see.
//
// And only the two endpoints below are called. `POST /user/repos` is not documented for GitHub App
// user access tokens and `PUT /user/installations/{id}/repositories/{id}` is documented for classic
// personal access tokens only, so creating a repository and granting access to one are both things
// the author does on GitHub's screens.

import type { FetchFn } from '../injection/store-image-fetch.js';
import { GITHUB_API_ORIGIN } from './github-api.js';

/**
 * One installation of the App, narrowed to what the sequence needs of it.
 *
 * ⚠ **`coversEverything` is a runtime reading and not an assumption.** GitHub's promise that *All
 * repositories* covers repositories made later is stated on their install screen rather than in
 * their documented contract, so the sequence asks rather than trusts — and where the answer is
 * `all`, the grant step is not merely quiet but absent.
 */
export type GrantedInstallation = {
	readonly id: number;
	/** `account.login`: whose account the App is installed on. */
	readonly account: string;
	/** `target_id`, which is the account's identifier and not the installation's. */
	readonly targetId: number;
	/** `target_type === 'Organization'`, which decides whose admin can widen the grant. */
	readonly isOrganization: boolean;
	/** `repository_selection === 'all'`. */
	readonly coversEverything: boolean;
};

/** One repository the author has granted access to, narrowed to what a choice needs. */
export type GrantedRepository = {
	readonly owner: string;
	readonly repository: string;
	/** `permissions.push` as GitHub reports it. */
	readonly canPush: boolean;
	/**
	 * `permissions.admin` as GitHub reports it, which is whether the author administers the
	 * repository — and so whether widening a narrow grant is theirs to do or somebody else's.
	 */
	readonly canGrantAccess: boolean;
	/** A private repository cannot serve a Published Site on the free tier. */
	readonly isPrivate: boolean;
};

export type GrantedRepositoriesOutcome =
	| {
			readonly kind: 'listed';
			readonly repositories: readonly GrantedRepository[];
			/** In the order GitHub answered in, which is the order the App was installed in. */
			readonly installations: readonly GrantedInstallation[];
	  }
	| {
			readonly kind: 'refused';
			readonly refusal: 'credential' | 'network';
			/** In the words the author should see. */
			readonly message: string;
	  };

export type GrantedRepositoriesOptions = {
	/**
	 * An opaque bearer credential. Where it came from is not this module's business (ADR-0031):
	 * a pasted fine-grained token and a broker-exchanged one are the same string here.
	 */
	readonly token: string;
	/** Defaulting to the page's own, as `bind-remote` and the send engine already do. */
	readonly fetch?: FetchFn;
};

/** GitHub's own ceiling, and the fewest requests a listing of any size can be read in. */
const PER_PAGE = 100;

/** A refusal on its way out of a page read, carrying what the author should be told. */
class Refused extends Error {
	readonly refusal: 'credential' | 'network';

	constructor(refusal: 'credential' | 'network', message: string) {
		super(message);
		this.name = 'Refused';
		this.refusal = refusal;
	}
}

/** GitHub's own words for a refusal, which are more useful than a status code alone. */
async function problemOf(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { message?: unknown };
		return typeof body?.message === 'string' ? body.message : response.statusText;
	} catch {
		return response.statusText;
	}
}

/**
 * Every item of a paginated listing, followed to the end.
 *
 * ⚠ **Driven by `total_count`, not by the first page.** A student with more than a hundred
 * repositories would otherwise be shown a list their own is missing from, and the failure would look
 * like access they had granted not registering.
 *
 * ⚠ **A page carrying nothing ends the read whatever the count said.** GitHub's `total_count` and
 * its pages disagreeing is not something this can resolve, and the alternative to stopping is a loop
 * that never does.
 */
async function readEveryPage<T>(
	options: GrantedRepositoriesOptions,
	path: string,
	pageOf: (body: Record<string, unknown>) => {
		readonly total: number;
		readonly items: readonly T[];
	}
): Promise<T[]> {
	const request = options.fetch ?? ((input, init) => fetch(input, init));
	const collected: T[] = [];

	for (let page = 1; ; page += 1) {
		const url = `${GITHUB_API_ORIGIN}${path}?per_page=${PER_PAGE}&page=${page}`;
		let response: Response;
		try {
			response = await request(url, {
				headers: {
					Accept: 'application/vnd.github+json',
					Authorization: `Bearer ${options.token}`
				}
			});
		} catch (cause) {
			throw new Refused('network', unreachableMessage(cause));
		}
		// 403 is here with 401 because the two are one answer to the author: a sign-in GitHub will not
		// act on. It carries no separate remedy, and telling somebody to wait would be a guess.
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

/**
 * One installation as GitHub reports it, or `null` when it carries no identifier to read it by.
 */
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

/** The installations this sign-in can see. */
const readInstallations = (options: GrantedRepositoriesOptions): Promise<GrantedInstallation[]> =>
	readEveryPage(options, '/user/installations', (body) => ({
		total: countOf(body),
		items: arrayAt(body, 'installations')
			.map(narrowInstallation)
			.filter((one): one is GrantedInstallation => one !== null)
	}));

/**
 * One repository as GitHub reports it, or `null` when it cannot be read as one.
 *
 * `full_name` is the only place the owner is taken from, because it is the pair the rest of this
 * codebase names a Remote by — and an entry without one is an entry nothing could be bound to.
 */
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

const byOwnerThenRepository = (left: GrantedRepository, right: GrantedRepository): number =>
	left.owner < right.owner
		? -1
		: left.owner > right.owner
			? 1
			: left.repository < right.repository
				? -1
				: left.repository > right.repository
					? 1
					: 0;

/**
 * Every repository the author has granted this App access to, or why they could not be read.
 *
 * Sorted by owner then repository, so the order a person sees is this module's and not GitHub's to
 * change between two reads of the same account.
 */
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

// ── What the refusals say ─────────────────────────────────────────────────────────────────────

/**
 * What a rejected sign-in says.
 *
 * It says *sign in again* rather than naming a token, because on a deployment with an App there is
 * no token in this story at all — a user-to-server sign-in lasts eight hours and this is what its
 * ending looks like from here.
 */
function signInEndedMessage(): string {
	return (
		`Your GitHub sign-in has ended, so your repositories could not be read. Nothing is wrong with ` +
		`your work — everything you have is still saved on this computer. Sign in to GitHub again to ` +
		`carry on.`
	);
}

function unreachableMessage(cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return (
		`GitHub could not be reached, so your repositories could not be read. The browser reported: ` +
		`${detail}. Everything you have is still saved on this computer. Check your connection and ` +
		`try again.`
	);
}

function refusedMessage(detail: string): string {
	return (
		`GitHub could not list your repositories just now: ${detail}. Everything you have is still ` +
		`saved on this computer. This is GitHub rather than your work, so trying again in a moment is ` +
		`usually enough.`
	);
}

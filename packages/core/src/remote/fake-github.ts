import type { FetchFn } from '../injection/store-image-fetch.js';
import { gitBlobSha } from './blob-sha.js';
import { GITHUB_API_ORIGIN, GITHUB_RAW_ORIGIN } from './github-api.js';
import { GITHUB_APPS_URL, GITHUB_AUTHORIZE_URL } from './github-sign-in.js';

export type FakeTreeEntry = {
	readonly path: string;
	readonly mode: string;
	readonly type: 'blob' | 'tree' | 'commit';
	readonly sha: string;
	readonly size?: number;
};

type FakeGrantedRepository = {
	readonly owner: string;
	readonly repository: string;
	readonly push: boolean;
	readonly admin?: boolean;
	readonly private?: boolean;
};

export type FakeGrants = {
	readonly installationId: number;
	readonly account: string;
	readonly repositories: readonly FakeGrantedRepository[];
	readonly targetId?: number;
	readonly repositorySelection?: 'all' | 'selected';
	readonly accountType?: 'User' | 'Organization';
};

type FakeSignIn = {
	readonly brokerOrigin: string;
	readonly clientId: string;
	readonly appSlug: string;
	readonly callbackUrl?: string | (() => string);
	readonly login?: string;
	readonly tokenLifetimeSeconds?: number;
};

export type FakeRateLimit = { remaining: number; reset: number };

export type FakeGitHub = Awaited<ReturnType<typeof createFakeGitHub>>;

type Entry = { readonly sha: string; readonly mode: string };

type StoredTree = ReadonlyMap<string, Entry>;

type StoredCommit = {
	readonly message: string;
	readonly tree: string;
	readonly parents: readonly string[];
	readonly date: string;
};

const encoder = new TextEncoder();
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const sortedEntries = (tree: Iterable<[string, Entry]>): [string, Entry][] =>
	[...tree].sort(([left], [right]) => compare(left, right));

const objectId = (serialised: string): Promise<string> => gitBlobSha(encoder.encode(serialised));

const serialiseTree = (tree: StoredTree): string =>
	sortedEntries(tree)
		.map(([path, entry]) => `${entry.mode} ${path}\0${entry.sha}`)
		.join('\n');

const serialiseCommit = ({ tree, parents, message }: Omit<StoredCommit, 'date'>): string =>
	`tree ${tree}\n${parents.map((parent) => `parent ${parent}\n`).join('')}\n${message}`;

const bytesOf = (content: string | Uint8Array): Uint8Array<ArrayBuffer> =>
	typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);

const decodeBase64 = (content: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(atob(content), (character) => character.charCodeAt(0));

const BLOB_MODES = new Set(['100644', '100755', '120000']);
const GITLINK_MODE = '160000';

// A stray `%` throws URIError, and a FetchFn must resolve rather than throw.
const decodePath = (pathname: string): string[] => {
	try {
		return pathname.split('/').filter(Boolean).map(decodeURIComponent);
	} catch {
		return [];
	}
};

const tokenOf = (request: Request): string | undefined =>
	/^\s*(?:bearer|token)\s+(\S+)/i.exec(request.headers.get('authorization') ?? '')?.[1];

const readBody = async (request: Request): Promise<Record<string, unknown>> => {
	const text = await request.text();
	return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
};

const installation = (given: FakeGrants) => ({
	...given,
	targetId: given.targetId ?? given.installationId + 1_000_000,
	repositorySelection: given.repositorySelection ?? 'selected',
	accountType: given.accountType ?? 'User',
	repositories: [...given.repositories]
});

export async function createFakeGitHub(options: {
	readonly owner: string;
	readonly repository: string;
	readonly branch?: string;
	readonly tree?: Readonly<Record<string, string | Uint8Array>>;
	readonly submodules?: Readonly<Record<string, string>>;
	readonly signIn?: FakeSignIn;
	readonly grants?: FakeGrants;
	readonly now?: () => Date;
}) {
	const defaultBranch = options.branch ?? 'main';
	const now = options.now ?? ((): Date => new Date());
	const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
	const trees = new Map<string, StoredTree>();
	const commits = new Map<string, StoredCommit>();
	const refs = new Map<string, string>();
	const codes = new Map<string, { redirectUri: string; spent: boolean }>();
	const issuedTokens = new Map<string, { expired: boolean }>();
	const refreshTokens = new Set<string>();
	let issued = 0;
	let grants = options.grants && installation(options.grants);

	const fake = {
		truncateAfter: null as number | null,
		refuseWrites: false,
		rejectCredential: false,
		refusePages: false,
		permissions: { push: true, admin: true },
		pagesEnabled: false,
		privateRepository: false,
		rateLimit: { remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 } as FakeRateLimit,
		login: options.signIn?.login ?? 'ada',
		contributors: [options.owner],
		refuseRefresh: false,
		blobPosts: 0,
		rawGets: 0
	};

	const nextValue = (prefix: string): string => {
		issued += 1;
		return `${prefix}_${issued.toString().padStart(4, '0')}`;
	};

	const storeBlob = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
		const sha = await gitBlobSha(bytes);
		blobs.set(sha, bytes);
		return sha;
	};

	const storeTree = async (entries: StoredTree): Promise<string> => {
		const sha = await objectId(serialiseTree(entries));
		trees.set(sha, entries);
		return sha;
	};

	const storeCommit = async (commit: Omit<StoredCommit, 'date'>): Promise<string> => {
		const sha = await objectId(serialiseCommit(commit));
		commits.set(sha, { ...commit, date: now().toISOString() });
		return sha;
	};

	const resolveTree = (ref: string): StoredTree | null => {
		const commit = commits.get(refs.get(ref.replace(/^refs\/heads\//, '')) ?? ref);
		return trees.get(commit?.tree ?? ref) ?? null;
	};

	const entriesAt = (ref: string): [string, Entry][] => sortedEntries(resolveTree(ref) ?? []);

	if (options.tree || options.submodules) {
		const entries = new Map<string, Entry>();
		for (const [path, content] of Object.entries(options.tree ?? {})) {
			entries.set(path, { sha: await storeBlob(bytesOf(content)), mode: '100644' });
		}
		for (const [path, sha] of Object.entries(options.submodules ?? {})) {
			entries.set(path, { sha, mode: GITLINK_MODE });
		}
		const tree = await storeTree(entries);
		refs.set(defaultBranch, await storeCommit({ message: 'Initial commit', tree, parents: [] }));
	}

	const listing = async (tree: StoredTree): Promise<FakeTreeEntry[]> => {
		const entries: FakeTreeEntry[] = [...tree].map(([path, { sha, mode }]) =>
			mode === GITLINK_MODE
				? { path, mode, type: 'commit', sha }
				: { path, mode, type: 'blob', sha, size: blobs.get(sha)?.byteLength ?? 0 }
		);
		const directories = new Set(
			[...tree.keys()].flatMap((path) => {
				const segments = path.split('/');
				return segments.slice(1).map((_, depth) => segments.slice(0, depth + 1).join('/'));
			})
		);
		for (const directory of directories) {
			const prefix = `${directory}/`;
			const under = new Map(
				[...tree]
					.filter(([path]) => path.startsWith(prefix))
					.map(([path, entry]) => [path.slice(prefix.length), entry] as const)
			);
			entries.push({ path: directory, mode: '040000', type: 'tree', sha: await storeTree(under) });
		}
		return entries.sort((left, right) => compare(left.path, right.path));
	};

	const headers = (): Record<string, string> => ({
		'X-RateLimit-Remaining': String(fake.rateLimit.remaining),
		'X-RateLimit-Reset': String(fake.rateLimit.reset),
		// api.github.com sends this CORS pair; without it a browser cannot read the rate-limit headers.
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Expose-Headers': 'X-RateLimit-Remaining, X-RateLimit-Reset'
	});

	const json = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: { ...headers(), 'content-type': 'application/json' }
		});

	const problem = (status: number, message: string): Response => json({ message }, status);
	const notFound = (message = 'Not Found'): Response => problem(404, message);
	const unimplemented = (url: URL): Response =>
		notFound(`${url.pathname} is not a path this fake implements.`);
	const rawNotFound = (): Response =>
		new Response('404: Not Found', { status: 404, headers: headers() });
	const unauthenticated = (): Response => problem(401, 'Requires authentication');
	const forbidden = (): Response =>
		problem(403, 'Resource not accessible by personal access token');
	const empty = (): Response => problem(409, 'Git Repository is empty.');
	const noContent = (): Response => new Response(null, { status: 204 });
	const notACommit = (sha: unknown): Response =>
		problem(422, `${sha} is not a commit this repository holds.`);
	const emptyOrMissing = (ref: string): Response =>
		refs.size === 0 ? empty() : notFound(`${ref} is not a ref.`);

	const paginated = (key: string, items: readonly unknown[], url: URL): Response => {
		const askedSize = Number(url.searchParams.get('per_page'));
		const perPage = Number.isFinite(askedSize) && askedSize > 0 ? Math.min(askedSize, 100) : 30;
		const askedPage = Number(url.searchParams.get('page'));
		const page = Number.isFinite(askedPage) && askedPage > 0 ? Math.floor(askedPage) : 1;
		return json({
			total_count: items.length,
			[key]: items.slice((page - 1) * perPage, page * perPage)
		});
	};

	const answerUser = (path: string[], url: URL): Response => {
		if (path.length === 1) return json({ login: fake.login });
		if (path.length === 2) {
			return paginated(
				'installations',
				grants
					? [
							{
								id: grants.installationId,
								account: { login: grants.account, type: grants.accountType },
								target_id: grants.targetId,
								target_type: grants.accountType,
								repository_selection: grants.repositorySelection
							}
						]
					: [],
				url
			);
		}
		if (
			grants &&
			path.length === 4 &&
			path[3] === 'repositories' &&
			path[2] === String(grants.installationId)
		) {
			return paginated(
				'repositories',
				grants.repositories.map((one, at) => ({
					id: at + 1,
					name: one.repository,
					full_name: `${one.owner}/${one.repository}`,
					private: one.private === true,
					permissions: { push: one.push, admin: one.admin === true }
				})),
				url
			);
		}
		return unimplemented(url);
	};

	const answerApi = async (
		url: URL,
		request: Request,
		credentialed: boolean
	): Promise<Response> => {
		const method = request.method.toUpperCase();
		const body = (): Promise<Record<string, unknown>> => readBody(request);
		const path = decodePath(url.pathname);

		if (
			method === 'GET' &&
			path[0] === 'user' &&
			(path.length === 1 || path[1] === 'installations')
		) {
			return credentialed ? answerUser(path, url) : unauthenticated();
		}

		const [scope, owner, repository, ...rest] = path;
		if (scope !== 'repos' || owner !== options.owner || repository !== options.repository) {
			return unimplemented(url);
		}
		if (fake.privateRepository && !credentialed) return notFound();

		type Answer = () => Response | Promise<Response>;
		const authenticated = (answer: Answer) => (credentialed ? answer() : unauthenticated());
		const write = (answer: Answer) =>
			authenticated(() => (fake.refuseWrites ? forbidden() : answer()));
		const database = (answer: Answer) => write(() => (refs.size === 0 ? empty() : answer()));
		const pagesWrite = (answer: Answer) =>
			authenticated(() => (fake.refusePages ? forbidden() : answer()));

		const routes: [RegExp, (param: string) => Response | Promise<Response>][] = [
			[/^GET $/, () => json(credentialed ? { permissions: { ...fake.permissions } } : {})],
			[
				/^PUT contents\/(.+)$/,
				(file) =>
					write(async () => {
						const { content, branch, message } = (await body()) as {
							content?: string;
							branch?: string;
							message?: string;
						};
						if (typeof content !== 'string') {
							return problem(400, 'This fake takes file content as base64 and nothing else.');
						}
						const target = branch || defaultBranch;
						if (refs.has(target)) {
							return problem(
								422,
								`${target} already exists; this fake seeds an empty repository only.`
							);
						}
						const sha = await storeBlob(decodeBase64(content));
						const tree = await storeTree(new Map([[file, { sha, mode: '100644' }]]));
						const commit = await storeCommit({ message: message ?? '', tree, parents: [] });
						refs.set(target, commit);
						return json({ content: { path: file, sha }, commit: { sha: commit } }, 201);
					})
			],
			[
				/^GET contributors$/,
				() =>
					fake.contributors.length === 0
						? noContent()
						: json(fake.contributors.map((login) => ({ login })))
			],
			[
				/^GET pages$/,
				() =>
					authenticated(() =>
						fake.pagesEnabled
							? json({
									status: 'built',
									html_url: `https://${options.owner}.github.io/${options.repository}/`
								})
							: notFound()
					)
			],
			[
				/^DELETE pages$/,
				() =>
					pagesWrite(() => {
						if (!fake.pagesEnabled) return notFound();
						fake.pagesEnabled = false;
						return noContent();
					})
			],
			[
				/^POST pages$/,
				() =>
					pagesWrite(async () => {
						if (fake.pagesEnabled) {
							return problem(409, 'GitHub Pages is already enabled for this repo.');
						}
						const { source } = (await body()) as { source?: { branch?: string; path?: string } };
						if (typeof source?.branch !== 'string' || typeof source.path !== 'string') {
							return problem(400, 'Enabling Pages needs a source branch and path.');
						}
						if (!refs.has(source.branch)) {
							return json(
								{
									message: 'Validation Failed',
									errors: [{ resource: 'PagesSourceHash', field: 'source', code: 'invalid' }]
								},
								422
							);
						}
						fake.pagesEnabled = true;
						return json({ source }, 201);
					})
			],
			[
				/^GET git\/ref\/heads\/(.+)$/,
				(branch) => {
					const at = refs.get(branch);
					if (at === undefined) return emptyOrMissing(branch);
					return json({ ref: `refs/heads/${branch}`, object: { sha: at, type: 'commit' } });
				}
			],
			[
				/^GET git\/trees\/(.+)$/,
				async (ref) => {
					const tree = resolveTree(ref);
					if (tree === null) return emptyOrMissing(ref);
					const recursive = url.searchParams.has('recursive');
					const entries = (await listing(tree)).filter(
						(entry) => recursive || !entry.path.includes('/')
					);
					const cut = fake.truncateAfter;
					const truncated = cut !== null && cut < entries.length;
					return json({
						sha: await objectId(serialiseTree(tree)),
						tree: truncated ? entries.slice(0, cut) : entries,
						truncated
					});
				}
			],
			[
				/^GET git\/commits\/([^/]+)$/,
				(sha) => {
					const commit = commits.get(sha);
					if (commit === undefined) return emptyOrMissing(sha);
					return json({
						sha,
						message: commit.message,
						tree: { sha: commit.tree },
						parents: commit.parents.map((parent) => ({ sha: parent })),
						author: { date: commit.date },
						committer: { date: commit.date }
					});
				}
			],
			[
				/^POST git\/blobs$/,
				() => {
					fake.blobPosts += 1;
					return database(async () => {
						const { content, encoding } = (await body()) as { content?: string; encoding?: string };
						if (typeof content !== 'string' || encoding !== 'base64') {
							return problem(400, 'This fake takes blob content as base64 and nothing else.');
						}
						return json({ sha: await storeBlob(decodeBase64(content)) }, 201);
					});
				}
			],
			[
				/^POST git\/trees$/,
				() =>
					database(async () => {
						const posted = await body();
						if ('base_tree' in posted) {
							return problem(400, 'This fake does not implement base_tree; post the whole tree.');
						}
						if (!Array.isArray(posted.tree)) return problem(400, 'A tree needs a tree array.');
						const entries = new Map<string, Entry>();
						for (const entry of posted.tree as Record<string, unknown>[]) {
							const { path, mode, type, sha } = entry;
							if (
								typeof path !== 'string' ||
								path === '' ||
								typeof mode !== 'string' ||
								typeof sha !== 'string' ||
								(type === 'commit'
									? mode !== GITLINK_MODE || sha === ''
									: type !== 'blob' || !BLOB_MODES.has(mode) || !blobs.has(sha))
							) {
								return problem(
									422,
									`${JSON.stringify(entry)} is neither a blob this repository holds nor a gitlink.`
								);
							}
							entries.set(path, { sha, mode });
						}
						return json({ sha: await storeTree(entries) }, 201);
					})
			],
			[
				/^POST git\/commits$/,
				() =>
					database(async () => {
						const { message, tree, parents } = (await body()) as {
							message?: string;
							tree?: string;
							parents?: string[];
						};
						if (typeof tree !== 'string' || !trees.has(tree)) {
							return problem(422, `${tree} is not a tree this repository holds.`);
						}
						const chain = parents ?? [];
						const orphan = chain.find((parent) => !commits.has(parent));
						if (orphan !== undefined) return notACommit(orphan);
						return json(
							{ sha: await storeCommit({ message: message ?? '', tree, parents: chain }) },
							201
						);
					})
			],
			[
				/^PATCH git\/refs\/heads\/(.+)$/,
				(branch) =>
					write(async () => {
						const { sha } = (await body()) as { sha?: string };
						if (!refs.has(branch)) return problem(422, 'Reference does not exist');
						if (sha === undefined || !commits.has(sha)) return notACommit(sha);
						refs.set(branch, sha);
						return json({ ref: `refs/heads/${branch}`, object: { sha } });
					})
			]
		];

		const route = `${method} ${rest.join('/')}`;
		for (const [pattern, answer] of routes) {
			const match = pattern.exec(route);
			if (match) return answer(match[1] ?? '');
		}
		return unimplemented(url);
	};

	const answerRaw = (url: URL, credentialed: boolean): Response => {
		fake.rawGets += 1;
		if (fake.privateRepository && !credentialed) return rawNotFound();
		const [owner, repository, ref, ...rest] = decodePath(url.pathname);
		if (
			owner !== options.owner ||
			repository !== options.repository ||
			ref === undefined ||
			rest.length === 0
		) {
			return unimplemented(url);
		}
		const sha = resolveTree(ref)?.get(rest.join('/'))?.sha;
		const bytes = sha === undefined ? undefined : blobs.get(sha);
		return bytes ? new Response(bytes, { status: 200, headers: headers() }) : rawNotFound();
	};

	const grantTokens = (signIn: FakeSignIn): Response => {
		const token = nextValue('ghu');
		const refresh = nextValue('ghr');
		issuedTokens.set(token, { expired: false });
		refreshTokens.add(refresh);
		return json({
			access_token: token,
			token_type: 'bearer',
			expires_in: signIn.tokenLifetimeSeconds ?? 8 * 3600,
			refresh_token: refresh,
			refresh_token_expires_in: 6 * 30 * 24 * 3600
		});
	};

	const issueCode = (redirectUri: string, url: URL): Response => {
		const code = nextValue('code');
		codes.set(code, { redirectUri, spent: false });
		const back = new URL(redirectUri);
		back.searchParams.set('code', code);
		back.searchParams.set('state', url.searchParams.get('state') ?? '');
		return new Response(null, {
			status: 302,
			headers: { ...headers(), location: back.toString() }
		});
	};

	const oauthError = (error: string, description: string): Response =>
		json({ error, error_description: description });

	const answerBroker = async (
		url: URL,
		request: Request,
		signIn: FakeSignIn
	): Promise<Response> => {
		if (request.method.toUpperCase() !== 'POST') return problem(405, 'Method Not Allowed');
		const sent = await readBody(request);
		if (sent.client_id !== signIn.clientId) {
			return oauthError('invalid_client', 'No client secret is held for that client_id.');
		}
		if (url.pathname === '/github/token') {
			const held = codes.get(sent.code as string);
			if (held === undefined || held.spent) {
				return oauthError('bad_verification_code', 'The code passed is incorrect or expired.');
			}
			if (sent.redirect_uri !== held.redirectUri) {
				return oauthError('redirect_uri_mismatch', 'The redirect_uri is not associated with it.');
			}
			held.spent = true;
			return grantTokens(signIn);
		}
		if (url.pathname === '/github/refresh') {
			const refresh = sent.refresh_token as string;
			if (fake.refuseRefresh || !refreshTokens.has(refresh)) {
				return oauthError('bad_refresh_token', 'The refresh token passed is incorrect or expired.');
			}
			refreshTokens.delete(refresh);
			return grantTokens(signIn);
		}
		return notFound(`${url.pathname} is not a path this broker implements.`);
	};

	const answerSignIn = (url: URL, request: Request, signIn: FakeSignIn) => {
		if (url.origin === signIn.brokerOrigin) return answerBroker(url, request, signIn);
		const address = url.href.split('?')[0];
		if (address === GITHUB_AUTHORIZE_URL) {
			const redirectUri = url.searchParams.get('redirect_uri') ?? '';
			if (url.searchParams.get('client_id') !== signIn.clientId) return rawNotFound();
			if (redirectUri === '') return problem(400, 'redirect_uri is required');
			return issueCode(redirectUri, url);
		}
		if (address === `${GITHUB_APPS_URL}/${signIn.appSlug}/installations/new`) {
			const registered = signIn.callbackUrl;
			const redirectUri = (
				typeof registered === 'function' ? registered() : (registered ?? '')
			).trim();
			if (redirectUri === '') {
				return problem(400, 'This App has no callback URL registered, so nowhere to return to.');
			}
			return issueCode(redirectUri, url);
		}
		return null;
	};

	const fetchFn: FetchFn = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const token = tokenOf(request);
		const signedIn = options.signIn && answerSignIn(url, request, options.signIn);
		if (signedIn) return signedIn;

		if (url.origin === GITHUB_RAW_ORIGIN) return answerRaw(url, token !== undefined);
		if (url.origin !== GITHUB_API_ORIGIN) {
			return notFound(`${url.origin} is not a host this fake implements.`);
		}

		if (fake.rateLimit.remaining <= 0) return problem(403, 'API rate limit exceeded');
		fake.rateLimit.remaining -= 1;

		if (token !== undefined && (fake.rejectCredential || issuedTokens.get(token)?.expired)) {
			return problem(401, 'Bad credentials');
		}
		return answerApi(url, request, token !== undefined);
	};

	return Object.assign(fake, {
		fetch: fetchFn,
		files: (ref = defaultBranch): Map<string, Uint8Array> =>
			new Map(
				entriesAt(ref).flatMap(([path, { sha }]) => {
					const bytes = blobs.get(sha);
					return bytes ? [[path, new Uint8Array(bytes)]] : [];
				})
			),
		gitlinks: (ref = defaultBranch): Map<string, string> =>
			new Map(
				entriesAt(ref)
					.filter(([, { mode }]) => mode === GITLINK_MODE)
					.map(([path, { sha }]) => [path, sha])
			),
		head: (branch = defaultBranch): string | null => refs.get(branch) ?? null,
		history(branch = defaultBranch): string[] {
			const chain: string[] = [];
			for (let at = refs.get(branch); at !== undefined; at = commits.get(at)?.parents[0]) {
				chain.push(at);
			}
			return chain;
		},
		async commitFiles(
			files: Readonly<Record<string, string | Uint8Array | null>>,
			branch = defaultBranch
		): Promise<string> {
			const entries = new Map(resolveTree(branch) ?? []);
			for (const [path, content] of Object.entries(files)) {
				if (content === null) entries.delete(path);
				else entries.set(path, { sha: await storeBlob(bytesOf(content)), mode: '100644' });
			}
			const parent = refs.get(branch);
			const commit = await storeCommit({
				message: 'Edited on github.com',
				tree: await storeTree(entries),
				parents: parent === undefined ? [] : [parent]
			});
			refs.set(branch, commit);
			return commit;
		},
		grant(repository: FakeGrantedRepository): void {
			grants ??= installation({ installationId: 1, account: options.owner, repositories: [] });
			grants.repositories.push(repository);
		},
		expireIssuedTokens(): void {
			for (const held of issuedTokens.values()) held.expired = true;
		}
	});
}

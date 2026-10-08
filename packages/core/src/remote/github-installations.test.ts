import { describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { createFakeGitHub, type FakeGitHub, type FakeGrants } from './fake-github.js';
import { readGrantedRepositories } from './github-installations.js';

const TOKEN = 'ghu_a-user-to-server-token';

const GRANTS: FakeGrants = {
	installationId: 42,
	account: 'ada',
	repositories: [
		{ owner: 'ada', repository: 'atlas', push: true, admin: true },
		{ owner: 'ada', repository: 'notes', push: false },
		{ owner: 'ada', repository: 'diary', push: true, private: true }
	]
};

const github = (grants: FakeGrants = GRANTS): Promise<FakeGitHub> =>
	createFakeGitHub({ owner: 'ada', repository: 'atlas', grants });

const read = (fetch: FetchFn) => readGrantedRepositories({ token: TOKEN, fetch });

const MANY: FakeGrants = {
	installationId: 42,
	account: 'ada',
	repositories: Array.from({ length: 250 }, (_, at) => ({
		owner: 'ada',
		repository: `sheet-${String(at).padStart(3, '0')}`,
		push: true
	}))
};

const requestsFor = async (remote: FakeGitHub): Promise<number> => {
	let requests = 0;
	await read((input, init) => {
		requests += 1;
		return remote.fetch(input, init);
	});
	return requests;
};

const failing =
	(status: number, message: string): FetchFn =>
	() =>
		Promise.resolve(new Response(JSON.stringify({ message }), { status }));

const listed = async (fetch: FetchFn) => {
	const outcome = await read(fetch);
	if (outcome.kind !== 'listed') throw new Error(`expected a listing, got ${outcome.refusal}`);
	return outcome.repositories;
};

describe('the repositories a signed-in author has granted the App', () => {
	it('reports each one with what may be done to it and whether it is private', async () => {
		const remote = await github();

		expect(await listed(remote.fetch)).toEqual([
			{
				owner: 'ada',
				repository: 'atlas',
				canPush: true,
				canGrantAccess: true,
				isPrivate: false
			},
			{
				owner: 'ada',
				repository: 'diary',
				canPush: true,
				canGrantAccess: false,
				isPrivate: true
			},
			{
				owner: 'ada',
				repository: 'notes',
				canPush: false,
				canGrantAccess: false,
				isPrivate: false
			}
		]);
	});

	it('sorts by owner and then by repository, so the order is not GitHub’s to change', async () => {
		const remote = await github({
			installationId: 7,
			account: 'ada',
			repositories: [
				{ owner: 'zoe', repository: 'atlas', push: true },
				{ owner: 'ada', repository: 'zebra', push: true },
				{ owner: 'ada', repository: 'atlas', push: true }
			]
		});

		expect((await listed(remote.fetch)).map((one) => `${one.owner}/${one.repository}`)).toEqual([
			'ada/atlas',
			'ada/zebra',
			'zoe/atlas'
		]);
	});

	it('follows the pages to the end of a listing that spans three of them', async () => {
		const repositories = await listed((await github(MANY)).fetch);
		expect(repositories).toHaveLength(250);
		expect(repositories.map((one) => one.repository).at(0)).toBe('sheet-000');
		expect(repositories.map((one) => one.repository).at(-1)).toBe('sheet-249');
	});

	it('reports an author who has granted nothing as an empty listing', async () => {
		const remote = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });

		expect(await read(remote.fetch)).toEqual({
			kind: 'listed',
			repositories: [],
			installations: []
		});
	});

	it('returns a repository granted after the first read', async () => {
		const remote = await github();

		remote.grant({ owner: 'ada', repository: 'harbour', push: true });

		expect((await listed(remote.fetch)).map((one) => one.repository)).toContain('harbour');
	});
});

describe('a sign-in GitHub will not accept', () => {
	it('is a refusal about the sign-in, and never an empty listing', async () => {
		const remote = await github();
		remote.rejectCredential = true;

		const outcome = await read(remote.fetch);
		expect(outcome).toMatchObject({ kind: 'refused', refusal: 'credential' });
		expect(outcome.kind).not.toBe('listed');
		if (outcome.kind === 'refused') expect(outcome.message).not.toBe('');
	});

	it('reports a 403 as being about the sign-in too', async () => {
		expect(await read(failing(403, 'Forbidden'))).toMatchObject({
			refusal: 'credential'
		});
	});
});

describe('GitHub not answering at all', () => {
	it('is a network refusal rather than an empty listing', async () => {
		const offline: FetchFn = () => Promise.reject(new TypeError('Failed to fetch'));
		const outcome = await read(offline);
		expect(outcome).toMatchObject({ kind: 'refused', refusal: 'network' });
		if (outcome.kind === 'refused') expect(outcome.message).toContain('Failed to fetch');
	});

	it('is a network refusal when GitHub answers with a failure of its own', async () => {
		expect(await read(failing(500, 'Server Error'))).toMatchObject({
			kind: 'refused',
			refusal: 'network'
		});
	});
});

describe('the installations the listing was read through', () => {
	it.each([
		[
			'the account, its identifier, whether it is an organisation, and its reach',
			{ installationId: 42, account: 'ada', targetId: 5150, repositorySelection: 'all' },
			{ id: 42, account: 'ada', targetId: 5150, isOrganization: false, coversEverything: true }
		],
		[
			'an installation on an organisation, granted narrowly, as both of those',
			{
				installationId: 9,
				account: 'harvard',
				targetId: 77,
				accountType: 'Organization',
				repositorySelection: 'selected'
			},
			{ id: 9, account: 'harvard', targetId: 77, isOrganization: true, coversEverything: false }
		]
	] as const)('reports %s', async (_, installation, reported) => {
		const remote = await github({
			...installation,
			repositories: [{ owner: installation.account, repository: 'atlas', push: true }]
		});

		expect(await read(remote.fetch)).toMatchObject({
			kind: 'listed',
			installations: [reported]
		});
	});

	it('reads them out of the two requests the listing already made, one per page and not one per repository', async () => {
		expect(await requestsFor(await github())).toBe(2);
		expect(await requestsFor(await github(MANY))).toBe(4);
	});
});

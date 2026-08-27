import { describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { createFakeGitHub, type FakeGitHub, type FakeGrants } from './fake-github.js';
import { readGrantedRepositories } from './github-installations.js';

// Seam 1, against the one fake GitHub this epic shares. What is asserted is the *answer* — which
// repositories, which of them may be published to, and whether a refusal is a refusal — rather than
// which requests were made: the failure this module exists to prevent is a rejected sign-in
// rendered as "you have no repositories", and no assertion on a call count can see it.

const TOKEN = 'ghu_a-user-to-server-token';

const GRANTS: FakeGrants = {
	installationId: 42,
	account: 'ada',
	repositories: [
		{ owner: 'ada', repository: 'atlas', push: true },
		{ owner: 'ada', repository: 'notes', push: false },
		{ owner: 'ada', repository: 'diary', push: true, private: true }
	]
};

const github = (grants: FakeGrants = GRANTS): Promise<FakeGitHub> =>
	createFakeGitHub({ owner: 'ada', repository: 'atlas', grants });

const listed = async (fetch: FetchFn) => {
	const outcome = await readGrantedRepositories({ token: TOKEN, fetch });
	if (outcome.kind !== 'listed') throw new Error(`expected a listing, got ${outcome.refusal}`);
	return outcome.repositories;
};

describe('the repositories a signed-in author has granted the App', () => {
	it('reports each one with whether it may be published to and whether it is private', async () => {
		const remote = await github();

		expect(await listed(remote.fetch)).toEqual([
			{ owner: 'ada', repository: 'atlas', canPublish: true, isPrivate: false },
			{ owner: 'ada', repository: 'diary', canPublish: true, isPrivate: true },
			{ owner: 'ada', repository: 'notes', canPublish: false, isPrivate: false }
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

	// A student with more than a hundred repositories must still see the one they want, so the read
	// is driven by `total_count` rather than by the first page.
	it('follows the pages to the end of a listing that spans three of them', async () => {
		const many = Array.from({ length: 250 }, (_, at) => ({
			owner: 'ada',
			repository: `sheet-${String(at).padStart(3, '0')}`,
			push: true
		}));
		const remote = await github({ installationId: 42, account: 'ada', repositories: many });

		const repositories = await listed(remote.fetch);

		expect(repositories).toHaveLength(250);
		expect(repositories.map((one) => one.repository).at(0)).toBe('sheet-000');
		expect(repositories.map((one) => one.repository).at(-1)).toBe('sheet-249');
	});

	it('reports an author who has granted nothing as an empty listing', async () => {
		const remote = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });

		expect(await readGrantedRepositories({ token: TOKEN, fetch: remote.fetch })).toEqual({
			kind: 'listed',
			repositories: []
		});
	});

	it('returns a repository granted after the first read', async () => {
		const remote = await github();

		remote.grant({ owner: 'ada', repository: 'harbour', push: true });

		expect((await listed(remote.fetch)).map((one) => one.repository)).toContain('harbour');
	});
});

/**
 * The single most important behaviour in this module.
 *
 * An expired or revoked sign-in rendered as "you have no repositories" sends a student off to create
 * a second repository they do not need, and then to wonder why it does not appear either. So the
 * assertion is not only that a refusal is reported, but that it is **not** an empty listing.
 */
describe('a sign-in GitHub will not accept', () => {
	it('is a refusal about the sign-in, and never an empty listing', async () => {
		const remote = await github();
		remote.rejectCredential = true;

		const outcome = await readGrantedRepositories({ token: TOKEN, fetch: remote.fetch });

		expect(outcome).toMatchObject({ kind: 'refused', refusal: 'credential' });
		expect(outcome.kind).not.toBe('listed');
		if (outcome.kind === 'refused') expect(outcome.message).not.toBe('');
	});

	it('reports a 403 as being about the sign-in too', async () => {
		const forbidden: FetchFn = () =>
			Promise.resolve(new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 }));

		expect(await readGrantedRepositories({ token: TOKEN, fetch: forbidden })).toMatchObject({
			refusal: 'credential'
		});
	});
});

describe('GitHub not answering at all', () => {
	it('is a network refusal rather than an empty listing', async () => {
		const offline: FetchFn = () => Promise.reject(new TypeError('Failed to fetch'));

		const outcome = await readGrantedRepositories({ token: TOKEN, fetch: offline });

		expect(outcome).toMatchObject({ kind: 'refused', refusal: 'network' });
		if (outcome.kind === 'refused') expect(outcome.message).toContain('Failed to fetch');
	});

	// A 500 is neither a judgement about the sign-in nor a listing: the answer is "try again", which
	// is what the network refusal says.
	it('is a network refusal when GitHub answers with a failure of its own', async () => {
		const broken: FetchFn = () =>
			Promise.resolve(new Response(JSON.stringify({ message: 'Server Error' }), { status: 500 }));

		expect(await readGrantedRepositories({ token: TOKEN, fetch: broken })).toMatchObject({
			kind: 'refused',
			refusal: 'network'
		});
	});
});

import { describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { createFakeGitHub } from './fake-github.js';
import {
	type AddressResolution,
	resolveWorkspaceAddress,
	workspaceAddressCandidates
} from './workspace-address.js';

const ON_REMOTE: Record<string, string> = {
	'index.html': '<!doctype html><title>Atlas</title>',
	'atlas/project.json': JSON.stringify({ formatVersion: 1, name: 'Atlas', layers: [] })
};

const PROSE: Record<string, string> = {
	'index.html': '<!doctype html><title>Ada</title>',
	'README.md': 'notes\n'
};

async function resolve(
	repository: string,
	pasted: string,
	tree?: Record<string, string>
): Promise<AddressResolution> {
	const github = await createFakeGitHub({ owner: 'ada', repository, ...(tree && { tree }) });
	return resolveWorkspaceAddress(pasted, github.fetch);
}

const refusal = (resolved: AddressResolution): string =>
	resolved.kind === 'refused' ? resolved.message : '';

const names = (pasted: string): string[] =>
	workspaceAddressCandidates(pasted).map((one) => `${one.owner}/${one.repository}`);

describe('which repositories an address could mean', () => {
	it.each([
		['ada/atlas', ['ada/atlas']],
		['github.com/ada/atlas', ['ada/atlas']],
		['https://github.com/ada/atlas', ['ada/atlas']],
		['https://www.github.com/ada/atlas/', ['ada/atlas']],
		['https://github.com/ada/atlas.git', ['ada/atlas']],
		['ada.github.io/atlas', ['ada/atlas', 'ada/ada.github.io']],
		['https://ada.github.io/atlas/', ['ada/atlas', 'ada/ada.github.io']],
		['ada.github.io', ['ada/ada.github.io']],
		['https://ada.github.io/', ['ada/ada.github.io']],
		['ada.github.io/atlas/atlas/index.html', ['ada/atlas', 'ada/ada.github.io']]
	])('%s means %s', (pasted, expected) => {
		expect(names(pasted)).toEqual(expected);
	});

	it('says why each candidate was derived', () => {
		const [project, userSite] = workspaceAddressCandidates('ada.github.io/atlas');

		expect(project?.why).toContain('ada/atlas');
		expect(userSite?.why).toContain('ada/ada.github.io');
	});

	it.each([
		'atlas.example.org',
		'https://atlas.example.org/maps',
		'https://maps.harvard.edu/atlas/',
		'github.com/ada',
		'github.com/ada/atlas/tree/main',
		'ada',
		'',
		'   ',
		'ada/..',
		'ada/.',
		'ada./atlas',
		'-ada/atlas',
		'ada/atlas?x=1'
	])('%s means no repository', (pasted) => {
		expect(names(pasted)).toEqual([]);
	});
});

describe('which of the candidates actually holds a Workspace', () => {
	it.each([
		[
			'the project site when that is where the Workspace is',
			'atlas',
			'ada.github.io/atlas',
			ON_REMOTE
		],
		[
			'the user site when the folder is inside it',
			'ada.github.io',
			'ada.github.io/atlas',
			ON_REMOTE
		],
		[
			'an address that names its repository outright',
			'atlas',
			'https://github.com/ada/atlas',
			ON_REMOTE
		],
		['a named repository that holds no Ballastella work at all', 'atlas', 'ada/atlas', PROSE],
		['a named repository with no commits in it', 'atlas', 'github.com/ada/atlas', undefined]
	])('resolves %s', async (_, repository, pasted, tree) => {
		expect(await resolve(repository, pasted, tree)).toMatchObject({
			kind: 'resolved',
			remote: { owner: 'ada', repository }
		});
	});

	it('refuses a named repository GitHub does not have', async () => {
		expect(refusal(await resolve('atlas', 'ada/notebook', ON_REMOTE))).toContain('ada/notebook');
	});

	it('passes over a repository that holds no Workspace', async () => {
		const resolved = await resolve('ada.github.io', 'ada.github.io/atlas', PROSE);
		expect(refusal(resolved)).toContain('ada/atlas');
		expect(refusal(resolved)).toContain('ada/ada.github.io');
	});

	it('refuses a custom domain by saying what to paste instead, asking GitHub nothing', async () => {
		const refuseEveryRequest: FetchFn = (url) => {
			throw new Error(`nothing should have been fetched, and ${String(url)} was`);
		};

		const resolved = await resolveWorkspaceAddress(
			'https://maps.example.org/atlas',
			refuseEveryRequest
		);

		expect(refusal(resolved)).toContain('owner/repository');
	});

	it('stops at the hourly limit rather than reporting a missing Workspace', async () => {
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas', tree: ON_REMOTE });
		github.rateLimit = { remaining: 0, reset: 0 };

		const resolved = await resolveWorkspaceAddress('ada.github.io/atlas', github.fetch);
		expect(refusal(resolved)).toContain('60 requests');
	});

	it('sends no credential', async () => {
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas', tree: ON_REMOTE });
		github.rejectCredential = true;

		const resolved = await resolveWorkspaceAddress('ada.github.io/atlas', github.fetch);

		expect(resolved).toMatchObject({
			kind: 'resolved',
			remote: { owner: 'ada', repository: 'atlas' }
		});
	});
});

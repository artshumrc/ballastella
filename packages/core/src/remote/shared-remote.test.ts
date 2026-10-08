import { describe, expect, it } from 'vitest';

import { createFakeGitHub } from './fake-github.js';
import { ATLAS as REMOTE, atlasWithReadme } from './remote-test-support.js';
import {
	describeOutboundRemovals,
	readRemoteSharing,
	type RemoteSharing
} from './shared-remote.js';

const TOKEN = 'github_pat_11ABCDE0000abcdefghij';
const github = atlasWithReadme;
const SOLO = { shared: false, known: true, owner: 'ada', others: [] };
const UNKNOWN = { shared: true, known: false, owner: 'ada', others: [] };

describe('whether a Remote is the signed-in author’s alone', () => {
	it.each([
		['is solo when the author owns it and nobody else has worked in it', {}, {}, SOLO],
		[
			'is shared when the repository is under somebody else’s account, and names them',
			{ login: 'grace' },
			{},
			{ shared: true, known: true, owner: 'ada', others: ['ada'] }
		],
		[
			'is shared when the author owns it and GitHub reports somebody else in it',
			{ contributors: ['ada', 'grace', 'grace'] },
			{},
			{ shared: true, known: true, owner: 'ada', others: ['grace'] }
		],
		[
			'takes the identity the caller already holds rather than asking again',
			{ login: 'somebody-else-entirely' },
			{ identity: 'ada' },
			SOLO
		],
		[
			'says shared, and not known, when the sign-in is one GitHub will not act on',
			{ rejectCredential: true },
			{},
			UNKNOWN
		],
		[
			'reads a repository with no commits as nobody else, not as unanswered',
			{ contributors: [] },
			{},
			SOLO
		]
	])('%s', async (_, fault, options, expected) => {
		const remote = await github();
		Object.assign(remote, fault);

		expect(
			await readRemoteSharing({ token: TOKEN, remote: REMOTE, fetch: remote.fetch, ...options })
		).toEqual(expected);
	});

	it('compares the accounts case-insensitively, as GitHub’s own comparison is', async () => {
		const remote = await createFakeGitHub({
			owner: 'Ada',
			repository: 'Atlas',
			tree: { 'README.md': '# Atlas\n' }
		});

		const sharing = await readRemoteSharing({
			token: TOKEN,
			remote: { owner: 'Ada', repository: 'Atlas' },
			identity: 'ada',
			fetch: remote.fetch
		});

		expect(sharing).toEqual({ shared: false, known: true, owner: 'Ada', others: [] });
	});

	it('says shared, and says it is not known, when GitHub could not be reached', async () => {
		const offline = () => Promise.reject(new TypeError('Failed to fetch'));

		expect(await readRemoteSharing({ token: TOKEN, remote: REMOTE, fetch: offline })).toEqual(
			UNKNOWN
		);
	});

	it('says shared, and not known, when the contributor read is refused', async () => {
		const remote = await github();
		const fetch = ((input, init) =>
			String(input).includes('/contributors')
				? Promise.resolve(new Response('{}', { status: 500 }))
				: remote.fetch(input, init)) satisfies typeof remote.fetch;

		const sharing = await readRemoteSharing({
			token: TOKEN,
			remote: REMOTE,
			identity: 'ada',
			fetch
		});

		expect(sharing).toEqual(UNKNOWN);
	});
});

describe('what a confirmed overwrite would take off a shared Remote', () => {
	const shared: RemoteSharing = { shared: true, known: true, owner: 'ada', others: ['grace'] };

	const preview = (
		removed: readonly string[],
		source: readonly string[],
		sharing: RemoteSharing = shared
	) => describeOutboundRemovals({ remote: REMOTE, sharing, removed, source });

	it('names a Project every one of whose files would go, rather than counting its files', () => {
		const answer = preview(
			[
				'florida-1657/project.json',
				'florida-1657/annotations/l1.geojson',
				'amsterdam-1625/annotations/l9.geojson'
			],
			['amsterdam-1625/project.json', 'amsterdam-1625/annotations/l2.geojson']
		);

		expect(answer.projects).toEqual(['florida-1657']);
		expect(answer.message).toContain('the Project florida-1657');
		expect(answer.remaining).toEqual(['amsterdam-1625/annotations/l9.geojson']);
		expect(answer.message).toContain('amsterdam-1625/annotations/l9.geojson');
	});

	it('names a Map Image and takes its Alignment with it', () => {
		const answer = preview(
			[
				'images/plan-of-boston/info.json',
				'images/plan-of-boston/0/0_0.jpg',
				'alignments/plan-of-boston.json'
			],
			['amsterdam-1625/project.json']
		);

		expect(answer.mapImages).toEqual(['plan-of-boston']);
		expect(answer.remaining).toEqual([]);
		expect(answer.message).toContain('the Map Image plan-of-boston');
	});

	it('does not claim a Project is going while this Workspace still holds part of it', () => {
		const answer = preview(
			['amsterdam-1625/annotations/l9.geojson'],
			['amsterdam-1625/project.json']
		);

		expect(answer.projects).toEqual([]);
		expect(answer.remaining).toEqual(['amsterdam-1625/annotations/l9.geojson']);
	});

	it.each([
		[
			'names whose the repository is when its owner is not the author',
			{ shared: true, known: true, owner: 'grace', others: ['grace'] },
			'ada/atlas belongs to grace, not to you'
		],
		[
			'names the collaborators when the author owns it and somebody else has worked in it',
			shared,
			'grace has worked in ada/atlas as well as you'
		],
		[
			'says the question could not be answered rather than naming anybody',
			UNKNOWN,
			'could not establish whether anybody else works in ada/atlas'
		]
	])('%s', (_, sharing, said) => {
		expect(preview(['florida-1657/project.json'], [], sharing).message).toContain(said);
	});

	it('says what it does when it would remove nothing at all', () => {
		const answer = preview([], ['amsterdam-1625/project.json']);
		expect(answer.paths).toEqual([]);
		expect(answer.message).toContain('takes nothing off ada/atlas');
		expect(answer.message).toContain('whatever anybody else put in those is lost');
	});

	it('sorts the paths and never says a count where a name will do', () => {
		const answer = preview(
			['b/project.json', 'a/project.json', 'a/project.json'],
			['kept/project.json']
		);

		expect(answer.paths).toEqual(['a/project.json', 'b/project.json']);
		expect(answer.projects).toEqual(['a', 'b']);
		expect(answer.message).toContain('the Project a and the Project b');
	});
});

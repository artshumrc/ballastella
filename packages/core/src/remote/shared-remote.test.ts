import { describe, expect, it } from 'vitest';

import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import {
	describeOutboundRemovals,
	readRemoteSharing,
	type RemoteSharing
} from './shared-remote.js';
import type { RemoteReference } from './bind-remote.js';

// Seam 1 for a Remote that may be somebody else's (ADR-0044): the determination against the shared
// fake GitHub, and the sentence an overwrite has to be confirmed through.
//
// ⚠ **What this suite cannot settle, and does not claim to**: that a write collaborator's own
// listing surfaces an Installation owned by another account. That is an inference from GitHub's
// documented enumeration rather than a documented sentence, and a fake built from the same inference
// would be agreeing with itself. It is verified once against two real accounts and recorded outside
// the tree.

const REMOTE: RemoteReference = { owner: 'ada', repository: 'atlas', branch: 'main' };
const TOKEN = 'github_pat_11ABCDE0000abcdefghij';

const github = (): Promise<FakeGitHub> =>
	createFakeGitHub({
		owner: REMOTE.owner,
		repository: REMOTE.repository,
		tree: { 'README.md': '# Atlas\n' }
	});

describe('whether a Remote is the signed-in author’s alone', () => {
	it('is solo when the author owns it and nobody else has worked in it', async () => {
		const remote = await github();

		expect(await readRemoteSharing({ token: TOKEN, remote: REMOTE, fetch: remote.fetch })).toEqual({
			shared: false,
			known: true,
			owner: 'ada',
			others: []
		});
	});

	// The owner is read from the binding and the author from the credential, so this costs no request
	// at all — and it is the commonest shared Remote there is: a departmental repository, or a
	// colleague's that the author was given write access to.
	it('is shared when the repository is under somebody else’s account, and names them', async () => {
		const remote = await github();
		remote.login = 'grace';

		expect(await readRemoteSharing({ token: TOKEN, remote: REMOTE, fetch: remote.fetch })).toEqual({
			shared: true,
			known: true,
			owner: 'ada',
			others: ['ada']
		});
	});

	it('is shared when the author owns it and GitHub reports somebody else in it', async () => {
		const remote = await github();
		remote.contributors = ['ada', 'grace', 'grace'];

		expect(await readRemoteSharing({ token: TOKEN, remote: REMOTE, fetch: remote.fetch })).toEqual({
			shared: true,
			known: true,
			owner: 'ada',
			others: ['grace']
		});
	});

	it('takes the identity the caller already holds rather than asking again', async () => {
		const remote = await github();
		remote.login = 'somebody-else-entirely';

		const sharing = await readRemoteSharing({
			token: TOKEN,
			remote: REMOTE,
			identity: 'ada',
			fetch: remote.fetch
		});

		expect(sharing).toEqual({ shared: false, known: true, owner: 'ada', others: [] });
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

	// ⚠ The one behaviour everything else here is arranged around. A solo Remote read as shared costs
	// one confirmation nobody needed; a shared Remote read as solo deletes a colleague's work with
	// nothing said, so an unanswered question is `shared` and says so.
	it('says shared, and says it is not known, when GitHub could not be reached', async () => {
		const offline = () => Promise.reject(new TypeError('Failed to fetch'));

		expect(await readRemoteSharing({ token: TOKEN, remote: REMOTE, fetch: offline })).toEqual({
			shared: true,
			known: false,
			owner: 'ada',
			others: []
		});
	});

	it('says shared, and not known, when the sign-in is one GitHub will not act on', async () => {
		const remote = await github();
		remote.rejectCredential = true;

		const sharing = await readRemoteSharing({ token: TOKEN, remote: REMOTE, fetch: remote.fetch });

		expect(sharing).toEqual({ shared: true, known: false, owner: 'ada', others: [] });
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

		expect(sharing).toEqual({ shared: true, known: false, owner: 'ada', others: [] });
	});

	// A repository with no commits at all: GitHub answers 204, which is *nobody* rather than a
	// question it would not answer. Read as unanswered it would make the first send of every
	// brand-new repository ask a confirmation about a colleague who does not exist.
	it('reads a repository with no commits as nobody else, not as unanswered', async () => {
		const remote = await github();
		remote.contributors = [];

		expect(await readRemoteSharing({ token: TOKEN, remote: REMOTE, fetch: remote.fetch })).toEqual({
			shared: false,
			known: true,
			owner: 'ada',
			others: []
		});
	});
});

describe('what a confirmed overwrite would take off a shared Remote', () => {
	const shared: RemoteSharing = {
		shared: true,
		known: true,
		owner: 'ada',
		others: ['grace']
	};

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
		// A Project losing one Annotation is not a Project going, so it is the rest of the deletion
		// rather than a second telling of it.
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

	// The mirror of the inbound preview's rule, and the reason the local side is what decides: a
	// directory this Workspace still holds something under is a directory the Remote keeps a Project
	// in, so what goes is files rather than the Project.
	it('does not claim a Project is going while this Workspace still holds part of it', () => {
		const answer = preview(
			['amsterdam-1625/annotations/l9.geojson'],
			['amsterdam-1625/project.json']
		);

		expect(answer.projects).toEqual([]);
		expect(answer.remaining).toEqual(['amsterdam-1625/annotations/l9.geojson']);
	});

	it('names whose the repository is when its owner is not the author', () => {
		const answer = preview(['florida-1657/project.json'], [], {
			shared: true,
			known: true,
			owner: 'grace',
			others: ['grace']
		});

		expect(answer.message).toContain('ada/atlas belongs to grace, not to you');
	});

	it('names the collaborators when the author owns it and somebody else has worked in it', () => {
		const answer = preview(['florida-1657/project.json'], []);

		expect(answer.message).toContain('grace has worked in ada/atlas as well as you');
	});

	it('says the question could not be answered rather than naming anybody', () => {
		const answer = preview(['florida-1657/project.json'], [], {
			shared: true,
			known: false,
			owner: 'ada',
			others: []
		});

		expect(answer.message).toContain('could not establish whether anybody else works in ada/atlas');
	});

	// An overwrite with nothing to remove still replaces the files the refusal named, so
	// the confirmation is still owed one — and it must not claim files are going when none are.
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

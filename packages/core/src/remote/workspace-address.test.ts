// Seam 1 for the address a student pastes: which repositories it could mean, and which of them
// actually holds a Workspace.
//
// The candidates are a pure reading of the address and are asserted as a table. The probe is
// asserted against the shared fake GitHub, which serves one repository — so a fake for `ada/atlas`
// and a fake for `ada/ada.github.io` are the two orderings of the ambiguous address, and each one's
// answer has to be the repository that exists rather than the candidate that came first.

import { describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { createFakeGitHub } from './fake-github.js';
import { resolveWorkspaceAddress, workspaceAddressCandidates } from './workspace-address.js';

/** A published Workspace, cut down to the one thing that makes it recognisable as one. */
const PUBLISHED: Record<string, string> = {
	'index.html': '<!doctype html><title>Atlas</title>',
	'atlas/project.json': JSON.stringify({ formatVersion: 1, name: 'Atlas', layers: [] })
};

/** A repository that is somebody's own site and holds no Ballastella Workspace at all. */
const PROSE: Record<string, string> = {
	'index.html': '<!doctype html><title>Ada</title>',
	'README.md': 'notes\n'
};

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
		['https://ada.github.io/', ['ada/ada.github.io']]
	])('%s means %s', (pasted, expected) => {
		expect(names(pasted)).toEqual(expected);
	});

	// ⚠ **The subpath candidate comes first and the user site second**, because `ada.github.io/atlas`
	// is far more often a project site than a folder inside somebody's own site repository — and the
	// order is what decides which of two real repositories a student opens.
	it('offers the project site before the folder inside the user site', () => {
		expect(names('ada.github.io/atlas')).toEqual(['ada/atlas', 'ada/ada.github.io']);
	});

	// The address of a page *inside* a published site is the likeliest thing to be copied out of an
	// address bar, and its first segment is the same repository.
	it('reads the first segment of a deeper published address', () => {
		expect(names('ada.github.io/atlas/atlas/index.html')).toEqual([
			'ada/atlas',
			'ada/ada.github.io'
		]);
	});

	it('says why each candidate was derived', () => {
		const [project, userSite] = workspaceAddressCandidates('ada.github.io/atlas');

		expect(project?.why).toContain('ada/atlas');
		expect(userSite?.why).toContain('ada/ada.github.io');
	});

	// ⚠ **A custom domain produces nothing at all.** GitHub Pages serves a repository at an address
	// of the author's choosing and says nowhere which repository it was, so there is no candidate to
	// probe — only a sentence saying what to paste instead.
	it.each([
		'atlas.example.org',
		'https://atlas.example.org/maps',
		'https://maps.harvard.edu/atlas/',
		'github.com/ada',
		'github.com/ada/atlas/tree/main',
		'ada',
		'',
		'   '
	])('%s means no repository', (pasted) => {
		expect(names(pasted)).toEqual([]);
	});

	// The two path segments go straight into a URL, and `.` and `..` are the two that are not names.
	it.each(['ada/..', 'ada/.', 'ada./atlas', '-ada/atlas', 'ada/atlas?x=1'])(
		'refuses %s, which is not a repository',
		(pasted) => {
			expect(names(pasted)).toEqual([]);
		}
	);
});

describe('which of the candidates actually holds a Workspace', () => {
	it('resolves the project site when that is where the Workspace is', async () => {
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas', tree: PUBLISHED });

		const resolved = await resolveWorkspaceAddress('ada.github.io/atlas', github.fetch);

		expect(resolved).toMatchObject({
			kind: 'resolved',
			remote: { owner: 'ada', repository: 'atlas' }
		});
	});

	// The other real layout: the Workspace is published at the root of `ada`'s own site repository,
	// and `atlas` is a folder inside it — a Project, which is what the viewer serves at that address.
	it('resolves the user site when the folder is inside it', async () => {
		const github = await createFakeGitHub({
			owner: 'ada',
			repository: 'ada.github.io',
			tree: PUBLISHED
		});

		const resolved = await resolveWorkspaceAddress('ada.github.io/atlas', github.fetch);

		expect(resolved).toMatchObject({
			kind: 'resolved',
			remote: { owner: 'ada', repository: 'ada.github.io' }
		});
	});

	it('resolves an address that names its repository outright', async () => {
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas', tree: PUBLISHED });

		const resolved = await resolveWorkspaceAddress('https://github.com/ada/atlas', github.fetch);

		expect(resolved).toMatchObject({
			kind: 'resolved',
			remote: { owner: 'ada', repository: 'atlas' }
		});
	});

	// ⚠ **A repository that is there and holds no Workspace is not the answer.** Somebody's own
	// `ada.github.io` full of prose would otherwise be offered as the thing to download.
	it('passes over a repository that holds no Workspace', async () => {
		const github = await createFakeGitHub({
			owner: 'ada',
			repository: 'ada.github.io',
			tree: PROSE
		});

		const resolved = await resolveWorkspaceAddress('ada.github.io/atlas', github.fetch);

		expect(resolved.kind).toBe('refused');
		expect(resolved.kind === 'refused' && resolved.message).toContain('ada/atlas');
		expect(resolved.kind === 'refused' && resolved.message).toContain('ada/ada.github.io');
	});

	// ⚠ **Nothing is asked of GitHub at all**: there is no candidate to ask about, and a request
	// spent here would come out of the sixty an anonymous reader gets an hour.
	it('refuses a custom domain by saying what to paste instead, asking GitHub nothing', async () => {
		const refuseEveryRequest: FetchFn = (url) => {
			throw new Error(`nothing should have been fetched, and ${String(url)} was`);
		};

		const resolved = await resolveWorkspaceAddress(
			'https://maps.example.org/atlas',
			refuseEveryRequest
		);

		expect(resolved.kind).toBe('refused');
		expect(resolved.kind === 'refused' && resolved.message).toContain('owner/repository');
	});

	// The hourly limit belongs to the internet connection rather than to the reader, so it stops the
	// probe rather than being read as "that repository is not the one".
	it('stops at the hourly limit rather than reporting a missing Workspace', async () => {
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas', tree: PUBLISHED });
		github.rateLimit = { remaining: 0, reset: 0 };

		const resolved = await resolveWorkspaceAddress('ada.github.io/atlas', github.fetch);

		expect(resolved.kind).toBe('refused');
		expect(resolved.kind === 'refused' && resolved.message).toContain('60 requests');
	});

	// ⚠ **Nothing on this path may carry a credential**: opening somebody's published Workspace is
	// what a student with no account does (ADR-0031). Asserted against a GitHub that refuses any
	// request carrying one, which is the only way a credential sent silently would show up at all.
	it('sends no credential', async () => {
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas', tree: PUBLISHED });
		github.rejectCredential = true;

		const resolved = await resolveWorkspaceAddress('ada.github.io/atlas', github.fetch);

		expect(resolved).toMatchObject({
			kind: 'resolved',
			remote: { owner: 'ada', repository: 'atlas' }
		});
	});
});

import { describe, expect, it } from 'vitest';

import { parsePublishedSite, readReturnLink, returnLinkUrl, withoutReturnLink } from '../index.js';

// SPEC's Seam 1 for "The Front Page's return links". One module holds both halves — the address a
// Published Site puts in an `href` and the parameters the editor reads back off its own URL — so the
// two cannot come to disagree about what a link is called, which is the failure a second reader
// would produce silently.

const INSTANCE = 'https://maps.example.edu/ballastella/';

describe('the link a Published Site sends a Reader back with', () => {
	it('addresses the publishing instance with the whole Workspace to clone', () => {
		expect(returnLinkUrl(INSTANCE, { kind: 'clone', owner: 'ada', repository: 'atlas' })).toBe(
			'https://maps.example.edu/ballastella/?clone=ada/atlas'
		);
	});

	it('addresses it with one Project to review', () => {
		expect(
			returnLinkUrl(INSTANCE, {
				kind: 'review',
				owner: 'ada',
				repository: 'atlas',
				project: 'amsterdam-1625'
			})
		).toBe('https://maps.example.edu/ballastella/?review=ada/atlas&p=amsterdam-1625');
	});

	/**
	 * A site whose record says nothing about an instance carries no link (ADR-0032, story 51).
	 *
	 * The alternative — guessing at a canonical deployment — would send a Reader to a stranger's
	 * editor, offering to clone a repository into somebody else's tool.
	 */
	it('is nothing at all when the site does not say which instance published it', () => {
		expect(returnLinkUrl('', { kind: 'clone', owner: 'ada', repository: 'atlas' })).toBeNull();
	});

	it('is nothing at all when the recorded instance is not an address', () => {
		expect(
			returnLinkUrl('not an address', { kind: 'clone', owner: 'ada', repository: 'atlas' })
		).toBeNull();
	});

	it('percent-encodes a Project directory rather than letting it write its own parameters', () => {
		expect(
			returnLinkUrl(INSTANCE, {
				kind: 'review',
				owner: 'ada',
				repository: 'atlas',
				project: 'a&clone=someone/else'
			})
		).toBe('https://maps.example.edu/ballastella/?review=ada/atlas&p=a%26clone%3Dsomeone%2Felse');
	});
});

/**
 * The record's own coordinates, read back and turned into the two shipped invitation URLs.
 *
 * ⚠ **The shapes are the shipped ones**, `?clone=owner/repository` and
 * `?review=owner/repository&p=directory` (SPEC story 165). Sites carrying those links are in front
 * of Readers now and the editor's parser reads exactly these two parameters, so where the
 * coordinates come from may change and the address may not.
 */
describe('a site record naming its own repository', () => {
	const record = (fields: Record<string, unknown>) =>
		parsePublishedSite(new TextEncoder().encode(JSON.stringify({ projects: [], ...fields })));

	it('builds both invitation URLs from the repository it recorded', () => {
		const site = record({
			editorUrl: INSTANCE,
			repository: { owner: 'ada', repository: 'atlas', branch: 'main' }
		});

		expect([
			returnLinkUrl(site.editorUrl, { kind: 'clone', ...site.repository! }),
			returnLinkUrl(site.editorUrl, {
				kind: 'review',
				...site.repository!,
				project: 'amsterdam-1625'
			})
		]).toEqual([
			'https://maps.example.edu/ballastella/?clone=ada/atlas',
			'https://maps.example.edu/ballastella/?review=ada/atlas&p=amsterdam-1625'
		]);
	});

	// Every site published before the field existed. Those sites carry the repository in `remote.json`
	// inside the published tree, which the viewer still reads — so the tolerant answer here is
	// "no repository on the record", never a refusal to read the record at all.
	it('reads a record written before the field existed as naming no repository', () => {
		expect(record({ editorUrl: INSTANCE }).repository).toBeNull();
	});

	// A record is a file on a host somebody else may control, and both halves are interpolated into a
	// GitHub API path. `ada/../../orgs` would retarget every request the Open engine makes.
	it.each([
		[{ owner: 'ada/../../orgs', repository: 'atlas' }],
		[{ owner: 'ada', repository: '..' }],
		[{ owner: 'ada', repository: 'atlas?x=1' }],
		[{ owner: '', repository: 'atlas' }],
		[{ owner: 'ada' }],
		['ada/atlas']
	])('refuses %j, which is not a repository this build may address', (repository) => {
		expect(record({ editorUrl: INSTANCE, repository }).repository).toBeNull();
	});

	it('normalises a record that names no branch to the branch a publish writes to', () => {
		expect(
			record({ editorUrl: INSTANCE, repository: { owner: 'ada', repository: 'atlas' } }).repository
		).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
	});
});

describe('the link an editor is landed on', () => {
	const read = (query: string) => readReturnLink(new URL(`https://x.test/${query}`).searchParams);

	it('offers to clone the whole Workspace', () => {
		expect(read('?clone=ada/atlas')).toEqual({
			kind: 'clone',
			owner: 'ada',
			repository: 'atlas'
		});
	});

	it('offers to review the one Project ?p= names', () => {
		expect(read('?review=ada/atlas&p=amsterdam-1625')).toEqual({
			kind: 'review',
			owner: 'ada',
			repository: 'atlas',
			project: 'amsterdam-1625'
		});
	});

	// The ordinary case, and the one that must cost nothing: every editor URL that is not a return
	// link — the hub, a Project, a sign-in callback — passes through here.
	it.each([['?'], ['?p=amsterdam-1625'], ['?code=abc&state=def']])(
		'is nothing at all for %s, which is not a return link',
		(query) => {
			expect(read(query)).toBeNull();
		}
	);

	// A Review is *of a Project*, and the whole repository is what the other parameter is for. Without
	// `?p=` there is nothing to offer, and quietly turning it into a Clone would take a Reader who
	// asked to look at one piece of work and hand them everything.
	it('offers nothing for a review that names no Project', () => {
		expect(read('?review=ada/atlas')).toBeNull();
	});

	/**
	 * ⚠ **A link is a thing anyone can send.** Both fields are interpolated into a GitHub API path by
	 * the Clone and Review engines, where an owner of `ada/../../orgs` retargets every request they
	 * make — the trap `parseRemoteBinding` records, and the reason the same checked reader is used
	 * here rather than a split on `/`.
	 */
	it.each([['ada/../../orgs'], ['ada'], ['ada/atlas/tree/main'], ['/atlas'], ['ada atlas']])(
		'offers nothing for %s, which is not a repository',
		(reference) => {
			expect(read(`?clone=${encodeURIComponent(reference)}`)).toBeNull();
		}
	);

	// A URL carrying both is one nobody writes: they are two different invitations, and this says
	// which one arrives rather than leaving it to parameter order.
	it('takes the Clone when a link somehow carries both', () => {
		expect(read('?clone=ada/atlas&review=ada/atlas&p=amsterdam-1625')).toEqual({
			kind: 'clone',
			owner: 'ada',
			repository: 'atlas'
		});
	});

	it('reads back exactly what a Published Site wrote', () => {
		const link = {
			kind: 'review',
			owner: 'ada',
			repository: 'atlas',
			project: 'a&clone=someone/else'
		} as const;

		const url = returnLinkUrl(INSTANCE, link);

		expect(readReturnLink(new URL(url ?? '').searchParams)).toEqual(link);
	});
});

describe('the address the editor is left on', () => {
	const strip = (query: string) =>
		withoutReturnLink(new URL(`https://x.test/${query}`).searchParams);

	// A reload must not offer again, which is the whole reason this exists.
	it('is this app’s own root when the link carried nothing else', () => {
		expect(strip('?clone=ada/atlas')).toBe('');
	});

	// ⚠ `?p=` is the review link's own Project and keeps its ordinary meaning (ADR-0008): it is what
	// the editor is showing, and it is what the review copy will hold.
	it('keeps the Project the review link named', () => {
		expect(strip('?review=ada/atlas&p=amsterdam-1625')).toBe('?p=amsterdam-1625');
	});

	it('keeps every other parameter, rather than rebuilding the address from ?p= alone', () => {
		expect(strip('?clone=ada/atlas&p=amsterdam-1625&unwarped=l2')).toBe(
			'?p=amsterdam-1625&unwarped=l2'
		);
	});

	it('leaves an address that carries no invitation alone', () => {
		expect(strip('?p=amsterdam-1625')).toBe('?p=amsterdam-1625');
	});
});

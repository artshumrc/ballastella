import { describe, expect, it } from 'vitest';

import { parsePublishedSite, readReturnLink, returnLinkUrl, withoutReturnLink } from '../index.js';

const INSTANCE = 'https://maps.example.edu/ballastella/';
const CLONE = { kind: 'clone', owner: 'ada', repository: 'atlas' } as const;
const review = (project: string) => ({ ...CLONE, kind: 'review', project }) as const;

describe('the link a Published Site sends a Reader back with', () => {
	it('addresses the recorded instance with the whole Workspace to clone', () => {
		expect(returnLinkUrl(INSTANCE, CLONE)).toBe(
			'https://maps.example.edu/ballastella/?clone=ada/atlas'
		);
	});

	it('addresses it with one Project to review', () => {
		expect(returnLinkUrl(INSTANCE, review('amsterdam-1625'))).toBe(
			'https://maps.example.edu/ballastella/?review=ada/atlas&p=amsterdam-1625'
		);
	});

	it('is nothing at all when the site does not say which instance wrote it', () => {
		expect(returnLinkUrl('', CLONE)).toBeNull();
	});

	it('is nothing at all when the recorded instance is not an address', () => {
		expect(returnLinkUrl('not an address', CLONE)).toBeNull();
	});

	it('percent-encodes a Project directory rather than letting it write its own parameters', () => {
		expect(returnLinkUrl(INSTANCE, review('a&clone=someone/else'))).toBe(
			'https://maps.example.edu/ballastella/?review=ada/atlas&p=a%26clone%3Dsomeone%2Felse'
		);
	});
});

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

	it('reads a record written before the field existed as naming no repository', () => {
		expect(record({ editorUrl: INSTANCE }).repository).toBeNull();
	});

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

	it('normalises a record that names no branch to the branch a send writes to', () => {
		expect(
			record({ editorUrl: INSTANCE, repository: { owner: 'ada', repository: 'atlas' } }).repository
		).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
	});
});

describe('the link an editor is landed on', () => {
	const read = (query: string) => readReturnLink(new URL(`https://x.test/${query}`).searchParams);

	it('offers to clone the whole Workspace', () => {
		expect(read('?clone=ada/atlas')).toEqual(CLONE);
	});

	it('offers to review the one Project ?p= names', () => {
		expect(read('?review=ada/atlas&p=amsterdam-1625')).toEqual(review('amsterdam-1625'));
	});

	it.each([['?'], ['?p=amsterdam-1625'], ['?code=abc&state=def']])(
		'is nothing at all for %s, which is not a return link',
		(query) => {
			expect(read(query)).toBeNull();
		}
	);

	it('offers nothing for a review that names no Project', () => {
		expect(read('?review=ada/atlas')).toBeNull();
	});

	it.each([['ada/../../orgs'], ['ada'], ['ada/atlas/tree/main'], ['/atlas'], ['ada atlas']])(
		'offers nothing for %s, which is not a repository',
		(reference) => {
			expect(read(`?clone=${encodeURIComponent(reference)}`)).toBeNull();
		}
	);

	it('takes the whole-repository invitation when a link somehow carries both', () => {
		expect(read('?clone=ada/atlas&review=ada/atlas&p=amsterdam-1625')).toEqual(CLONE);
	});

	it('reads back exactly what a Published Site wrote', () => {
		const link = review('a&clone=someone/else');
		const url = returnLinkUrl(INSTANCE, link);
		expect(readReturnLink(new URL(url ?? '').searchParams)).toEqual(link);
	});
});

describe('the address the editor is left on', () => {
	const strip = (query: string) =>
		withoutReturnLink(new URL(`https://x.test/${query}`).searchParams);

	it('is this app’s own root when the link carried nothing else', () => {
		expect(strip('?clone=ada/atlas')).toBe('');
	});

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

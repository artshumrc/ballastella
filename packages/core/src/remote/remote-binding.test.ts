import { describe, expect, it } from 'vitest';

import {
	DEFAULT_REMOTE_BRANCH,
	describeRemote,
	isOwnerName,
	isRepositoryName,
	normaliseRemoteIdentity,
	parseRemoteReference
} from './remote-binding.js';

describe('a record this build cannot act on names no repository', () => {
	const refused = (record: Record<string, unknown>) =>
		expect(normaliseRemoteIdentity(record)).toBeNull();

	it('names no owner', () => refused({ repository: 'atlas' }));
	it('names no repository', () => refused({ owner: 'ada' }));
	it('names an empty owner', () => refused({ owner: '  ', repository: 'atlas' }));
	it('names neither as a string', () => refused({ owner: 7, repository: ['atlas'] }));

	it('names an owner that would climb out of the repository path', () =>
		refused({ owner: 'ada/../../orgs', repository: 'atlas' }));

	it('names a repository carrying a query of its own', () =>
		refused({ owner: 'ada', repository: 'atlas?x=1' }));

	it('names a repository on another host entirely', () =>
		refused({ owner: 'ada', repository: 'https://evil.invalid/x' }));

	it('names an owner with a dot in it, which GitHub does not allow', () =>
		refused({ owner: 'ada.lovelace', repository: 'atlas' }));

	it('names a repository that is the current directory', () =>
		refused({ owner: 'ada', repository: '.' }));

	it('names a repository that is the parent directory', () =>
		refused({ owner: 'ada', repository: '..' }));

	it('keeps a repository whose name has a dot in it', () => {
		expect(isRepositoryName('.github')).toBe(true);
		expect(isRepositoryName('foo.js')).toBe(true);
		expect(isOwnerName('ada-lovelace')).toBe(true);
	});
});

describe('a record from a build that knew more than this one', () => {
	it('keeps its owner and repository rather than being refused (ADR-0010’s tolerance)', () => {
		expect(
			normaliseRemoteIdentity({
				owner: 'ada',
				repository: 'atlas',
				branch: 'main',
				host: 'gitea'
			} as Record<string, unknown>)
		).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
	});

	it('names no branch, and therefore names the branch Ballastella synchronizes with', () => {
		expect(normaliseRemoteIdentity({ owner: 'ada', repository: 'atlas' })).toHaveProperty(
			'branch',
			DEFAULT_REMOTE_BRANCH
		);
	});
});

describe('what a scholar pastes as a repository address', () => {
	it('takes the short form GitHub itself uses', () => {
		expect(parseRemoteReference('ada/atlas')).toEqual({ owner: 'ada', repository: 'atlas' });
	});

	it('takes the whole URL, because that is what is in the browser’s address bar', () => {
		expect(parseRemoteReference('https://github.com/ada/atlas')).toEqual({
			owner: 'ada',
			repository: 'atlas'
		});
	});

	it('takes a clone URL, trailing slash and .git and all', () => {
		expect(parseRemoteReference('https://github.com/ada/atlas.git/')).toEqual({
			owner: 'ada',
			repository: 'atlas'
		});
	});

	it('keeps dots and dashes in a repository name', () => {
		expect(parseRemoteReference('ada-lovelace/atlas.github.io')).toEqual({
			owner: 'ada-lovelace',
			repository: 'atlas.github.io'
		});
	});

	it('refuses a URL that names something inside a repository', () => {
		expect(parseRemoteReference('https://github.com/ada/atlas/tree/main/docs')).toBeNull();
	});

	it('refuses the two path segments that are not repository names', () => {
		expect(parseRemoteReference('ada/..')).toBeNull();
		expect(parseRemoteReference('ada/.')).toBeNull();
		expect(parseRemoteReference('https://github.com/ada/..')).toBeNull();
		expect(parseRemoteReference('ada/.github')).toEqual({ owner: 'ada', repository: '.github' });
	});

	it('refuses a name on its own, an empty paste, and a space', () => {
		expect(parseRemoteReference('atlas')).toBeNull();
		expect(parseRemoteReference('')).toBeNull();
		expect(parseRemoteReference('ada / atlas')).toBeNull();
	});

	it('names a Remote the way GitHub does', () => {
		expect(describeRemote({ owner: 'ada', repository: 'atlas' })).toBe('ada/atlas');
	});
});

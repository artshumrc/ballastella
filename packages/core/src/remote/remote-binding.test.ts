import { describe, expect, it } from 'vitest';

import {
	DEFAULT_REMOTE_BRANCH,
	describeRemote,
	isOwnerName,
	isRepositoryName,
	normaliseRemoteIdentity,
	parseRemoteReference
} from './remote-binding.js';

// ⚠ **The one reader every persisted repository identity goes through**, and the *less* trusted of
// the two: what arrives here is a record read back out of storage — an installation-local
// relationship, a Baseline offered as evidence, a Published Site's own record — and both fields are
// interpolated straight into the API path the synchronization engine builds. `encodeURIComponent` at
// the interpolation is not the fix: it leaves `.` alone, so `..` survives it and `fetch` normalises
// the traversal away. So a hostile record is *no repository at all*.
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

	// ⚠ **The two path segments that are not names.** Both match the character set a repository is
	// allowed — letters, digits and `-_.` — and both are interpolated straight into a URL: `ada/..`
	// normalises to `api.github.com/repos/ada`, which is an endpoint about a *user*, and on the raw
	// host it climbs out of the repository altogether.
	it('names a repository that is the current directory', () =>
		refused({ owner: 'ada', repository: '.' }));

	it('names a repository that is the parent directory', () =>
		refused({ owner: 'ada', repository: '..' }));

	// The dot is refused as a whole segment and nowhere else: real repositories are called `.github`
	// and `foo.js`, and banning the character would refuse them.
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

	// Refused rather than truncated to its first two segments: a URL naming a file inside a
	// repository is not a repository, and binding to "whatever the first two segments were" is
	// binding a Workspace to something the user did not name.
	it('refuses a URL that names something inside a repository', () => {
		expect(parseRemoteReference('https://github.com/ada/atlas/tree/main/docs')).toBeNull();
	});

	// ⚠ Both match the character set GitHub allows and neither names a repository: typed into the
	// inbound form, `ada/..` builds a tree URL that normalises to an endpoint about the *user* `ada`,
	// and the refusal the user then reads is about the wrong thing entirely. Refused as the two exact
	// strings rather than by banning the dot, because `.github` and `foo.js` are real repositories —
	// see the test above that keeps them.
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

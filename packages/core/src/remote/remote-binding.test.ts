import { describe, expect, it } from 'vitest';

import {
	REVIEW_MARK_FORMAT_VERSION,
	REVIEW_MARK_PATH,
	ReviewWorkspaceError,
	serialiseReviewMark
} from '../project/review-workspace.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import {
	DEFAULT_REMOTE_BRANCH,
	REMOTE_BINDING_FORMAT_VERSION,
	REMOTE_BINDING_PATH,
	clearRemoteBinding,
	describeRemote,
	parseRemoteBinding,
	parseRemoteReference,
	readRemoteBinding,
	serialiseRemoteBinding,
	writeRemoteBinding,
	type RemoteBinding
} from './remote-binding.js';

const encode = (text: string): Bytes => new TextEncoder().encode(text);

const BINDING: RemoteBinding = {
	formatVersion: REMOTE_BINDING_FORMAT_VERSION,
	owner: 'ada',
	repository: 'atlas',
	branch: DEFAULT_REMOTE_BRANCH
};

/** A Workspace that is a review copy of somebody else's Project (ADR-0024). */
const reviewCopy = (): MemoryProjectStore => {
	const store = new MemoryProjectStore();
	store.plant(
		REVIEW_MARK_PATH,
		serialiseReviewMark({
			formatVersion: REVIEW_MARK_FORMAT_VERSION,
			project: 'Amsterdam 1625',
			directory: 'amsterdam-1625',
			openedAt: '2026-08-08T09:00:00.000Z'
		})
	);
	return store;
};

describe('the document that binds a Workspace to a Remote', () => {
	it('round-trips', () => {
		expect(parseRemoteBinding(serialiseRemoteBinding(BINDING))).toEqual(BINDING);
	});

	it('is absent from a Workspace nobody has bound', async () => {
		expect(await readRemoteBinding(new MemoryProjectStore())).toBeNull();
	});

	it('is read off the Workspace itself, so the binding survives a reload', async () => {
		const store = new MemoryProjectStore();
		await writeRemoteBinding(store, 'My Workspace', BINDING);

		expect(await readRemoteBinding(store)).toEqual(BINDING);
	});

	it('is at the Workspace root, inside the published tree (ADR-0033)', async () => {
		const store = new MemoryProjectStore();
		await writeRemoteBinding(store, 'My Workspace', BINDING);

		expect(await store.list('')).toContain(REMOTE_BINDING_PATH);
	});

	it('is written as JSON a person can read, and a Clone can parse', async () => {
		const store = new MemoryProjectStore();
		await writeRemoteBinding(store, 'My Workspace', BINDING);

		expect(JSON.parse(new TextDecoder().decode(await store.read(REMOTE_BINDING_PATH)))).toEqual({
			formatVersion: 1,
			owner: 'ada',
			repository: 'atlas',
			branch: 'main'
		});
	});

	it('is gone once the Workspace is unbound, and unbinding twice is not an error', async () => {
		const store = new MemoryProjectStore();
		await writeRemoteBinding(store, 'My Workspace', BINDING);

		await clearRemoteBinding(store);
		await clearRemoteBinding(store);

		expect(await readRemoteBinding(store)).toBeNull();
	});
});

// ⚠ **Unreadable means *unbound*, which is the opposite of what the review mark does with the same
// situation.** The mark answers "review" for a file it cannot read, because the failure to avoid
// there is an afternoon's work inside a Workspace built to be thrown away. Here the failure to avoid
// is a Publish button aimed at an address nobody checked, so every doubt answers `null` — and none
// of these throws, because this is read on every load.
describe('a binding this build cannot act on is no binding', () => {
	const unbound = async (content: string) => {
		const store = new MemoryProjectStore();
		store.plant(REMOTE_BINDING_PATH, encode(content));
		expect(await readRemoteBinding(store)).toBeNull();
	};

	it('is not JSON', async () => unbound('not json at all'));
	it('is JSON that is not an object', async () => unbound('"ada/atlas"'));
	it('names no owner', async () => unbound('{"formatVersion":1,"repository":"atlas"}'));
	it('names no repository', async () => unbound('{"formatVersion":1,"owner":"ada"}'));
	it('names an empty owner', async () =>
		unbound('{"formatVersion":1,"owner":"  ","repository":"atlas"}'));

	// ⚠ **This is the *less* trusted of the two readers, and it used to be the more tolerant one.**
	// What arrives here is a file on disk — from a restored Backup, a colleague's folder, or (ticket
	// 07) a `remote.json` downloaded out of somebody else's published tree — and both fields are
	// interpolated straight into the API path the publish engine builds. `encodeURIComponent` at the
	// interpolation is not the fix: it leaves `.` alone, so `..` survives it and `fetch` normalises
	// the traversal away. So a hostile document is *no binding at all*, and the Workspace is unbound.
	it('names an owner that would climb out of the repository path', async () =>
		unbound('{"formatVersion":1,"owner":"ada/../../orgs","repository":"atlas"}'));

	it('names a repository carrying a query of its own', async () =>
		unbound('{"formatVersion":1,"owner":"ada","repository":"atlas?x=1"}'));

	it('names a repository on another host entirely', async () =>
		unbound('{"formatVersion":1,"owner":"ada","repository":"https://evil.invalid/x"}'));

	it('names an owner with a dot in it, which GitHub does not allow', async () =>
		unbound('{"formatVersion":1,"owner":"ada.lovelace","repository":"atlas"}'));

	// ⚠ **The two path segments that are not names.** Both match the character set a repository is
	// allowed — letters, digits and `-_.` — and both are interpolated straight into a URL: `ada/..`
	// normalises to `api.github.com/repos/ada`, which is an endpoint about a *user*, and on the raw
	// host it climbs out of the repository altogether.
	it('names a repository that is the current directory', async () =>
		unbound('{"formatVersion":1,"owner":"ada","repository":"."}'));

	it('names a repository that is the parent directory', async () =>
		unbound('{"formatVersion":1,"owner":"ada","repository":".."}'));

	it('is a Workspace that cannot be reached at all', async () => {
		const unreachable = {
			read: () => Promise.reject(new Error('The folder has been unplugged.')),
			list: () => Promise.resolve([]),
			write: () => Promise.resolve(),
			delete: () => Promise.resolve(),
			size: () => Promise.resolve(0),
			reclaimAbandonedWrites: () => Promise.resolve()
		};

		expect(await readRemoteBinding(unreachable)).toBeNull();
	});
});

describe('a binding from a build that knew more than this one', () => {
	it('keeps its owner and repository rather than being refused (ADR-0010’s tolerance)', async () => {
		const store = new MemoryProjectStore();
		store.plant(
			REMOTE_BINDING_PATH,
			encode(
				'{"formatVersion":7,"owner":"ada","repository":"atlas","branch":"main","host":"gitea"}'
			)
		);

		expect(await readRemoteBinding(store)).toEqual({
			formatVersion: 7,
			owner: 'ada',
			repository: 'atlas',
			branch: 'main'
		});
	});

	it('names no branch, and is therefore bound to main', () => {
		expect(
			parseRemoteBinding(encode('{"formatVersion":1,"owner":"ada","repository":"atlas"}'))
		).toHaveProperty('branch', DEFAULT_REMOTE_BRANCH);
	});
});

// ADR-0024, SPEC story 39. **Refused in the domain package rather than by an absent menu item**:
// publishing somebody else's Project to your own address is promotion by another route and a worse
// one, and a Clone, a restored Backup, and a URL parameter all reach a store without passing a menu.
describe('a Review Workspace can never be bound', () => {
	it('refuses, in the sentence every review refusal uses', async () => {
		const store = reviewCopy();

		await expect(writeRemoteBinding(store, 'assignment 7', BINDING)).rejects.toThrow(
			ReviewWorkspaceError
		);
	});

	it('names the Project and says why, rather than failing silently', async () => {
		const store = reviewCopy();

		await expect(writeRemoteBinding(store, 'assignment 7', BINDING)).rejects.toThrow(
			/review copy of “Amsterdam 1625”.*bound to a repository on GitHub/s
		);
	});

	it('writes nothing, so the review copy is left exactly as it was', async () => {
		const store = reviewCopy();
		const before = await store.list('');

		await expect(writeRemoteBinding(store, 'assignment 7', BINDING)).rejects.toThrow();

		expect(await store.list('')).toEqual(before);
		expect(await readRemoteBinding(store)).toBeNull();
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
	// Clone form, `ada/..` builds a tree URL that normalises to an endpoint about the *user* `ada`,
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
		expect(describeRemote(BINDING)).toBe('ada/atlas');
	});
});

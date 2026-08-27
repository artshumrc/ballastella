// The guided sequence that puts a Workspace on GitHub, at Seam 1c (SPEC stories 1, 7–9, 26–32, 36,
// 43, 61, 65–67).
//
// ⚠ **The subject is the derivation, and that is why nearly the whole ticket is here.** Which step
// shows for which combination of facts, what each step says, what a press hands to `bindRemote`, and
// what the three outcomes that come back are rendered as — none of it needs a browser, and every one
// of them would otherwise have been a four-second Playwright test.
//
// ⚠ **The fake storage is reactive on purpose.** The sequence's contract is that it holds no position
// counter, so "it moves on its own when the facts change" is the claim; a fake whose `remote` and
// `signedIn` were plain fields could not falsify it. See `connect-to-github-fake.svelte.ts`.
//
// ⚠ **What is deliberately not here.** That the listing really reads GitHub's installation endpoints,
// and that a rejected sign-in is a refusal rather than an empty list, are `github-installations.ts`'s
// at Seam 1 against the shared fake GitHub. That the rights check happens before any bytes move, that
// Pages degrades to a sentence, and that the subset comparison is by Project directory are
// `bind-remote.ts`'s, there too. That the application actually wires this component to the real
// sign-in, the real bind and the real Publish is one test in `e2e/editor-github-signin.e2e.ts`, which
// is what keeps this file from asserting against a fake in isolation. Story 68 — the action visible
// without scrolling — is layout and is not asserted at any seam this file can reach.

import type { GrantedRepositoriesOutcome, GrantedRepository } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import ConnectToGitHub from './ConnectToGitHub.svelte';
import { FakeStorage, outcome } from './connect-to-github-fake.svelte.js';
import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

const ATLAS: GrantedRepository = {
	owner: 'ada',
	repository: 'atlas',
	canPublish: true,
	isPrivate: false
};

const listed = (
	repositories: readonly GrantedRepository[] = [ATLAS]
): GrantedRepositoriesOutcome => ({ kind: 'listed', repositories });

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

type Opened = {
	readonly storage: FakeStorage;
	readonly list: ReturnType<typeof vi.fn>;
	readonly onpublish: ReturnType<typeof vi.fn>;
};

/** Open the sequence over a Workspace in whatever state the caller has put the fake into. */
function open(storage: FakeStorage, answer: GrantedRepositoriesOutcome | Error = listed()): Opened {
	const list = vi.fn(async (token: string) => {
		void token;
		if (answer instanceof Error) throw answer;
		return answer;
	});
	const onpublish = vi.fn();
	const main = document.createElement('main');
	document.body.append(main);
	mounted = mount(ConnectToGitHub, {
		target: main,
		props: { open: true, storage: storage as unknown as WorkspaceStorage, onpublish, list }
	});
	flushSync();
	return { storage, list, onpublish };
}

/** A fork that has registered no GitHub App, so the paste is the whole of its authentication. */
function noApp(): FakeStorage {
	const storage = new FakeStorage();
	storage.signInWithGitHubOffered = false;
	return storage;
}

/** Somebody who has been through the App sign-in, which is what the sequence's step 2 reads. */
function signedIn(): FakeStorage {
	const storage = new FakeStorage();
	storage.signedIn = true;
	storage.identity = 'ada';
	storage.credential = 'a-credential-this-component-never-renders';
	return storage;
}

/** Let the injected listing and the injected bind settle, and render what they answered. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
	flushSync();
}

const at = (testId: string): HTMLElement => {
	const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (!found) throw new Error(`nothing is rendered with data-testid="${testId}"`);
	return found;
};

const absent = (testId: string): boolean =>
	document.querySelector(`[data-testid="${testId}"]`) === null;

/** An element's words with the template's own line breaks collapsed. */
const text = (element: Element | null | undefined): string =>
	(element?.textContent ?? '').replace(/\s+/g, ' ').trim();

const said = (): string => text(document.body);

const press = (testId: string): void => {
	at(testId).click();
	flushSync();
};

/** Type into one of the fork step's two fields, as a person filling it in would. */
const fill = (testId: string, value: string): void => {
	const field = at(testId) as HTMLInputElement;
	field.value = value;
	field.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
};

/** Submit the fork step's form, which is what its one button does. */
const submit = (): void => {
	at('connect-paste')
		.closest('form')
		?.dispatchEvent(new SubmitEvent('submit', { bubbles: true }));
	flushSync();
};

describe('which step the sequence shows', () => {
	// Story 7, and the derivation's first reading: no credential is the only fact that decides this.
	test('asks for the sign-in when no credential is held, and asks GitHub nothing', () => {
		const { list } = open(new FakeStorage());

		expect(at('connect-sign-in')).toBeTruthy();
		expect(absent('connect-choosing')).toBe(true);
		// Nothing to ask with, so nothing was asked: a listing read on no credential would come back a
		// refusal and present to a student as "you have no repositories".
		expect(list).not.toHaveBeenCalled();
	});

	test('begins the existing App sign-in when the button is pressed', () => {
		const { storage } = open(new FakeStorage());

		press('connect-sign-in-with-github');

		expect(storage.signInsBegun).toBe(1);
	});

	// ⚠ **Story 8's other half, which is what the mark is for.** The sign-in replaces the document, so
	// nothing the sequence holds in memory survives it — the mark is how the return leg knows to come
	// back here. That it really does come back is Seam 2's, since only a browser can perform the
	// redirect; that the mark is laid down at all is this seam's, and it is cheap.
	test('marks the tab before leaving, so the return comes back to the sequence', () => {
		sessionStorage.clear();
		open(new FakeStorage());

		press('connect-sign-in-with-github');

		expect(sessionStorage.getItem('ballastella.connect-sequence-resuming')).toBe('yes');
	});

	// A browser that will not keep the `state` cannot finish a sign-in it starts, and the existing
	// refusal is a sentence rather than a throw — so it has somewhere to be rendered.
	test('says why this browser cannot start a sign-in', () => {
		const storage = new FakeStorage();
		storage.signInRefusal = 'This browser will not let this page remember the sign-in.';
		open(storage);

		press('connect-sign-in-with-github');

		expect(text(at('connect-problem'))).toContain('will not let this page remember');
		// ⚠ **And the mark is taken back up.** The page is not going anywhere, so a mark left behind
		// would reopen the sequence on some unrelated reload later in the session.
		expect(sessionStorage.getItem('ballastella.connect-sequence-resuming')).toBeNull();
	});

	// ⚠ **Story 8, and the whole reason there is no position counter.** Returning from GitHub is not a
	// press on this screen: the page has been reloaded and a credential is simply *there*. A sequence
	// with a remembered position would come back at the beginning; this one comes back at the choice.
	test('lands on the choice when a credential is already held, not at the beginning', async () => {
		open(signedIn());
		await settle();

		expect(absent('connect-sign-in')).toBe(true);
		expect(at('connect-choosing')).toBeTruthy();
	});

	// Story 9: a shared or a classmate's machine is the case, and the name is the only thing that tells
	// them apart.
	test('names the account the sign-in is as', async () => {
		open(signedIn());
		await settle();

		expect(text(at('connect-account'))).toBe('Signed in to GitHub as ada.');
	});

	// Story 61: a Workspace that is already on GitHub is not asked to connect again, and nothing is
	// read from GitHub to find that out.
	test('opens on the connected step for a Workspace that already has a Remote', () => {
		const storage = signedIn();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		const { list } = open(storage);

		expect(at('connect-connected')).toBeTruthy();
		expect(absent('connect-choosing')).toBe(true);
		expect(list).not.toHaveBeenCalled();
	});

	// ⚠ **A sign-in that ended mid-sequence.** The step is a reading rather than a position, so
	// clearing the credential moves the sequence back on its own with nothing pressed.
	test('goes back to the sign-in when the credential goes away under it', async () => {
		const storage = signedIn();
		open(storage);
		await settle();
		expect(at('connect-choosing')).toBeTruthy();

		storage.signedIn = false;
		storage.credential = null;
		flushSync();

		expect(at('connect-sign-in')).toBeTruthy();
	});
});

describe('the repositories the sequence offers', () => {
	test('renders the granted repositories as a choice', async () => {
		open(signedIn(), listed([ATLAS, { ...ATLAS, repository: 'seminar' }]));
		await settle();

		expect(document.querySelectorAll('[data-testid="granted-repository"]')).toHaveLength(2);
		expect(said()).toContain('ada/atlas');
	});

	// ⚠ **The refusal is rendered as a refusal.** `github-installations` answers a rejected sign-in as
	// one deliberately, and a sequence that rendered it as an empty list would send a student to
	// GitHub to make a second repository that would not appear either.
	test('says what GitHub refused rather than showing an empty list', async () => {
		open(signedIn(), {
			kind: 'refused',
			refusal: 'credential',
			message: 'Your GitHub sign-in has ended, so your repositories could not be read.'
		});
		await settle();

		expect(text(at('connect-choices-refused'))).toContain('sign-in has ended');
		expect(absent('repository-choice-empty')).toBe(true);
	});
});

describe('connecting, which is one act', () => {
	/** Choose the one repository on offer, and let the connection settle. */
	async function choose(): Promise<void> {
		await settle();
		press('choose-repository');
		await settle();
	}

	// ⚠ **Story 26, and the claim is about what was handed over.** One call, naming the repository the
	// author chose and no credential of its own — so the rights check and Pages are the existing
	// code's, performed inside it, and there is no second path to either.
	test('hands the chosen repository to the existing bind, once, with no credential of its own', async () => {
		const opened = open(signedIn());
		await choose();

		expect(opened.storage.bindCalls).toEqual([
			{ remote: { owner: 'ada', repository: 'atlas' }, token: null }
		]);
	});

	test('says the repository is connected, and that setting up is over', async () => {
		open(signedIn());
		await choose();

		expect(text(at('connect-outcome'))).toContain('ada/atlas');
		expect(text(at('connect-outcome'))).toContain('Setting up is over');
	});

	// Stories 30 and 31 together: the one thing that may have to be done by hand is fully specified,
	// and the connection it happened to stands.
	test('reports a Pages failure with the setting, where it is and what to choose, and stays connected', async () => {
		const storage = signedIn();
		storage.bindAnswer = outcome({
			pages: {
				enabled: false,
				instruction:
					'GitHub Pages could not be turned on for ada/atlas. On GitHub open ada/atlas → ' +
					'Settings → Pages, set Source to “Deploy from a branch”, choose the branch “main” and ' +
					'the folder “/ (root)”, and press Save.'
			}
		});
		open(storage);
		await choose();

		const notice = text(at('connect-notice'));
		expect(notice).toContain('Settings → Pages');
		expect(notice).toContain('Deploy from a branch');
		expect(notice).toContain('/ (root)');
		// The connection stands: a repository that is correctly connected stays connected.
		expect(at('connect-connected')).toBeTruthy();
		expect(storage.remote).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
	});

	// The rights refusal is the other outcome the connection stands *with*, and it is deliberate: the
	// binding records where this Workspace belongs whether or not this author may publish there.
	test('reports that the author cannot publish there, and stays connected', async () => {
		const storage = signedIn();
		storage.bindAnswer = outcome({
			canPush: false,
			rightsNotice: 'This token cannot push to ada/atlas, so publishing to it will be refused.'
		});
		open(storage);
		await choose();

		expect(text(at('connect-notice'))).toContain('publishing to it will be refused');
		expect(at('connect-connected')).toBeTruthy();
	});

	// ⚠ **Story 65: this one is a refusal and must never soften into a warning.** Publishing over a
	// Remote carrying Projects this Workspace has not got would delete them, so the Projects are named
	// and the connection does not happen — which means the sequence is back at the choice.
	test('refuses a repository whose work publishing would destroy, and names it', async () => {
		const storage = signedIn();
		storage.bindAnswer = new Error(
			'ada/atlas already carries work from Ballastella, and “Amsterdam 1625” is a Project on it ' +
				'that this Workspace has not got.'
		);
		open(storage);
		await choose();

		expect(text(at('connect-problem'))).toContain('“Amsterdam 1625”');
		expect(storage.remote).toBeNull();
		expect(at('connect-choosing')).toBeTruthy();
		expect(absent('connect-connected')).toBe(true);
	});
});

describe('the address, and the handoff', () => {
	/** A Workspace already connected to `owner/repository`, which is the connected step's whole input. */
	function connected(owner: string, repository: string): FakeStorage {
		const storage = signedIn();
		storage.remote = { owner, repository, branch: 'main' };
		return storage;
	}

	// Story 32: the thing the assignment actually asked for.
	test('names the address the Published Site will answer at', () => {
		open(connected('ada', 'atlas'));

		expect(text(at('published-site-address'))).toBe('https://ada.github.io/atlas/');
	});

	// ⚠ **A person's own `<login>.github.io` repository is served at the domain root**, so the folder
	// form of the address would name a page that answers nothing.
	test('names the domain root for the account’s own site repository', () => {
		open(connected('Ada', 'Ada.github.io'));

		expect(text(at('published-site-address'))).toBe('https://ada.github.io/');
	});

	// Story 43: pasting it into a submission form is the use, and the visible text is what a browser
	// that refuses the clipboard leaves behind.
	test('puts the address on the clipboard', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		open(connected('ada', 'atlas'));

		press('copy-published-site-address');
		await settle();

		expect(writeText).toHaveBeenCalledWith('https://ada.github.io/atlas/');
		expect(text(at('copied-address'))).toContain('clipboard');
	});

	// Story 28: the sequence ends at the button that was always there rather than at a second one.
	test('hands off to Publish and closes', () => {
		const opened = open(connected('ada', 'atlas'));

		press('connect-publish');

		expect(opened.onpublish).toHaveBeenCalledTimes(1);
	});
});

describe('reaching every step without sight and without a pointer', () => {
	// Story 66. One region, in the document from the first frame, whose words change with the step —
	// a region inserted at the moment its text first exists is not reliably announced (ADR-0016).
	test('announces each step as it changes', async () => {
		const storage = signedIn();
		const opened = open(storage);
		expect(at('connect-step')).toHaveAttribute('role', 'status');

		await settle();
		expect(text(at('connect-step'))).toContain('choose where your map goes');

		press('choose-repository');
		await settle();
		expect(text(at('connect-step'))).toContain('this Workspace is on GitHub at ada/atlas');
		expect(opened.storage.bindCalls).toHaveLength(1);
	});

	// Story 67. `disabled` takes a control out of the tab order, so a keyboard user reaching the
	// sequence mid-flight would find the thing they were about to press simply gone (WCAG 2.4.3).
	test('leaves no control out of the tab order', async () => {
		open(signedIn());
		await settle();

		expect(at('connect-sequence').querySelectorAll('[disabled]')).toHaveLength(0);
	});
});

// ⚠ **The sequence's own words, not `packages/core`'s.** `rightsNotice`, the Pages instruction and
// every bind refusal are rendered exactly as `bind-remote` composes them, and those name a GitHub
// permission and a token because that is what the author has to go and change — rewriting them here
// would be a second account of GitHub's own settings screens to keep in step. What this asserts is
// that nothing the sequence writes for itself asks a student to learn any of it (story 38).
describe('the words the sequence uses', () => {
	const FORBIDDEN = [
		'bind',
		'binding',
		'credential',
		'namespace',
		'token',
		'sync',
		'deploy',
		'upload',
		'push',
		'backup',
		'cloud'
	];

	test.each([
		['the sign-in step', () => open(new FakeStorage())],
		[
			'the connected step',
			() => {
				const storage = signedIn();
				storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
				return open(storage);
			}
		]
	])('%s says none of the words a student would have to learn', (_name, arrange) => {
		arrange();

		const words = said().toLowerCase();
		expect(FORBIDDEN.filter((word) => words.includes(word))).toEqual([]);
	});

	test('the choice step says none of them either', async () => {
		open(signedIn());
		await settle();

		const words = said().toLowerCase();
		expect(FORBIDDEN.filter((word) => words.includes(word))).toEqual([]);
	});
});

// ⚠ **The fork with no App of its own, which is the other half of "one door"** (SPEC stories 50–52,
// and the Brief's *where there is an App, one door; where there is not, the door that works*).
//
// `signInWithGitHubOffered` is `isGitHubAppConfigured(GITHUB_APP)` and nothing else — the same value
// that already decides whether the sign-in button exists — so this is the derivation reading one more
// fact rather than a second answer to "is there an App". That the predicate itself is right is
// `github-sign-in.test.ts`'s at Seam 1, and that the paste reaches GitHub with no broker anywhere near
// it is asserted there too; what is here is which door the sequence opens.
describe('a fork that has registered no GitHub App', () => {
	test('offers the paste as its first step, and no sign-in that could not complete', () => {
		const { list } = open(noApp());

		expect(at('connect-no-app')).toBeTruthy();
		expect(absent('connect-sign-in')).toBe(true);
		expect(absent('connect-sign-in-with-github')).toBe(true);
		// ⚠ `/user/installations` answers a GitHub App user token and nothing else, so asking it here
		// would come back a refusal and read as "you have no repositories".
		expect(list).not.toHaveBeenCalled();
	});

	// The deployment with an App is the other reading of the same fact, and it is the one a student is
	// on: the word never appears, so there are not two credentials to choose between (stories 37, 46).
	test('shows no token field at all where an App is configured', async () => {
		open(signedIn());
		await settle();

		expect(absent('connect-no-app')).toBe(true);
		expect(absent('connect-token-field')).toBe(true);
	});

	// Story 50: the pasted path is the fork's whole door, so it has to reach the same bind the chosen
	// repository does — one call, with the credential the author gave.
	test('connects the typed repository with the pasted token', async () => {
		const opened = open(noApp());

		fill('connect-repository-field', 'ada/atlas');
		fill('connect-token-field', 'github_pat_11ABCDE0000abcdefghijklmnop');
		submit();
		await settle();

		expect(opened.storage.bindCalls).toEqual([
			{
				remote: { owner: 'ada', repository: 'atlas' },
				token: 'github_pat_11ABCDE0000abcdefghijklmnop'
			}
		]);
		expect(at('connect-connected')).toBeTruthy();
	});

	// Both refusals are `packages/core`'s and neither costs a request, which is what makes a mistyped
	// address a sentence about the address rather than a 404 from GitHub minutes later.
	test('says an address that is not one is not one, and asks GitHub nothing', () => {
		const opened = open(noApp());

		fill('connect-repository-field', 'atlas');
		fill('connect-token-field', 'github_pat_11ABCDE0000abcdefghijklmnop');
		submit();

		expect(text(at('connect-problem'))).toContain('owner/repository');
		expect(opened.storage.bindCalls).toEqual([]);
	});

	test('says a token that is half a token is half a token, and asks GitHub nothing', () => {
		const opened = open(noApp());

		fill('connect-repository-field', 'ada/atlas');
		fill('connect-token-field', 'github_pat_11');
		submit();

		expect(text(at('connect-problem'))).toContain('too short');
		expect(opened.storage.bindCalls).toEqual([]);
	});

	// Story 17's fork-shaped half: the one step the tool does not take arrives with the name filled in,
	// and the sentence beside it says the repository has to be public.
	test('offers to create the repository with its name already filled in, and says it must be public', () => {
		const storage = noApp();
		storage.name = 'Amsterdam 1625';
		open(storage);

		expect(at('connect-create-repository')).toHaveAttribute(
			'href',
			'https://github.com/new?name=amsterdam-1625'
		);
		expect(said()).toContain('It has to be public');
	});

	// The derivation again: a fork's step is a reading of the deployment, so a Workspace that is
	// already connected shows the connected step rather than a form asking for a token.
	test('opens on the connected step for a Workspace that already has a Remote', () => {
		const storage = noApp();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		open(storage);

		expect(at('connect-connected')).toBeTruthy();
		expect(absent('connect-no-app')).toBe(true);
	});

	// Story 66, in a sequence that has one step fewer: the announcement counts the steps this door has
	// rather than the ones the other one has.
	test('announces the fork’s own steps', async () => {
		open(noApp());
		expect(text(at('connect-step'))).toContain('Step 1 of 2');

		fill('connect-repository-field', 'ada/atlas');
		fill('connect-token-field', 'github_pat_11ABCDE0000abcdefghijklmnop');
		submit();
		await settle();

		expect(text(at('connect-step'))).toContain('this Workspace is on GitHub at ada/atlas');
	});
});

// The guided sequence that puts a Workspace on GitHub, at Seam 1c (SPEC stories 1, 7–9, 16–32, 36,
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

/**
 * Press a link, without letting happy-dom go and fetch what it points at.
 *
 * The offers out to GitHub are ordinary anchors, so the second tab is the browser's own doing and
 * nothing in the component holds it open — which is the behaviour under test. happy-dom takes that
 * literally and navigates, and the network fence is right to refuse it, so the default action is
 * stopped here while the handler beside it still runs.
 */
const pressLink = (testId: string): void => {
	const stop = (event: Event): void => event.preventDefault();
	document.addEventListener('click', stop, true);
	try {
		press(testId);
	} finally {
		document.removeEventListener('click', stop, true);
	}
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

describe('making a repository, without leaving the sequence', () => {
	/** The one repository a student who has just made an account has granted: none. */
	const nothing = (): GrantedRepositoriesOutcome => listed([]);

	const HARBOUR: GrantedRepository = { ...ATLAS, repository: 'harbour' };

	/**
	 * Open the sequence, let the first listing land, and press the create action.
	 *
	 * The press is on an ordinary link, so the second tab is the browser's doing; what happens here is
	 * that the sequence notes what GitHub had said, which is the whole of what it knows about the
	 * other tab.
	 */
	async function leaveToCreate(
		first: GrantedRepositoriesOutcome,
		then: GrantedRepositoriesOutcome = first
	): Promise<Opened> {
		let answer = first;
		const list = vi.fn(async (token: string) => {
			void token;
			return answer;
		});
		const onpublish = vi.fn();
		const storage = signedIn();
		const main = document.createElement('main');
		document.body.append(main);
		mounted = mount(ConnectToGitHub, {
			target: main,
			props: { open: true, storage: storage as unknown as WorkspaceStorage, onpublish, list }
		});
		flushSync();
		await settle();
		pressLink('create-repository');
		answer = then;
		return { storage, list, onpublish };
	}

	// Story 16: having nothing granted is an ordinary case with an action in it, not a dead end.
	test('offers the action with an empty list and with a full one alike', async () => {
		open(signedIn(), nothing());
		await settle();
		expect(at('connect-no-choices')).toBeTruthy();
		expect(at('create-repository')).toBeTruthy();

		unmount(mounted!);
		mounted = undefined;
		document.body.innerHTML = '';

		open(signedIn(), listed([ATLAS]));
		await settle();
		expect(at('connect-choosing')).toBeTruthy();
		expect(at('create-repository')).toBeTruthy();
	});

	// Stories 17 and 18: the name arrives filled in, and the editor is not the tab that goes anywhere.
	test('opens GitHub’s new-repository screen in a second tab, with the name filled in', async () => {
		const storage = signedIn();
		storage.name = 'Amsterdam 1625';
		open(storage, nothing());
		await settle();

		const link = at('create-repository');
		expect(link.getAttribute('href')).toBe('https://github.com/new?name=amsterdam-1625');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(text(at('create-repository-note'))).toContain('amsterdam-1625');
	});

	// Stories 19–21, and the order is the claim rather than the presence: a student who grants access
	// before making the repository grants access to a repository that does not exist yet.
	test('names all three things to do, in the order that works', async () => {
		await leaveToCreate(nothing());

		expect(at('connect-creating')).toBeTruthy();
		const steps = [...document.querySelectorAll('[data-testid="creating-instruction"]')].map(text);
		expect(steps).toHaveLength(3);
		expect(steps[0]).toContain('has to be public');
		expect(steps[1]).toContain('give Ballastella access to it');
		expect(steps[2]).toContain('Come back to this tab');
	});

	// Story 22: the return is observed. A window raised over another application fires `focus` and no
	// `visibilitychange`, so both are listened for and either is enough.
	test('re-reads the listing when the window regains focus, with nothing pressed', async () => {
		const opened = await leaveToCreate(nothing(), listed([HARBOUR]));
		expect(opened.list).toHaveBeenCalledTimes(1);

		window.dispatchEvent(new Event('focus'));
		await settle();

		expect(opened.list).toHaveBeenCalledTimes(2);
		expect(at('connect-choosing')).toBeTruthy();
	});

	test('re-reads the listing when the document becomes visible, with nothing pressed', async () => {
		const opened = await leaveToCreate(nothing(), listed([HARBOUR]));

		document.dispatchEvent(new Event('visibilitychange'));
		await settle();

		expect(opened.list).toHaveBeenCalledTimes(2);
		expect(at('connect-choosing')).toBeTruthy();
	});

	// ⚠ **Story 23, and it is the point of comparing against a set rather than counting.** The
	// repository absent before and present after is the one they just made, and it is the row they
	// are looking for — so it is first and it is marked, whatever order GitHub answered in.
	test('puts a repository that was not there before at the top, marked as new', async () => {
		await leaveToCreate(listed([ATLAS]), listed([ATLAS, HARBOUR]));

		press('reread-repositories');
		await settle();

		const rows = [...document.querySelectorAll('[data-testid="granted-repository"]')].map(text);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain('ada/harbour');
		expect(rows[0]).toContain('New');
		expect(rows[1]).not.toContain('New');
	});

	// ⚠ **Story 24: the cause is named rather than guessed at.** A screen identical to the one they
	// left says nothing, and "no repositories found" names the wrong cause — the repository exists,
	// and access to it is what is missing.
	test('names the missing grant when the listing comes back unchanged, and offers the way back', async () => {
		await leaveToCreate(nothing());

		press('reread-repositories');
		await settle();

		expect(text(at('created-not-granted'))).toContain('has not been given access to it');
		expect(at('grant-access').getAttribute('href')).toBe(
			'https://github.com/settings/installations'
		);
		expect(absent('repository-choice-empty')).toBe(true);
	});

	// Story 25: the automatic path is a convenience and never the only way through, so the manual
	// control is on screen from the moment the step is.
	test('offers a control that re-reads the listing at any point in the step', async () => {
		const opened = await leaveToCreate(nothing(), listed([HARBOUR]));

		press('reread-repositories');
		await settle();

		expect(opened.list).toHaveBeenCalledTimes(2);
		expect(at('connect-choosing')).toBeTruthy();
	});

	// ⚠ **No timer, and no request per flick of the wrist.** Some browsers fire `focus` and
	// `visibilitychange` for one return, and an author alt-tabbing between the two tabs would
	// otherwise spend somebody's hourly budget on a question already in flight.
	test('does not ask GitHub twice for one return', async () => {
		const opened = await leaveToCreate(nothing());

		window.dispatchEvent(new Event('focus'));
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();

		expect(opened.list).toHaveBeenCalledTimes(2);
	});

	// The step ends where the listing stops changing under it: nothing is watched once there is
	// nothing left to watch for.
	test('stops watching once the new repository has appeared', async () => {
		const opened = await leaveToCreate(nothing(), listed([HARBOUR]));
		press('reread-repositories');
		await settle();
		expect(at('connect-choosing')).toBeTruthy();

		window.dispatchEvent(new Event('focus'));
		await settle();

		expect(opened.list).toHaveBeenCalledTimes(2);
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

	// The two steps a student with nothing on GitHub meets first, which is where a word they would
	// have to go and learn would cost the most.
	test('the empty grant and the create step say none of them either', async () => {
		open(signedIn(), listed([]));
		await settle();
		expect(FORBIDDEN.filter((word) => said().toLowerCase().includes(word))).toEqual([]);

		pressLink('create-repository');
		press('reread-repositories');
		await settle();

		expect(at('connect-creating')).toBeTruthy();
		expect(text(at('created-not-granted'))).not.toBe('');
		expect(FORBIDDEN.filter((word) => said().toLowerCase().includes(word))).toEqual([]);
	});
});

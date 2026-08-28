// The guided sequence that puts a Workspace on GitHub, at Seam 1c.
//
// ⚠ **The subject is the derivation, and that is why nearly all of this component's behaviour is
// here.** Which step shows for which combination of facts, what each step says, what a press hands
// to `bindRemote`, and what the three outcomes that come back are rendered as — none of it needs a
// browser, and every one of them would otherwise have been a four-second Playwright test.
//
// ⚠ **The fake storage is reactive on purpose.** The sequence's contract is that it holds no position
// counter, so "it moves on its own when the facts change" is the claim; a fake whose `remote` and
// `signedIn` were plain fields could not falsify it. See `connect-to-github-fake.svelte.ts`.
//
// ⚠ **What is deliberately not here.** That the listing really reads GitHub's installation
// endpoints, and that a rejected sign-in is a refusal rather than an empty list, are
// `github-installations.ts`'s at Seam 1 against the shared fake GitHub. That the rights check
// happens before any bytes move, that Pages degrades to a sentence, and that the subset comparison
// is by Project directory are `bind-remote.ts`'s, there too. That the application actually wires
// this component to the real sign-in, the real bind and the real Publish is one test in
// `e2e/editor-github-signin.e2e.ts`, which is what keeps this file from asserting against a fake in
// isolation. The action being visible without scrolling is layout and is not asserted at any seam
// this file can reach.

import {
	authorizeUrl,
	type GrantedRepositoriesOutcome,
	type GrantedRepository
} from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { connectSequence } from '$lib/connect-sequence.svelte.js';

import ConnectToGitHub from './ConnectToGitHub.svelte';
import {
	FAKE_APP,
	FAKE_REDIRECT_URI,
	FAKE_STATE,
	FakeStorage,
	outcome,
	sequenceProps,
	type SequenceProps
} from './connect-to-github-fake.svelte.js';
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

/**
 * The two addresses a departing sign-in can go to, composed from the fake App.
 *
 * ⚠ **Written out rather than taken from `installUrl`**, so the shape of the address is a claim this
 * file makes rather than one it inherits: a first-time author leaves for the App's own install
 * screen, which installs and signs in on one screen.
 */
const INSTALL_FIRST = `https://github.com/apps/${FAKE_APP.appSlug}/installations/new?state=${FAKE_STATE}`;
const AUTHORIZE_ONLY = authorizeUrl({
	app: FAKE_APP,
	redirectUri: FAKE_REDIRECT_URI,
	state: FAKE_STATE
});

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
	// ⚠ **The account hint and the resuming mark are the tab's**, so one test's press is the next
	// test's starting step unless this happens. Both are read at mount, which is what makes clearing
	// here enough.
	sessionStorage.clear();
	connectSequence.signInRefusal = '';
});

type Opened = {
	readonly storage: FakeStorage;
	readonly list: ReturnType<typeof vi.fn>;
	readonly onpublish: ReturnType<typeof vi.fn>;
	/** Writable, so a test can close the sequence and open it again without remounting it. */
	readonly props: SequenceProps;
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
	const props = sequenceProps({
		storage: storage as unknown as WorkspaceStorage,
		onpublish,
		list
	});
	mounted = mount(ConnectToGitHub, { target: main, props });
	flushSync();
	return { storage, list, onpublish, props };
}

/**
 * Open with the account step already behind the author, which is every claim about the sign-in.
 *
 * The step before the sign-in is offered rather than detected, so it stands in front of a fresh
 * sequence by design; this presses past it the way a person with an account does.
 */
function openPastAccount(
	storage: FakeStorage,
	answer: GrantedRepositoriesOutcome | Error = listed()
): Opened {
	const opened = open(storage, answer);
	press('connect-have-account');
	return opened;
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
	// The derivation's first reading: no credential is the only fact that decides this.
	test('asks for the sign-in when no credential is held, and asks GitHub nothing', () => {
		const { list } = openPastAccount(new FakeStorage());

		expect(at('connect-sign-in')).toBeTruthy();
		expect(absent('connect-choosing')).toBe(true);
		// Nothing to ask with, so nothing was asked: a listing read on no credential would come back a
		// refusal and present to a student as "you have no repositories".
		expect(list).not.toHaveBeenCalled();
	});

	test('begins the existing App sign-in when the button is pressed', () => {
		const { storage } = openPastAccount(new FakeStorage());

		press('connect-sign-in-with-github');

		expect(storage.signInsBegun).toBe(1);
	});

	// ⚠ **The trip a first-time author takes installs the App *and* issues the code, on one screen.**
	// An authorize-only trip leaves them holding a credential against no Installation and a list of no
	// repositories — which reads as owning nothing rather than as a step nobody named.
	test('departs to the App’s own install screen, not to the plain authorize screen', () => {
		const { storage } = openPastAccount(new FakeStorage());

		press('connect-sign-in-with-github');

		expect(storage.signInDepartures).toEqual([INSTALL_FIRST]);
	});

	// Story 7 and Story 8: the choice, the reason for it, and what choosing otherwise costs — said
	// **before** the departure, because after it this screen is gone.
	test('says to choose All repositories, and what choosing only some costs', () => {
		openPastAccount(new FakeStorage());

		const said = text(at('connect-choose-all-repositories'));
		expect(said).toContain('All repositories');
		expect(said).toContain('every one you make later');
		expect(said).toMatch(/make after today will not be there/);
	});

	// ⚠ **The other half of the return trip, which is what the mark is for.** The sign-in replaces
	// the document, so nothing the sequence holds in memory survives it — the mark is how the return
	// leg knows to come back here. That it really does come back is Seam 2's, since only a browser
	// can perform the redirect; that the mark is laid down at all is this seam's, and it is cheap.
	test('marks the tab before leaving, so the return comes back to the sequence', () => {
		openPastAccount(new FakeStorage());

		press('connect-sign-in-with-github');

		expect(sessionStorage.getItem('ballastella.connect-sequence-resuming')).toBe('yes');
	});

	// A browser that will not keep the `state` cannot finish a sign-in it starts, and the existing
	// refusal is a sentence rather than a throw — so it has somewhere to be rendered.
	test('says why this browser cannot start a sign-in', () => {
		const storage = new FakeStorage();
		storage.signInRefusal = 'This browser will not let this page remember the sign-in.';
		openPastAccount(storage);

		press('connect-sign-in-with-github');

		expect(text(at('connect-problem'))).toContain('will not let this page remember');
		// ⚠ **And the mark is taken back up.** The page is not going anywhere, so a mark left behind
		// would reopen the sequence on some unrelated reload later in the session.
		expect(sessionStorage.getItem('ballastella.connect-sequence-resuming')).toBeNull();
	});

	// ⚠ **The return from GitHub, and the whole reason there is no position counter.** Returning from
	// GitHub is not a press on this screen: the page has been reloaded and a credential is simply
	// *there*. A sequence with a remembered position would come back at the beginning; this one comes
	// back at the choice.
	test('lands on the choice when a credential is already held, not at the beginning', async () => {
		open(signedIn());
		await settle();

		expect(absent('connect-sign-in')).toBe(true);
		expect(at('connect-choosing')).toBeTruthy();
	});

	// A shared or a classmate's machine is the case, and the name is the only thing that tells them
	// apart.
	test('names the account the sign-in is as', async () => {
		open(signedIn());
		await settle();

		expect(text(at('connect-account'))).toBe('Signed in to GitHub as ada.');
	});

	// A Workspace that is already on GitHub is not asked to connect again, and nothing is read from
	// GitHub to find that out.
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

	// ⚠ **And it is not an empty list in the one region a reader without sight has either.** The
	// visible screen carrying the refusal while the announcement said "you have given Ballastella
	// access to no repository yet, so make one" would send exactly that reader to GitHub to make a
	// second repository, which is the failure `github-installations` answers a refusal to prevent.
	test('does not announce a refusal as having no repositories', async () => {
		open(signedIn(), {
			kind: 'refused',
			refusal: 'credential',
			message: 'Your GitHub sign-in has ended, so your repositories could not be read.'
		});
		await settle();

		expect(text(at('connect-step'))).toContain('could not be read');
		expect(text(at('connect-step'))).not.toContain('make one');
		expect(absent('connect-no-choices')).toBe(true);
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
		const props = sequenceProps({
			storage: storage as unknown as WorkspaceStorage,
			onpublish,
			list
		});
		mounted = mount(ConnectToGitHub, { target: main, props });
		flushSync();
		await settle();
		pressLink('create-repository');
		answer = then;
		return { storage, list, onpublish, props };
	}

	// Having nothing granted is an ordinary case with an action in it, not a dead end.
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

	// The name arrives filled in, and the editor is not the tab that goes anywhere.
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

	// The order is the claim rather than the presence: a student who grants access before making the
	// repository grants access to a repository that does not exist yet.
	test('names all three things to do, in the order that works', async () => {
		await leaveToCreate(nothing());

		expect(at('connect-creating')).toBeTruthy();
		const steps = [...document.querySelectorAll('[data-testid="creating-instruction"]')].map(text);
		expect(steps).toHaveLength(3);
		expect(steps[0]).toContain('has to be public');
		expect(steps[1]).toContain('give Ballastella access to it');
		expect(steps[2]).toContain('Come back to this tab');
	});

	// The return is observed. A window raised over another application fires `focus` and no
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

	// ⚠ **Comparing against a set rather than counting is the point.** The repository absent before
	// and present after is the one they just made, and it is the row they are looking for — so it is
	// first and it is marked, whatever order GitHub answered in.
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

	// ⚠ **The cause is named rather than guessed at.** A screen identical to the one they left says
	// nothing, and "no repositories found" names the wrong cause — the repository exists, and access
	// to it is what is missing.
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

	// The automatic path is a convenience and never the only way through, so the manual control is on
	// screen from the moment the step is.
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

	// ⚠ **A refusal is not a listing with nothing in it, and this step is where confusing the two does
	// the most damage.** `readGrantedRepositories` answers a sign-in GitHub will not act on as a refusal
	// precisely so that nothing reads it as "you have granted nothing" — and this step's own account of
	// a listing that did not grow is that access to the new repository was never given, which would name
	// the wrong cause with confidence and send the author back to GitHub to grant it a second time.
	test('reports a re-read GitHub refused as a refusal, not as a missing grant', async () => {
		await leaveToCreate(nothing(), {
			kind: 'refused',
			refusal: 'credential',
			message: 'Your GitHub sign-in has ended, so your repositories could not be read.'
		});

		press('reread-repositories');
		await settle();

		expect(text(at('connect-choices-refused'))).toContain('sign-in has ended');
		expect(absent('created-not-granted')).toBe(true);
		expect(at('connect-sign-in-again')).toBeTruthy();
		expect(text(at('connect-step'))).toContain('could not be read');
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

	// ⚠ **The claim is about what was handed over.** One call, naming the repository the author chose
	// and no credential of its own — so the rights check and Pages are the existing code's, performed
	// inside it, and there is no second path to either.
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

	// The one thing that may have to be done by hand is fully specified, and the connection it
	// happened to stands.
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

	// ⚠ **This one is a refusal and must never soften into a warning.** Publishing over a Remote
	// carrying Projects this Workspace has not got would delete them, so the Projects are named and
	// the connection does not happen — which means the sequence is back at the choice.
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

	// The address is the thing the assignment actually asked for.
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

	// Pasting it into a submission form is the use, and the visible text is what a browser that
	// refuses the clipboard leaves behind.
	test('puts the address on the clipboard', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		open(connected('ada', 'atlas'));

		press('copy-published-site-address');
		await settle();

		expect(writeText).toHaveBeenCalledWith('https://ada.github.io/atlas/');
		expect(text(at('copied-address'))).toContain('clipboard');
	});

	// The sequence ends at the button that was always there rather than at a second one.
	test('hands off to Publish and closes', () => {
		const opened = open(connected('ada', 'atlas'));

		press('connect-publish');

		expect(opened.onpublish).toHaveBeenCalledTimes(1);
	});
});

describe('the student who has never heard of GitHub', () => {
	// ⚠ **The reason this step exists at all.** A student with no account pressing "Sign in with
	// GitHub" arrives at a screen they cannot complete, and the editor never mentioned that an
	// account was the prerequisite. So the prerequisite is the first thing said.
	test('says an account is needed, what it is for, and that it costs nothing', () => {
		open(new FakeStorage());

		const words = text(at('connect-needs-account'));
		expect(words).toContain('You need a GitHub account');
		expect(words).toContain('where your map will live');
		expect(words).toContain('free');
	});

	// Not having to go and find GitHub's sign-up is the whole of it. A second tab, so the editor and
	// the sequence are still there to come back to.
	test('links to GitHub’s own sign-up, in a second tab', () => {
		open(new FakeStorage());

		const link = at('connect-sign-up');
		expect(link).toHaveAttribute('href', 'https://github.com/signup');
		expect(link).toHaveAttribute('target', '_blank');
		expect(link).toHaveAttribute('rel', 'noreferrer noopener');
	});

	// ⚠ **Offered, not detected, and therefore never in anybody's way.** GitHub cannot be asked
	// whether a stranger has an account, so the step in front of the sign-in states the prerequisite —
	// and somebody who is already signed in has answered it by being signed in.
	test('is not shown to somebody who is already signed in', async () => {
		open(signedIn());
		await settle();

		expect(absent('connect-needs-account')).toBe(true);
	});

	// ⚠ **Making an account must not cost the author their place.** They leave for GitHub's sign-up
	// in a second tab, make an account, and come back — often to a reloaded editor — and the step
	// they land on is the sign-in rather than the sentence they have already read.
	test('lands at the sign-in on the way back from making an account', () => {
		open(new FakeStorage());

		// ⚠ **The navigation is stopped here and nowhere else.** The link really is an ordinary
		// `<a target="_blank">`, which this DOM implementation would follow to github.com — and no test
		// in this repository reaches the network.
		const link = at('connect-sign-up');
		link.addEventListener('click', (event) => event.preventDefault());
		link.click();
		flushSync();
		expect(at('connect-sign-in')).toBeTruthy();

		// The tab reloading is what a return from GitHub often is, and it must not undo the press.
		unmount(mounted!);
		mounted = undefined;
		open(new FakeStorage());

		expect(at('connect-sign-in')).toBeTruthy();
		expect(absent('connect-needs-account')).toBe(true);
	});
});

describe('leaving the sequence, and coming back to it', () => {
	// Every step offers the way out, including the ones in the middle of something.
	test.each([
		['the account step', async () => open(new FakeStorage())],
		['the sign-in step', async () => openPastAccount(new FakeStorage())],
		[
			'the choice',
			async () => {
				open(signedIn());
				await settle();
			}
		],
		[
			'a refusal from GitHub',
			async () => {
				open(signedIn(), { kind: 'refused', refusal: 'network', message: 'GitHub said no.' });
				await settle();
			}
		],
		[
			'the create-and-grant step',
			async () => {
				open(signedIn());
				await settle();
				pressLink('create-repository');
			}
		],
		[
			'the connected step',
			async () => {
				const storage = signedIn();
				storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
				open(storage);
			}
		]
	])('can be closed from %s', async (_name, arrange) => {
		await arrange();

		expect(at('close-connect-sequence')).toBeTruthy();
	});

	// ⚠ **Reopening reads the facts again, and it is the derivation that pays for it.** Nothing is
	// remembered across a close, so reopening reads the same facts — and the listing is asked for
	// again, which is what makes a repository granted while the sequence was shut visible on return.
	// Reading the same facts lands in the same place everywhere but `creating`, whose landing is the
	// test below.
	test('reopens on the step the author was on', async () => {
		const opened = open(signedIn());
		await settle();
		expect(at('connect-choosing')).toBeTruthy();

		press('close-connect-sequence');
		expect(opened.props.open).toBe(false);

		opened.props.open = true;
		flushSync();
		await settle();

		expect(at('connect-choosing')).toBeTruthy();
		expect(opened.list).toHaveBeenCalledTimes(2);
	});

	// ⚠ **The one step that lands somewhere else, and it is the decision rather than the bug.** The
	// instructions describe a trip to the other tab; by the time the sequence is opened again that trip
	// is taken or abandoned, and the list is where both outcomes are legible.
	test('lands on the repository list after a close from the create-and-grant step', async () => {
		const opened = open(signedIn());
		await settle();
		pressLink('create-repository');
		expect(at('connect-creating')).toBeTruthy();

		press('close-connect-sequence');
		opened.props.open = true;
		flushSync();
		await settle();

		expect(absent('connect-creating')).toBe(true);
		expect(at('connect-choosing')).toBeTruthy();
		expect(opened.list).toHaveBeenCalledTimes(2);
	});

	// ⚠ **What a close must not leave behind.** The Pages instruction from a connection made a moment
	// ago says nothing about the Workspace whoever opens the sequence next is looking at.
	test('leaves no notice from the last time behind it', async () => {
		const storage = signedIn();
		const opened = open(storage);
		storage.bindAnswer = outcome({
			pages: { enabled: false, instruction: 'Turn Pages on under Settings → Pages.' }
		});
		await settle();
		press('choose-repository');
		await settle();
		expect(text(at('connect-notice'))).toContain('Settings → Pages');

		press('close-connect-sequence');
		opened.props.open = true;
		flushSync();

		expect(absent('connect-notice')).toBe(true);
	});
});

// A GitHub App's user token lasts eight hours, and one that has run out makes every later request
// fail — as a listing with nothing in it, or as a repository that refused the author. So the expiry
// is asked about the moment the sequence opens, before any of that can be misread.
describe('a sign-in that ran out', () => {
	const RAN_OUT = 'Your GitHub sign-in has expired, so nothing has been published.';

	test('says the sign-in ended and offers to sign in again', async () => {
		const storage = signedIn();
		storage.expiry = new Error(RAN_OUT);
		const opened = open(storage);
		await settle();

		expect(text(at('connect-expiry'))).toBe(RAN_OUT);
		press('connect-sign-in-with-github');
		expect(opened.storage.signInsBegun).toBe(1);
	});

	// ⚠ **An Installation this author already has**, or the sign-in that ran out could never have
	// listed anything. What is wanted is a fresh credential, which the plain authorize screen issues
	// without asking them to review an installation they made once already.
	test('departs to the plain authorize screen, not to the install screen again', async () => {
		const storage = signedIn();
		storage.expiry = new Error(RAN_OUT);
		const opened = open(storage);
		await settle();

		press('connect-sign-in-with-github');

		expect(opened.storage.signInDepartures).toEqual([AUTHORIZE_ONLY]);
	});

	// ⚠ **Not as a repository problem and not as a publishing failure**, which are the two things an
	// expiry looks like from underneath: the listing comes back refused, and a publish stops partway.
	test('does not present as a Workspace with no repositories', async () => {
		const storage = signedIn();
		storage.expiry = new Error(RAN_OUT);
		open(storage);
		await settle();

		expect(absent('connect-choosing')).toBe(true);
		expect(absent('repository-choice-empty')).toBe(true);
	});

	// The account step is behind anybody who has held a credential, so an expiry is a step back to the
	// sign-in rather than to the beginning.
	test('does not send an author who had signed in back to the account step', async () => {
		const storage = signedIn();
		storage.expiry = new Error(RAN_OUT);
		const opened = open(storage);
		await settle();

		press('close-connect-sequence');
		opened.props.open = true;
		flushSync();
		await settle();

		expect(at('connect-sign-in')).toBeTruthy();
		expect(absent('connect-needs-account')).toBe(true);
	});
});

// **No state of this sequence is a full stop**, and that is what this block is for. Each of these
// is a branch that can be reached, and each one has to name what to do and render the control that
// does it. A refusal whose only sequel is the Close button is the failure being tested for.
describe('every refusal names what to do next', () => {
	test('a sign-in GitHub will not act on offers the sign-in again', async () => {
		const opened = open(signedIn(), {
			kind: 'refused',
			refusal: 'credential',
			message: 'Your GitHub sign-in has ended, so your repositories could not be read.'
		});
		await settle();

		expect(text(at('connect-choices-refused'))).toContain('sign-in has ended');
		press('connect-sign-in-again');
		expect(opened.storage.signInsBegun).toBe(1);
		// A credential that reached GitHub and was refused is one an Installation was made for, so
		// this is the only-a-fresh-credential trip too.
		expect(opened.storage.signInDepartures).toEqual([AUTHORIZE_ONLY]);
	});

	test('a GitHub that could not be reached offers to ask it again', async () => {
		const opened = open(signedIn(), {
			kind: 'refused',
			refusal: 'network',
			message: 'GitHub could not be reached, so your repositories could not be read.'
		});
		await settle();

		press('connect-read-again');
		await settle();

		expect(opened.list).toHaveBeenCalledTimes(2);
	});

	// ⚠ **The step that would otherwise never end.** A listing read that throws rather than answering
	// leaves "asking GitHub…" on screen for ever, with a sentence under it and nothing to press.
	test('a listing read that threw is a refusal with a way on, not a step that never ends', async () => {
		open(signedIn(), new Error('The browser gave up on the request.'));
		await settle();

		expect(text(at('connect-choices-refused'))).toContain('gave up on the request');
		expect(absent('connect-loading-choices')).toBe(true);
		expect(at('connect-read-again')).toBeTruthy();
	});

	// The subset refusal does not connect, so the thing to do is choose a different repository — and
	// the list to choose it from is the control, still on screen beneath the refusal.
	test('a repository that was refused leaves the choice on screen', async () => {
		const storage = signedIn();
		storage.bindAnswer = new Error('ada/atlas holds Projects this Workspace has not got.');
		open(storage);
		await settle();

		press('choose-repository');
		await settle();

		expect(text(at('connect-problem'))).toContain('has not got');
		expect(at('choose-repository')).toBeTruthy();
	});

	// ⚠ **A decline on GitHub's own screen is judged on a document this component did not exist in**,
	// because the App sign-in replaces the page. Said only on the page behind, it is said behind the
	// dialog the return leg reopens.
	test('a sign-in GitHub declined is said inside the sequence, beside the way to start again', () => {
		connectSequence.signInRefusal = 'GitHub refused the sign-in, so nothing has been signed in to.';
		const opened = openPastAccount(new FakeStorage());

		expect(text(at('connect-sign-in-refused'))).toContain('GitHub refused the sign-in');
		press('connect-sign-in-with-github');
		expect(opened.storage.signInsBegun).toBe(1);
	});

	// ⚠ **The same decline lands on the `connected` step whenever the Workspace is already bound**, and
	// that is where the publish dialog's own door sends it: the door is a redirect off the page, so the
	// return leg reopens the sequence over a Workspace that has a Remote, which derives this step. Said
	// only on the page behind, the refusal would be behind the dialog the return leg reopens.
	test('a sign-in GitHub declined is said on the connected step too', async () => {
		connectSequence.signInRefusal = 'GitHub refused the sign-in, so nothing has been signed in to.';
		const storage = new FakeStorage();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		open(storage);
		await settle();

		expect(at('connect-connected')).toBeTruthy();
		expect(text(at('connect-sign-in-refused'))).toContain('GitHub refused the sign-in');
	});
});

describe('signing out, and changing where the work goes', () => {
	// The reason it is beside Close rather than in Workspace settings: somebody handing a lab machine
	// over is leaving, and leaving is the gesture they are already making.
	test('signs out from the sequence, and the account goes with the sign-in', async () => {
		const opened = open(signedIn());
		await settle();

		press('connect-sign-out');
		await settle();

		expect(opened.storage.signOuts).toBe(1);
		expect(opened.storage.credential).toBeNull();
		expect(opened.storage.identity).toBe('');
		// Back at the sign-in rather than at the beginning: somebody who had a credential has an account.
		expect(at('connect-sign-in')).toBeTruthy();
	});

	test('offers nothing to sign out of when nobody is signed in', () => {
		openPastAccount(new FakeStorage());

		expect(absent('connect-sign-out')).toBe(true);
	});

	// ⚠ **Connecting once is not permanent.** A Workspace with a Remote derives the connected step
	// from having one, so the way back to the choice has to be a press — and it lands on the same
	// listing, read again, rather than on a remembered one.
	test('a connected Workspace can choose a different repository', async () => {
		const storage = signedIn();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		const opened = open(storage, listed([{ ...ATLAS, repository: 'notebook' }]));

		press('change-repository');
		await settle();
		expect(at('connect-choosing')).toBeTruthy();

		press('choose-repository');
		await settle();

		expect(opened.storage.bindCalls).toEqual([
			{ remote: { owner: 'ada', repository: 'notebook' }, token: null }
		]);
	});

	// Closing forgets the asking, so a Workspace that has a Remote opens on the Remote it has.
	test('reopening a connected Workspace shows the repository it has', async () => {
		const storage = signedIn();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		const opened = open(storage);

		press('change-repository');
		await settle();
		press('close-connect-sequence');
		opened.props.open = true;
		flushSync();

		expect(at('connect-connected')).toBeTruthy();
	});
});

describe('reaching every step without sight and without a pointer', () => {
	// One region, in the document from the first frame, whose words change with the step — a region
	// inserted at the moment its text first exists is not reliably announced (ADR-0016).
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

	// `disabled` takes a control out of the tab order, so a keyboard user reaching the sequence
	// mid-flight would find the thing they were about to press simply gone (WCAG 2.4.3).
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
// that nothing the sequence writes for itself asks a student to learn any of it.
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
		['the account step', () => open(new FakeStorage())],
		['the sign-in step', () => openPastAccount(new FakeStorage())],
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

// ⚠ **The fork with no App of its own, which is the other half of "one door": where there is an
// App, one door; where there is not, the door that works.**
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

	// The deployment with an App is the other reading of the same fact, and it is the one a student
	// is on: the word never appears, so there are not two credentials to choose between.
	test('shows no token field at all where an App is configured', async () => {
		open(signedIn());
		await settle();

		expect(absent('connect-no-app')).toBe(true);
		expect(absent('connect-token-field')).toBe(true);
	});

	// The pasted path is the fork's whole door, so it has to reach the same bind the chosen
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

	// The fork-shaped half of the same offer: the one step the tool does not take arrives with the
	// name filled in, and the sentence beside it says the repository has to be public.
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

	// The announcement, in a sequence that has one step fewer: it counts the steps this door has
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

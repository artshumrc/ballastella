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

import { connectSequence } from '$lib/connect-sequence.svelte.js';

import ConnectToGitHub from './ConnectToGitHub.svelte';
import {
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

describe('which step the sequence shows', () => {
	// Story 7, and the derivation's first reading: no credential is the only fact that decides this.
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

	// ⚠ **Story 8's other half, which is what the mark is for.** The sign-in replaces the document, so
	// nothing the sequence holds in memory survives it — the mark is how the return leg knows to come
	// back here. That it really does come back is Seam 2's, since only a browser can perform the
	// redirect; that the mark is laid down at all is this seam's, and it is cheap.
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

describe('the student who has never heard of GitHub', () => {
	// ⚠ **Stories 3, 5 and 45, and the reason this step exists at all.** A student with no account
	// pressing "Sign in with GitHub" arrives at a screen they cannot complete, and the editor never
	// mentioned that an account was the prerequisite. So the prerequisite is the first thing said.
	test('says an account is needed, what it is for, and that it costs nothing', () => {
		open(new FakeStorage());

		const words = text(at('connect-needs-account'));
		expect(words).toContain('You need a GitHub account');
		expect(words).toContain('where your map will live');
		expect(words).toContain('free');
	});

	// Story 4: not having to go and find GitHub's sign-up is the whole of it. A second tab, so the
	// editor and the sequence are still there to come back to.
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

	// ⚠ **Story 6: making an account must not cost the author their place.** They leave for GitHub's
	// sign-up in a second tab, make an account, and come back — often to a reloaded editor — and the
	// step they land on is the sign-in rather than the sentence they have already read.
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
	// Story 33: every step offers the way out, including the ones in the middle of something.
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

	// ⚠ **Story 34, and it is the derivation that pays for it.** Nothing is remembered across a close,
	// so reopening reads the same facts and lands in the same place — and the listing is asked for
	// again, which is what makes a repository granted while the sequence was shut visible on return.
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

// SPEC story 63. A GitHub App's user token lasts eight hours, and one that has run out makes every
// later request fail — as a listing with nothing in it, or as a repository that refused the author.
// So the expiry is asked about the moment the sequence opens, before any of that can be misread.
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

// SPEC story 35, and the ticket's real work: **no state of this sequence is a full stop.** Each of
// these is a branch that can be reached, and each one has to name what to do and render the control
// that does it. A refusal whose only sequel is the Close button is the failure being tested for.
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
});

describe('signing out, and changing where the work goes', () => {
	// Story 10, and the reason it is beside Close rather than in Workspace settings: somebody handing
	// a lab machine over is leaving, and leaving is the gesture they are already making.
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

	// ⚠ **Story 62: connecting once is not permanent.** A Workspace with a Remote derives the connected
	// step from having one, so the way back to the choice has to be a press — and it lands on the same
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
});

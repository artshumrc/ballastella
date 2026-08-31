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
// happens before any bytes move, that Pages enablement degrades to a sentence naming both the
// permissions GitHub requires, and that the subset comparison
// is by Project directory are `bind-remote.ts`'s, there too. That the application actually wires
// this component to the real sign-in, the real bind and the real Publish is one test in
// `e2e/editor-github-signin.e2e.ts`, which is what keeps this file from asserting against a fake in
// isolation. The action being visible without scrolling is layout and is not asserted at any seam
// this file can reach.

import {
	authorizeUrl,
	RemoteBindRefusedError,
	resolveWorkspaceAddress,
	type AddressResolution,
	type GrantedInstallation,
	type GrantedRepositoriesOutcome,
	type GrantedRepository,
	type RemoteBindOutcome,
	type RemoteReference,
	type SynchronizationBaseline
} from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { connectSequence } from '$lib/connect-sequence.svelte.js';

import ConnectToGitHub, { CONNECT_STEPS, type Step } from './ConnectToGitHub.svelte';
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
	canGrantAccess: true,
	isPrivate: false
};

/**
 * The two reaches an Installation can have, on the account {@link signedIn} is signed in as.
 *
 * ⚠ **`NARROW` is the default here on purpose.** It is the state that has a grant step in it, so a
 * test that says nothing about reach is asserting the longer path — and a wide grant skipping that
 * step has to be asked for.
 */
const NARROW: GrantedInstallation = {
	id: 42,
	account: 'ada',
	targetId: 5150,
	isOrganization: false,
	coversEverything: false
};
const WIDE: GrantedInstallation = { ...NARROW, coversEverything: true };

const listed = (
	repositories: readonly GrantedRepository[] = [ATLAS],
	installations: readonly GrantedInstallation[] = [NARROW]
): GrantedRepositoriesOutcome => ({ kind: 'listed', repositories, installations });

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
	/** Every address the inbound door asked about, which is what "nothing is asked twice" reads. */
	readonly resolve: ReturnType<typeof vi.fn>;
	/** Writable, so a test can close the sequence and open it again without remounting it. */
	readonly props: SequenceProps;
};

/** What the address probe answers by default: the repository a Published Site's address means. */
const ATLAS_ADDRESS: AddressResolution = {
	kind: 'resolved',
	remote: { owner: 'ada', repository: 'atlas' },
	why: 'A published site at ada.github.io/atlas is usually the repository ada/atlas.'
};

/** Open the sequence over a Workspace in whatever state the caller has put the fake into. */
function open(
	storage: FakeStorage,
	answer: GrantedRepositoriesOutcome | Error | Promise<GrantedRepositoriesOutcome> = listed(),
	address: AddressResolution | Error | Promise<AddressResolution> = ATLAS_ADDRESS
): Opened {
	const list = vi.fn(async (token: string) => {
		void token;
		if (answer instanceof Error) throw answer;
		// ⚠ **Awaited only where there is something to wait for.** A promise is a listing GitHub has
		// not answered yet, which is the whole of the step that waits for one; awaiting an outcome
		// already in hand would cost every other test in this file a turn of {@link settle}.
		return answer instanceof Promise ? await answer : answer;
	});
	const onpublish = vi.fn();
	const resolve = vi.fn(async (pasted: string) => {
		void pasted;
		if (address instanceof Error) throw address;
		return address instanceof Promise ? await address : address;
	});
	const main = document.createElement('main');
	document.body.append(main);
	const props = sequenceProps({
		storage: storage as unknown as WorkspaceStorage,
		onpublish,
		list,
		resolveAddress: resolve
	});
	mounted = mount(ConnectToGitHub, { target: main, props });
	flushSync();
	return { storage, list, onpublish, resolve, props };
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

/**
 * The refusal that protects somebody's afternoon: the Remote carries a Project this Workspace has
 * not got, so publishing there would delete it (ADR-0033).
 *
 * ⚠ **The real class rather than a bare `Error`**, because which refusal it is decides what the
 * sequence offers — every other one goes back to the choice, and this one offers the Open. The
 * sentence is `bind-remote.ts`'s own, abbreviated only where the wording is not what is under test.
 */
const notHere = (): RemoteBindRefusedError =>
	new RemoteBindRefusedError(
		'projects-not-here',
		'ada/atlas already carries work from Ballastella, and “Amsterdam 1625” is a Project on it ' +
			'that this Workspace has not got. Publishing this Workspace there would delete it, so ' +
			'nothing has been bound. Open ada/atlas from GitHub instead: that brings the whole of it ' +
			'down into a new Workspace of its own, and never overwrites or merges anything you already ' +
			'have.'
	);

/** A promise a test settles by hand, so a request in flight is a state and not a race. */
function deferred<T>(): { readonly promise: Promise<T>; readonly settle: (value: T) => void } {
	let settle: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		settle = resolve;
	});
	return { promise, settle: (value: T) => settle(value) };
}

/** A store whose Open waits to be let go, which is the only way a transfer stays on screen. */
class PausedOpen extends FakeStorage {
	private readonly gate = deferred<void>();

	letGo(): void {
		this.gate.settle();
	}

	// Recorded and then held, rather than held and then recorded: what a paused Open has to make
	// visible is whether a second press started a second one, and a call not yet recorded looks
	// exactly like a call the screen refused to make.
	override async openFromGitHub(remote: RemoteReference): Promise<{ notice: string }> {
		const answering = super.openFromGitHub(remote);
		await this.gate.promise;
		return answering;
	}
}

/** Somebody signed in whose Open waits to be let go. */
function pausedOpen(): PausedOpen {
	const storage = new PausedOpen();
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
		const resolve = vi.fn(async (pasted: string) => {
			void pasted;
			return ATLAS_ADDRESS;
		});
		const storage = signedIn();
		const main = document.createElement('main');
		document.body.append(main);
		const props = sequenceProps({
			storage: storage as unknown as WorkspaceStorage,
			onpublish,
			list,
			resolveAddress: resolve
		});
		mounted = mount(ConnectToGitHub, { target: main, props });
		flushSync();
		await settle();
		pressLink('create-repository');
		answer = then;
		return { storage, list, onpublish, resolve, props };
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
	test('names all three things to do, in the order that works, under a narrow grant', async () => {
		await leaveToCreate(nothing());

		expect(at('connect-creating')).toBeTruthy();
		const steps = [...document.querySelectorAll('[data-testid="creating-instruction"]')].map(text);
		expect(steps).toHaveLength(3);
		expect(steps[0]).toContain('has to be public');
		expect(steps[1]).toContain('give Ballastella access to it');
		expect(steps[2]).toContain('Come back to this tab');
	});

	/**
	 * ⚠ **Two screens, and the copy says which is which.** `github.com/new` has no such control on it,
	 * so an instruction to grant access "on the same screen" names a place the thing cannot be done —
	 * which is the wall this epic was reported from.
	 */
	test('never says the grant happens on the screen the repository is made on', async () => {
		await leaveToCreate(nothing());

		const steps = [...document.querySelectorAll('[data-testid="creating-instruction"]')].map(text);
		expect(steps.join(' ')).not.toContain('the same screen');
		expect(steps[1]).toContain('second screen');
	});

	// Where the author has to ask somebody, the instruction says so rather than telling them to do a
	// thing GitHub will not let them do.
	test('tells a non-admin to ask, in the instructions as well as in the alert', async () => {
		await leaveToCreate(
			listed(
				[{ ...ATLAS, owner: 'harvard', canGrantAccess: false }],
				[{ ...NARROW, id: 9, account: 'harvard', targetId: 606, isOrganization: true }]
			)
		);

		const steps = [...document.querySelectorAll('[data-testid="creating-instruction"]')].map(text);
		expect(steps).toHaveLength(3);
		expect(steps[1]).toContain('admin');
	});

	/**
	 * The smooth path, which is the common one.
	 *
	 * ⚠ **Absent rather than quiet.** An Installation GitHub reports as covering everything covers a
	 * repository made a moment ago, so a step telling the author to go and grant access to it names
	 * work that does not exist — and the link would take them to a screen with nothing to change on
	 * it, which reads as the tool being wrong about what it can see.
	 */
	test('asks for nothing but the repository when the grant already covers everything', async () => {
		await leaveToCreate(listed([], [WIDE]));

		expect(at('connect-creating')).toBeTruthy();
		const steps = [...document.querySelectorAll('[data-testid="creating-instruction"]')].map(text);
		expect(steps).toHaveLength(2);
		expect(steps[0]).toContain('has to be public');
		expect(steps[1]).toContain('Come back to this tab');
		expect(steps.join(' ')).not.toContain('access');
		expect(absent('grant-access')).toBe(true);
	});

	// The step the wide grant skips must not come back through the door the unchanged listing opens.
	test('offers no way to grant access after a re-read that changed nothing, under a wide grant', async () => {
		await leaveToCreate(listed([], [WIDE]));

		press('reread-repositories');
		await settle();

		expect(at('connect-creating')).toBeTruthy();
		expect(absent('grant-access')).toBe(true);
		expect(absent('created-not-granted')).toBe(true);
		// Silence would read as the press having done nothing, so the re-read still reports itself —
		// it just does not blame a grant that is not missing.
		expect(text(at('created-not-listed'))).not.toContain('access');
	});

	/**
	 * A wide Installation on somebody else's account says nothing about the author's own repositories.
	 *
	 * The repository is being made at `github.com/new`, which makes it under the account signed in —
	 * so the reach that matters is that account's, and an organisation that granted everything is a
	 * different question that this step must not answer with.
	 */
	test('keeps the grant step when only another account’s grant is the wide one', async () => {
		await leaveToCreate(
			listed([], [NARROW, { ...WIDE, id: 9, account: 'harvard', isOrganization: true }])
		);

		const steps = [...document.querySelectorAll('[data-testid="creating-instruction"]')].map(text);
		expect(steps).toHaveLength(3);
		expect(steps[1]).toContain('give Ballastella access to it');
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
			`https://github.com/apps/${FAKE_APP.appSlug}/installations/new/permissions` +
				`?suggested_target_id=${NARROW.targetId}`
		);
		expect(absent('repository-choice-empty')).toBe(true);
	});

	/**
	 * ⚠ **The account's own identifier, so GitHub opens on the Installation that has to change.**
	 * The address this replaced was the list of every App the author had ever installed, from which
	 * the grant is five moves away — and the copy called it "your Ballastella settings", which it was
	 * not.
	 */
	test('sends the grant to the App’s own screen and never to the list of installed Apps', async () => {
		await leaveToCreate(nothing());

		press('reread-repositories');
		await settle();

		const url = new URL(at('grant-access').getAttribute('href') ?? '');
		expect(url.pathname).toBe(`/apps/${FAKE_APP.appSlug}/installations/new/permissions`);
		expect(url.searchParams.get('suggested_target_id')).toBe(String(NARROW.targetId));
	});

	/**
	 * ⚠ **Sending somebody to a screen they can accomplish nothing on is the failure this replaced.**
	 * `permissions.admin` is what says whether widening a narrow grant is theirs to do: every write
	 * collaborator and every organisation member who is not an admin has to ask instead, and a link
	 * offered to them would be the old dead end wearing a better address.
	 */
	test('offers no link, and names the admin, where widening the grant is not the author’s', async () => {
		await leaveToCreate(
			listed(
				[{ ...ATLAS, owner: 'harvard', canGrantAccess: false }],
				[{ ...NARROW, id: 9, account: 'harvard', targetId: 606, isOrganization: true }]
			)
		);

		press('reread-repositories');
		await settle();

		expect(absent('grant-access')).toBe(true);
		expect(text(at('created-not-granted'))).toContain('admin');
	});

	// The same organisation, with the author administering something inside it: theirs to widen, so
	// the link is offered rather than an instruction to ask themselves.
	test('offers the link where the author administers the organisation’s repositories', async () => {
		await leaveToCreate(
			listed(
				[{ ...ATLAS, owner: 'harvard', canGrantAccess: true }],
				[{ ...NARROW, id: 9, account: 'harvard', targetId: 606, isOrganization: true }]
			)
		);

		press('reread-repositories');
		await settle();

		expect(at('grant-access').getAttribute('href')).toBe(
			`https://github.com/apps/${FAKE_APP.appSlug}/installations/new/permissions` +
				`?suggested_target_id=606`
		);
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
	// and no credential of its own — so the rights check is the existing code's, performed inside it,
	// and there is no second path to it.
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

	// ⚠ **Story 137.** Turning a site on is a question about who may read this, and connecting is not
	// the moment it is asked — so a connection that worked says nothing about it at all, and the
	// author is never handed a paragraph about a permission in answer to a question they have not
	// asked.
	test('asks nothing of Pages, and says nothing about it', async () => {
		const storage = signedIn();
		open(storage);
		await choose();

		expect(storage.pagesAsks).toBe(0);
		expect(absent('connect-notice')).toBe(true);
		expect(said()).not.toContain('Pages');
	});

	// The rights refusal is the other outcome the connection stands *with*, and it is deliberate: the
	// binding records where this Workspace belongs whether or not this author may publish there.
	//
	// ⚠ **One statement, not two.** `bind-remote`'s own `rightsNotice` is the same fact as the
	// connected step's pull-only sentence, and this epic exists because one question had five answers
	// on one screen — so the notice is suppressed and the standing statement is what the author reads
	// (ADR-0043). It is also the only one of the two that renders on a hydrated Remote, where no bind
	// happened at all.
	test('reports that the author cannot publish there, and stays connected', async () => {
		const storage = signedIn();
		storage.bindAnswer = outcome({
			canPush: false,
			rightsNotice: 'This token cannot push to ada/atlas, so publishing to it will be refused.'
		});
		open(storage);
		await choose();

		expect(text(at('pull-only-remote'))).toContain('you cannot publish to it');
		expect(absent('connect-notice')).toBe(true);
		expect(at('connect-connected')).toBeTruthy();
	});

	// ⚠ **This one is a refusal and must never soften into a warning.** Publishing over a Remote
	// carrying Projects this Workspace has not got would delete them, so the Projects are named and
	// the connection does not happen. What the author is offered instead is the operation that
	// answers their actual question, which is the next block.
	test('refuses a repository whose work publishing would destroy, and names it', async () => {
		const storage = signedIn();
		storage.bindAnswer = notHere();
		open(storage);
		await choose();

		expect(text(at('connect-projects-not-here'))).toContain('“Amsterdam 1625”');
		expect(storage.remote).toBeNull();
		expect(absent('connect-connected')).toBe(true);
	});
});

// ⚠ **Arriving on a second device stops being a refusal and becomes an answer.** The refusal itself
// is not softened — publishing over that Remote would delete somebody's work — but the author asked
// *"is this my repository"*, and the honest answer is to bring it down into a Workspace of its own.
// The operation is `openFromGitHub`, unchanged: no credential, always browser-backed, one Workspace
// per repository. What this block asserts is that the door offers it, hands it the repository the
// author chose, and gets out of the way of what it says.
describe('a repository carrying work this Workspace has not got', () => {
	/** Choose the one repository on offer, which is what meets the refusal. */
	async function refused(storage: FakeStorage = signedIn()): Promise<Opened> {
		storage.bindAnswer = notHere();
		const opened = open(storage);
		await settle();
		press('choose-repository');
		await settle();
		return opened;
	}

	test('names the work that is on it and offers to open it as a Workspace of its own', async () => {
		await refused();

		// `packages/core`'s own sentence, rendered as it arrives: it names the Project, says what
		// publishing there would do, and is not this component's to reword.
		expect(text(at('connect-projects-not-here'))).toContain('“Amsterdam 1625”');
		expect(text(at('connect-projects-not-here'))).toContain('would delete');
		expect(at('open-as-new-workspace')).toBeTruthy();
	});

	// ⚠ **The repository and nothing else.** No credential is sent on this path and none is read, so
	// what the press hands over is the reference the author chose — the same call the address field
	// in Remote settings makes, reached from where the question was actually asked.
	test('hands the chosen repository to the Open, once', async () => {
		const opened = await refused();

		press('open-as-new-workspace');
		await settle();

		expect(opened.storage.openCalls).toEqual([{ owner: 'ada', repository: 'atlas' }]);
	});

	// ⚠ **It only adds.** The connection did not happen, so nothing about this Workspace changed —
	// and the Open makes a second Workspace beside it rather than touching this one. That the bytes
	// really are untouched is Seam 2's, where there is a store to snapshot.
	test('binds nothing and unbinds nothing on the way', async () => {
		const opened = await refused();

		press('open-as-new-workspace');
		await settle();

		expect(opened.storage.bindCalls).toHaveLength(1);
		expect(opened.storage.unbinds).toBe(0);
	});

	test('says which Workspace the author is now in', async () => {
		const opened = await refused();
		opened.storage.openAnswer = { notice: 'Opened ada/atlas into a new Workspace called “atlas”.' };

		press('open-as-new-workspace');
		await settle();

		expect(text(at('connect-notice'))).toContain('a new Workspace called “atlas”');
	});

	// ⚠ **One repository, one Workspace on this computer.** Opening one that has already been opened
	// here goes back to it rather than downloading a second copy, and the sentence saying so is the
	// engine's — so all the door owes it is somewhere to be read.
	test('reports a return to the Workspace this computer already keeps for it', async () => {
		const opened = await refused();
		opened.storage.openAnswer = {
			notice:
				'Went back to “atlas”, which is the Workspace this computer already keeps for ada/atlas.'
		};

		press('open-as-new-workspace');
		await settle();

		expect(text(at('connect-notice'))).toContain('Went back to “atlas”');
	});

	// A Map Image's pyramid is thousands of files over real minutes, and a still screen with nothing
	// said is where a scholar concludes it has hung.
	test('announces per-file progress while it runs', async () => {
		const storage = pausedOpen();
		await refused(storage);

		press('open-as-new-workspace');
		await settle();
		storage.transfer = {
			kind: 'open',
			subject: 'ada/atlas',
			files: 12,
			totalFiles: 40,
			finished: false
		};
		flushSync();

		expect(text(at('hydrate-progress'))).toContain('12 of 40');
		expect(at('hydrate-progress').getAttribute('role')).toBe('status');
		// ⚠ `aria-disabled` and never `disabled`: a `disabled` button leaves the tab order the moment
		// it is pressed, dropping a keyboard user to `<body>` for the length of a download that runs
		// in minutes (WCAG 2.4.3).
		expect(at('open-as-new-workspace').getAttribute('aria-disabled')).toBe('true');
		expect((at('open-as-new-workspace') as HTMLButtonElement).disabled).toBe(false);

		storage.letGo();
		await settle();
	});

	// ⚠ **A second press is not a second download.** The engine serializes Opens of one repository,
	// so the worst case is a wasted request rather than two Workspaces — but the screen must not
	// invite it either.
	test('does not start a second Open while one is running', async () => {
		const storage = pausedOpen();
		await refused(storage);

		press('open-as-new-workspace');
		await settle();
		press('open-as-new-workspace');
		await settle();

		expect(storage.openCalls).toHaveLength(1);
		storage.letGo();
		await settle();
	});

	// Not a dead end either: an Open that refused says why, and the offer it refused is still there
	// to press again beside the way back to the list.
	test('an Open that refused leaves both ways forward on screen', async () => {
		const opened = await refused();
		opened.storage.openAnswer = new Error(
			'GitHub could not be reached, so nothing was downloaded.'
		);

		press('open-as-new-workspace');
		await settle();

		expect(text(at('connect-problem'))).toContain('could not be reached');
		expect(at('open-as-new-workspace')).toBeTruthy();
		expect(at('choose-another-repository')).toBeTruthy();
	});

	test('goes back to the list for an author who wants a different repository', async () => {
		await refused();

		press('choose-another-repository');
		await settle();

		expect(at('connect-choosing')).toBeTruthy();
		expect(absent('connect-projects-not-here')).toBe(true);
	});

	// The offer is a fact about a press, so closing forgets it: reopening reads the world again, and
	// the world says this Workspace is unconnected.
	test('forgets the offer when the sequence is closed', async () => {
		const opened = await refused();

		press('close-connect-sequence');
		opened.props.open = true;
		flushSync();
		await settle();

		expect(absent('connect-projects-not-here')).toBe(true);
		expect(at('connect-choosing')).toBeTruthy();
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

// ⚠ **A Remote is a place the work lives before it is a site anybody reads** (stories 136 and 137).
// Turning a Published Site on is offered here, once, after the connection is made and never during
// it — and its refusal names both the permissions GitHub actually requires, so an author is not sent
// to grant the one they already granted. The sentence itself is `bind-remote.ts`'s at Seam 1; what
// is here is that a press asks for it, that the answer is rendered, and that nothing asks before the
// press.
describe('letting other people see it, which is a later act', () => {
	/** A Workspace already connected to `ada/atlas`, which is the connected step's whole input. */
	function connected(): FakeStorage {
		const storage = signedIn();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		return storage;
	}

	// ⚠ **The connected step and nowhere else.** There is no site to turn on before there is a
	// repository to serve it, and the address the offer names would name nothing.
	test.each([
		['the sign-in step', () => openPastAccount(new FakeStorage())],
		['the choice step', () => open(signedIn())]
	])('is not offered on %s', async (_name, arrange) => {
		arrange();
		await settle();

		expect(absent('enable-pages')).toBe(true);
	});

	test('offers it on the connected step, and asks GitHub nothing until it is pressed', () => {
		const storage = connected();
		open(storage);

		expect(at('enable-pages')).toBeTruthy();
		expect(storage.pagesAsks).toBe(0);
		expect(absent('pages-notice')).toBe(true);
	});

	test('asks for it once when pressed, and says the site will answer', async () => {
		const storage = connected();
		open(storage);

		press('enable-pages');
		await settle();

		expect(storage.pagesAsks).toBe(1);
		expect(text(at('pages-enabled'))).toContain('https://ada.github.io/atlas/');
		// Done once and done: the offer goes, because pressing it again asks GitHub to turn on
		// something that is already on.
		expect(absent('enable-pages')).toBe(true);
	});

	// ⚠ **Both permissions, and the offer stays.** ADR-0040 refuses `Administration` for the App, so
	// this is the ordinary answer rather than a rare one — and an author who has just granted it by
	// hand needs the press to still be there.
	test('renders the refusal, keeps the offer, and stays connected', async () => {
		const storage = connected();
		storage.pagesAnswer = {
			enabled: false,
			instruction:
				'GitHub Pages could not be turned on for ada/atlas — that needs both “Pages: Read and ' +
				'write” and “Administration: Read and write”, and this credential does not have them.'
		};
		open(storage);

		press('enable-pages');
		await settle();

		const notice = text(at('pages-notice'));
		expect(notice).toContain('Pages: Read and write');
		expect(notice).toContain('Administration: Read and write');
		expect(at('enable-pages')).toBeTruthy();
		expect(at('connect-connected')).toBeTruthy();
	});

	// The one thing `enablePages` throws over is a credential that is not there, and it is a refusal
	// about this press rather than about the connection, which stands.
	test('says why it could not be asked at all, and stays connected', async () => {
		const storage = connected();
		storage.pagesAnswer = new Error('Sign in with GitHub first.');
		open(storage);

		press('enable-pages');
		await settle();

		expect(text(at('connect-problem'))).toContain('Sign in with GitHub first.');
		expect(at('connect-connected')).toBeTruthy();
	});

	// ⚠ **What a close must not leave behind**, for the same reason the bind notices must not: the
	// answer is about the Workspace that was on screen, and the next one opened may be another.
	test('leaves no answer of its own behind on a close', async () => {
		const storage = connected();
		const opened = open(storage);
		press('enable-pages');
		await settle();
		expect(at('pages-enabled')).toBeTruthy();

		press('close-connect-sequence');
		opened.props.open = true;
		flushSync();

		expect(absent('pages-enabled')).toBe(true);
		expect(at('enable-pages')).toBeTruthy();
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

	// ⚠ **Said once, and the saying is the whole of what is kept.** The step states a prerequisite
	// nothing can read, so an author who has answered it must not be asked again by a close, a reopen
	// or the reload that coming back from GitHub so often is — and it is a hint rather than a
	// position, so it is this tab's: the next student at this machine starts from the beginning.
	test('is offered once to a tab, and again to the next one', () => {
		const opened = open(new FakeStorage());
		press('connect-have-account');
		expect(at('connect-sign-in')).toBeTruthy();

		press('close-connect-sequence');
		opened.props.open = true;
		flushSync();
		expect(at('connect-sign-in')).toBeTruthy();

		unmount(mounted!);
		mounted = undefined;
		document.body.innerHTML = '';
		open(new FakeStorage());
		expect(at('connect-sign-in')).toBeTruthy();
		expect(absent('connect-needs-account')).toBe(true);

		// A lab machine handed over: a tab that never made the press starts where everybody starts.
		sessionStorage.clear();
		unmount(mounted!);
		mounted = undefined;
		document.body.innerHTML = '';
		open(new FakeStorage());

		expect(at('connect-needs-account')).toBeTruthy();
	});

	// ⚠ **A held credential overrules the hint, so the one thing remembered can never hold the
	// sequence behind where reality has got to.** Somebody signed in has answered the question by
	// being signed in, whether or not they ever saw this step — and giving the credential up is a step
	// back to the sign-in rather than to the beginning, because having had one is still having an
	// account.
	test('is overruled by a held credential, and does not come back when one is given up', async () => {
		const opened = open(signedIn());
		await settle();
		expect(absent('connect-needs-account')).toBe(true);

		press('connect-sign-out');
		await settle();

		expect(opened.storage.signOuts).toBe(1);
		expect(at('connect-sign-in')).toBeTruthy();
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

// ⚠ **The one path through this sequence that needs no account at all** (ADR-0031, ADR-0043). A
// student opening their instructor's published Workspace is the likeliest thing this tool is asked
// to do, and a door whose first step is signing in locks exactly that person out of it.
describe('opening somebody else’s published Workspace, by its address', () => {
	test.each([
		['the account step', () => open(new FakeStorage())],
		['the sign-in step', () => openPastAccount(new FakeStorage())]
	])('is offered on %s, before any sign-in', (_name, arrange) => {
		arrange();

		expect(at('open-by-address')).toBeTruthy();
	});

	// Signing in *adds* the author's own repositories beside this; it never takes it away.
	test('is still offered once the author is signed in', async () => {
		open(signedIn());
		await settle();

		expect(at('connect-choosing')).toBeTruthy();
		expect(at('open-by-address')).toBeTruthy();
	});

	// ⚠ **Nothing is asked of GitHub about the author.** The listing read needs a credential and this
	// step needs none, so a student with no account reaches the field without one being wanted.
	test('is reached signed out, with nothing asked about the author’s own repositories', () => {
		const { storage, list } = open(new FakeStorage());

		press('open-by-address');

		expect(at('connect-by-address')).toBeTruthy();
		expect(storage.signedIn).toBe(false);
		expect(list).not.toHaveBeenCalled();
	});

	// ⚠ **The confirmation is what stands between an address and a download of gigabytes**, and an
	// ambiguous Pages address has two real answers — so the repository that was chosen is named, with
	// why, and nothing is transferred until somebody says yes.
	test('names the repository it resolved, and downloads nothing until that is confirmed', async () => {
		const { storage, resolve } = open(new FakeStorage());
		press('open-by-address');

		fill('workspace-address-field', 'ada.github.io/atlas');
		press('find-workspace-address');
		await settle();

		expect(resolve).toHaveBeenCalledWith('ada.github.io/atlas');
		expect(text(at('resolved-address'))).toContain('ada/atlas');
		expect(text(at('resolved-address-why'))).toContain('ada/atlas');
		expect(storage.openCalls).toEqual([]);

		press('open-resolved-address');
		await settle();

		expect(storage.openCalls).toEqual([{ owner: 'ada', repository: 'atlas' }]);
		expect(text(at('connect-notice'))).toContain('new Workspace');
	});

	// The other answer to the confirmation, which is what makes it one: the address is ambiguous and
	// the author is the one who knows which repository they meant.
	test('takes “that is not it” back to the address', async () => {
		open(new FakeStorage());
		press('open-by-address');
		fill('workspace-address-field', 'ada.github.io/atlas');
		press('find-workspace-address');
		await settle();

		press('reject-resolved-address');

		expect(absent('resolved-address')).toBe(true);
		expect(at('workspace-address-field')).toBeTruthy();
	});

	// ⚠ **`packages/core`'s own sentence, over the real probe**, which spends no request at all on an
	// address it can produce no candidate for. A site on an address of its own cannot be traced back
	// to the repository behind it, and the refusal has to say what to paste instead.
	test('refuses a custom domain by naming what to paste instead', async () => {
		open(new FakeStorage(), listed(), resolveWorkspaceAddress('https://maps.example.org/atlas'));
		press('open-by-address');

		fill('workspace-address-field', 'https://maps.example.org/atlas');
		press('find-workspace-address');
		await settle();

		expect(text(at('workspace-address-refused'))).toContain('owner/repository');
		expect(absent('resolved-address')).toBe(true);
	});

	// No step of this sequence is a full stop, and that includes the one somebody pressed by mistake.
	test('goes back to the step the world says the author is on', () => {
		open(new FakeStorage());
		press('open-by-address');

		press('leave-by-address');

		expect(at('connect-needs-account')).toBeTruthy();
	});

	// The step is a press, not a position: closing forgets it, and reopening reads the world again.
	test('is forgotten on a close, along with what was typed into it', async () => {
		const opened = open(new FakeStorage());
		press('open-by-address');
		fill('workspace-address-field', 'ada.github.io/atlas');

		press('close-connect-sequence');
		opened.props.open = true;
		flushSync();
		await settle();

		expect(at('connect-needs-account')).toBeTruthy();
		press('open-by-address');
		expect((at('workspace-address-field') as HTMLInputElement).value).toBe('');
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

	// ⚠ **What a close must not leave behind.** The notice from a connection made a moment ago says
	// nothing about the Workspace whoever opens the sequence next is looking at.
	test('leaves no notice from the last time behind it', async () => {
		const storage = signedIn();
		const opened = open(storage);
		await settle();
		press('choose-repository');
		await settle();
		// Giving the repository up leaves a sentence behind saying what it did and did not do, which is
		// as good a notice as any and one the connected step actually produces.
		press('unbind-remote');
		await settle();
		expect(text(at('connect-notice'))).toContain('no longer publishes to ada/atlas');

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

	// ⚠ **One event, two screens, and folding them would lose the difference that matters.** A sign-in
	// that has run out is met in two places — before any work starts, which is this step, and by the
	// listing read, which is `choices-refused` — and GitHub says much the same sentence about both. It
	// is what surrounds the sentence that tells an author which of the two they are in, so the two
	// steps and the two announcements have to stay two even when the sentence is one.
	test('is its own screen and its own announcement, beside a listing GitHub would not answer', async () => {
		const ENDED = 'Your GitHub sign-in has ended. Sign in to GitHub again to carry on.';

		const storage = signedIn();
		storage.expiry = new Error(ENDED);
		open(storage);
		await settle();

		expect(text(at('connect-expiry'))).toBe(ENDED);
		expect(absent('connect-refused-choices')).toBe(true);
		const asAnExpiry = text(at('connect-step'));

		unmount(mounted!);
		mounted = undefined;
		document.body.innerHTML = '';
		sessionStorage.clear();

		open(signedIn(), { kind: 'refused', refusal: 'credential', message: ENDED });
		await settle();

		expect(text(at('connect-choices-refused'))).toBe(ENDED);
		expect(absent('connect-sign-in-ended')).toBe(true);
		// The same sentence, in two steps a reader who cannot see the screen still tells apart.
		expect(text(at('connect-step'))).not.toBe(asAnExpiry);
		expect(asAnExpiry).toContain('sign-in has ended');
		expect(text(at('connect-step'))).toContain('could not be read');
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

	// A refusal that is about the repository rather than about what is on it does not connect, so the
	// thing to do is choose a different one — and the list to choose it from is the control, still on
	// screen beneath the refusal. The one refusal with an operation of its own is the subset refusal,
	// which has a step.
	test('a repository that was refused leaves the choice on screen', async () => {
		const storage = signedIn();
		storage.bindAnswer = new RemoteBindRefusedError(
			'no-repository',
			'GitHub has no repository at ada/atlas, or none this sign-in can see.'
		);
		open(storage);
		await settle();

		press('choose-repository');
		await settle();

		expect(text(at('connect-problem'))).toContain('no repository at ada/atlas');
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

// ⚠ **Two claims about *every* branch, enumerated rather than sampled.** No step of this sequence may
// be a dead end, and no step may say GitHub's own word for the per-account list. Both are properties
// of the whole union, so a thirteenth step added without them is the regression worth catching —
// which is why `CONNECT_STEPS` is a list the component exports and this table is keyed by it. A step
// added to the union and not to the table does not compile.
describe('every step of the sequence, enumerated', () => {
	/**
	 * A step reached, with the request it is waiting on where it is waiting on one.
	 *
	 * `answers` is present for the two steps the author passes *through* rather than lands on — a
	 * listing GitHub has not replied to, and a connection under way. Neither has anything to press,
	 * and what makes that not a dead end is that both end.
	 */
	type Arrived = { readonly answers?: () => Promise<void> };

	/** A store whose bind waits to be let go, which is the only way `connecting` stays on screen. */
	class PausedBind extends FakeStorage {
		private readonly gate = deferred<void>();

		letGo(): void {
			this.gate.settle();
		}

		override async bindRemote(
			remote: RemoteReference,
			token: string | null
		): Promise<RemoteBindOutcome> {
			await this.gate.promise;
			return super.bindRemote(remote, token);
		}
	}

	const RAN_OUT = 'Your GitHub sign-in has expired, so nothing has been published.';
	const COULD_NOT_BE_READ = 'GitHub could not be reached, so your repositories could not be read.';

	const reach: Record<Step, { readonly shows: string; readonly go: () => Promise<Arrived> }> = {
		legacy: {
			shows: 'connect-legacy',
			go: async () => {
				const storage = new FakeStorage();
				storage.legacyRemote = { owner: 'ada', repository: 'atlas', branch: 'main' };
				open(storage);
				return {};
			}
		},
		'by-address': {
			shows: 'connect-by-address',
			go: async () => {
				open(new FakeStorage());
				press('open-by-address');
				return {};
			}
		},
		'no-app': {
			shows: 'connect-no-app',
			go: async () => {
				open(noApp());
				return {};
			}
		},
		'needs-account': {
			shows: 'connect-needs-account',
			go: async () => {
				open(new FakeStorage());
				return {};
			}
		},
		'needs-sign-in': {
			shows: 'connect-sign-in',
			go: async () => {
				openPastAccount(new FakeStorage());
				return {};
			}
		},
		'sign-in-ended': {
			shows: 'connect-sign-in-ended',
			go: async () => {
				const storage = signedIn();
				storage.expiry = new Error(RAN_OUT);
				open(storage);
				await settle();
				return {};
			}
		},
		'loading-choices': {
			shows: 'connect-loading-choices',
			go: async () => {
				const held = deferred<GrantedRepositoriesOutcome>();
				open(signedIn(), held.promise);
				await settle();
				return {
					answers: async () => {
						held.settle(listed());
						await settle();
					}
				};
			}
		},
		choosing: {
			shows: 'connect-choosing',
			go: async () => {
				// Every mark the list has, because the reasons a row cannot be chosen are the sentences
				// on this step most likely to reach for a word off GitHub's own screens.
				open(
					signedIn(),
					listed([
						ATLAS,
						{ ...ATLAS, repository: 'notebook', canPublish: false },
						{ ...ATLAS, repository: 'diary', isPrivate: true }
					])
				);
				await settle();
				return {};
			}
		},
		'no-choices': {
			shows: 'connect-no-choices',
			go: async () => {
				open(signedIn(), listed([]));
				await settle();
				return {};
			}
		},
		'choices-refused': {
			shows: 'connect-refused-choices',
			go: async () => {
				open(signedIn(), { kind: 'refused', refusal: 'network', message: COULD_NOT_BE_READ });
				await settle();
				return {};
			}
		},
		creating: {
			shows: 'connect-creating',
			go: async () => {
				open(signedIn());
				await settle();
				pressLink('create-repository');
				// Looked again and found the same list, which is the step at its fullest: the
				// instructions, the outstanding step named, and the way to put it right.
				press('reread-repositories');
				await settle();
				return {};
			}
		},
		connecting: {
			shows: 'connect-connecting',
			go: async () => {
				const storage = new PausedBind();
				storage.signedIn = true;
				storage.identity = 'ada';
				storage.credential = 'a-credential-this-component-never-renders';
				open(storage);
				await settle();
				press('choose-repository');
				return {
					answers: async () => {
						storage.letGo();
						await settle();
					}
				};
			}
		},
		hydrate: {
			shows: 'connect-projects-not-here',
			go: async () => {
				const storage = signedIn();
				storage.bindAnswer = notHere();
				open(storage);
				await settle();
				press('choose-repository');
				await settle();
				return {};
			}
		},
		connected: {
			shows: 'connect-connected',
			go: async () => {
				const storage = signedIn();
				storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
				open(storage);
				await settle();
				return {};
			}
		}
	};

	/**
	 * Everything inside the sequence a person can press or type into.
	 *
	 * Close is outside it, in the dialog's own actions, and so is Sign out — which is the point: a
	 * step whose only sequel is Close reads as an empty list here.
	 */
	const controls = (): string[] =>
		[
			...at('connect-sequence').querySelectorAll<HTMLElement>(
				'button, a[href], input, select, textarea'
			)
		].map((one) => one.dataset.testid ?? one.tagName.toLowerCase());

	// ⚠ **The failure this is for**: a branch that says what went wrong and leaves the author holding
	// a dialog whose only button shuts it. A step that is a request in flight has nothing to press,
	// and it earns that by ending — the answer arrives and the sequence moves to a step that does.
	test.each([...CONNECT_STEPS])(
		'%s renders something to do, or is a request that answers',
		async (step) => {
			const { shows, go } = reach[step];
			const { answers } = await go();
			expect(at(shows)).toBeTruthy();

			if (answers === undefined) {
				expect(controls()).not.toEqual([]);
				return;
			}
			await answers();
			expect(absent(shows)).toBe(true);
			expect(controls()).not.toEqual([]);
		}
	);

	// ⚠ **The word this Epic exists to stop saying.** The wall an author hit was the App's
	// Installation — a per-account list of repositories the interface had never mentioned — and the
	// remedy is not to explain it but to describe what Ballastella can see, in a sentence the author
	// can act on. `Installation` stays a term the codebase needs and the author never meets.
	//
	// Every step, including the ones carrying a sentence `packages/core` composed: those name a
	// setting on GitHub's own screens and are not this component's to reword, and none of them says
	// any of these either.
	const GITHUB_VOCABULARY = ['installation', 'installations', 'grant', 'permission'];

	/**
	 * ⚠ **Every landing the door can present, reachable by keyboard** (user story 128).
	 *
	 * The Seam 2 pass tabs through the *connected* landing end to end, which is the one property no
	 * single surface can see; what it cannot afford is a boot per landing. This is the fence for the
	 * other twelve, and it is drawn where reach is actually won or lost in this codebase: a control
	 * spelled as a `<div>` with a role, or taken out of the tab order with `tabindex="-1"`, is
	 * unreachable however it looks — and a native element with no accessible name is a stop a screen
	 * reader announces as nothing at all.
	 *
	 * The name computation here is `dom-accessibility-api`'s approximation and not an accessibility
	 * tree (see this project's own header), so this is a fence against an unnamed control and not the
	 * only home of any naming claim.
	 */
	test.each([...CONNECT_STEPS])(
		'%s puts every control it renders in the tab order, with a name on each',
		async (step) => {
			const { answers } = await reach[step].go();
			if (answers !== undefined) await answers();

			const sequence = at('connect-sequence');
			expect(
				sequence.querySelectorAll('[role="button"], [role="link"], [tabindex="-1"]')
			).toHaveLength(0);
			const named = [
				...sequence.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea')
			];
			expect(named.length).toBeGreaterThan(0);
			for (const control of named) expect(control).toHaveAccessibleName();
		}
	);

	test.each([...CONNECT_STEPS])('%s says none of GitHub’s words for it', async (step) => {
		await reach[step].go();

		const words = said().toLowerCase();
		expect(GITHUB_VOCABULARY.filter((word) => words.includes(word))).toEqual([]);
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

// ⚠ **The whole GitHub relationship is behind one control, and the two gestures stay two presses**
// (ADR-0041). A Publish mirrors an owned namespace and removes Projects the author deleted locally;
// an Update can remove work from the Workspace. Those consequences differ in kind, so what is
// unified is the place and never the act — and both of them close this surface on the press, because
// what they say is said by the badge in the bar and a `showModal()` dialog makes the bar inert.
describe('the standing state, and the gestures on it', () => {
	/** A Workspace connected to `ada/atlas`, which is the connected step's whole input. */
	function connected(): FakeStorage {
		const storage = signedIn();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		return storage;
	}

	const baseline = (files: readonly string[]): SynchronizationBaseline => ({
		remote: { owner: 'ada', repository: 'atlas', branch: 'main' },
		commit: 'c0ffeec0ffee',
		files: new Map(files.map((path) => [path, 'aaaa']))
	});

	test('states what this Workspace and GitHub last agreed on', () => {
		const storage = connected();
		storage.baseline = baseline(['amsterdam-1625/project.json', 'base-map/style.json']);
		open(storage);

		expect(text(at('remote-baseline'))).toContain('c0ffeec0ffee');
		expect(text(at('remote-baseline'))).toContain('2 files');
	});

	// ⚠ **`Cannot tell` is a determination rather than a silence** (ADR-0038). A Workspace whose
	// Remote nothing here has evidence about must not read as one that agrees with it.
	test('says so in words when there is no record of an agreement', () => {
		open(connected());

		expect(text(at('remote-baseline'))).toContain('Cannot tell what has changed');
	});

	test('asks for a check, and gets out of the way of the answer', async () => {
		const opened = open(connected());

		press('check-remote-status');
		await settle();

		expect(opened.storage.checks).toBe(1);
		expect(opened.props.open).toBe(false);
	});

	test('asks for an Update, and gets out of the way of what it says', async () => {
		const opened = open(connected());

		press('update-from-github');
		await settle();

		expect(opened.storage.updates).toBe(1);
		expect(opened.props.open).toBe(false);
	});

	// The two remain two presses: neither is offered as a single verb, and pressing one asks for
	// nothing the other does.
	test('never asks for one gesture on the way to the other', async () => {
		const opened = open(connected());

		press('connect-publish');
		await settle();

		expect(opened.onpublish).toHaveBeenCalledTimes(1);
		expect(opened.storage.updates).toBe(0);
		expect(opened.storage.checks).toBe(0);
	});

	// ⚠ **The only caller of `unbindRemote` there is.** Connecting once is not permanent, and giving
	// the repository up belongs beside the standing fact rather than in a settings dialog.
	test('gives the repository up, once, and says what was and was not changed', async () => {
		const opened = open(connected(), listed([]));

		press('unbind-remote');
		await settle();

		expect(opened.storage.unbinds).toBe(1);
		expect(opened.storage.remote).toBeNull();
		expect(text(at('connect-notice'))).toContain('no longer publishes to ada/atlas');
		expect(text(at('connect-notice'))).toContain('Nothing there has been changed');
	});

	// No step of this surface is a full stop: a Workspace that has just given its repository up is
	// back at the start of the path to another one, with the control that takes it there on screen.
	test('leaves the author on a step with something to do', async () => {
		const opened = open(connected(), listed([]));

		press('unbind-remote');
		await settle();

		expect(opened.props.open).toBe(true);
		expect(at('connect-no-choices')).toBeTruthy();
	});

	// ⚠ **`aria-disabled`, never `disabled`.** A `disabled` button leaves the tab order the instant it
	// is pressed, dropping a keyboard user to `<body>` — and these are the controls a scholar is most
	// likely to be pressing when they are made busy (WCAG 2.4.3, stories 130 and 51).
	test.each([
		[
			'a check already running',
			'check-remote-status',
			(storage: FakeStorage) => {
				storage.remoteStatusState = { ...storage.remoteStatusState, checking: true };
			}
		],
		[
			'an Update already running',
			'update-from-github',
			(storage: FakeStorage) => {
				storage.updateProgress = { files: 4, totalFiles: 12 };
			}
		]
	])(
		'says %s with aria-disabled, and keeps the control in the tab order',
		(_name, testId, busy) => {
			const storage = connected();
			busy(storage);
			const opened = open(storage);

			expect(at(testId)).toHaveAttribute('aria-disabled', 'true');
			expect(at(testId).hasAttribute('disabled')).toBe(false);

			press(testId);

			expect(opened.storage.checks).toBe(0);
			expect(opened.storage.updates).toBe(0);
			expect(opened.props.open).toBe(true);
		}
	);

	test('uses `disabled` on no control of the connected step, busy or not', async () => {
		const storage = connected();
		storage.pagesAnswer = new Error('GitHub would not answer');
		open(storage);

		expect(at('connect-sequence').querySelectorAll('[disabled]')).toHaveLength(0);

		press('enable-pages');
		expect(at('enable-pages')).toHaveAttribute('aria-disabled', 'true');
		expect(at('connect-sequence').querySelectorAll('[disabled]')).toHaveLength(0);
		await settle();
	});
});

// ⚠ **A Remote may be somebody else's, and the door says only what is known about that** (ADR-0043).
// Push rights cannot be read without a credential, so there are three states rather than two, and
// the middle one — signed out — is the one that must claim nothing at all. Every assertion here is
// about which of the three the door is in and what it renders there; whose the repository is and
// what a Publish anyway would remove are Seam 1's, in `shared-remote.test.ts`.
describe('a Remote that may not be the author’s to publish to', () => {
	/** A Workspace already connected to `ada/atlas`, which is the connected step's whole input. */
	function connected(): FakeStorage {
		const storage = signedIn();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		return storage;
	}

	/** The same Workspace with nobody signed in: a public Remote hydrated on this computer. */
	function hydrated(): FakeStorage {
		const storage = new FakeStorage();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		return storage;
	}

	// ⚠ **Story 72, and the whole of it is the second assertion.** Nothing may be claimed about rights
	// from an absent credential — not that the author may publish, and not that they may not — and the
	// only way to hold that is for the question never to be asked.
	test('says publishing needs a sign-in, and nothing about rights, while signed out', async () => {
		const storage = hydrated();
		open(storage);
		await settle();

		expect(text(at('publish-needs-sign-in'))).toContain('needs you to be signed in to GitHub');
		expect(absent('pull-only-remote')).toBe(true);
		expect(storage.rightsReads).toBe(0);
		expect(said()).not.toContain('write access');
	});

	test('states the pull-only relationship once GitHub has said so, and offers the way on', async () => {
		const storage = connected();
		storage.rightsAnswer = { canPush: false };
		open(storage);
		await settle();

		expect(text(at('pull-only-remote'))).toContain('you cannot publish to it');
		// Story 71: absent rather than refusing. A control that will certainly turn the author down is
		// worse than no control, and there is no second path to the publish dialog (ADR-0041).
		expect(absent('connect-publish')).toBe(true);
		// Story 74: the way forward is on the same screen as the limitation, and it is the main action.
		expect(at('publish-to-your-own')).toBeTruthy();
		expect(absent('publish-needs-sign-in')).toBe(true);
	});

	test('takes the author to the repository list from the main action', async () => {
		const storage = connected();
		storage.rightsAnswer = { canPush: false };
		const opened = open(storage);
		await settle();

		press('publish-to-your-own');
		await settle();

		expect(at('connect-choosing')).toBeTruthy();
		expect(opened.list).toHaveBeenCalledTimes(1);
	});

	test('leaves the ordinary state exactly as it was where the author may publish', async () => {
		const storage = connected();
		open(storage);
		await settle();

		expect(at('connect-publish')).toBeTruthy();
		expect(absent('pull-only-remote')).toBe(true);
		expect(absent('publish-to-your-own')).toBe(true);
		expect(storage.rightsReads).toBe(1);
	});

	// ⚠ **A read that failed is not an answer.** Withdrawing Publish over a network blip would deny a
	// publish the author is entitled to make, and the publish engine checks the permission itself
	// before a byte moves — so the ordinary state stands and nothing unprompted is said.
	test('says nothing and withdraws nothing when the rights could not be read', async () => {
		const storage = connected();
		storage.rightsAnswer = new Error('GitHub could not be reached.');
		open(storage);
		await settle();

		expect(at('connect-publish')).toBeTruthy();
		expect(absent('pull-only-remote')).toBe(true);
		expect(absent('connect-problem')).toBe(true);
		// ⚠ **Once, and the guard has to be separate from the answer for it to be once.** `rights`
		// stays `null` after a failure, so an effect guarded on it alone asks again the moment the
		// request settles — one `GET` per microtask for as long as GitHub is unreachable.
		expect(storage.rightsReads).toBe(1);
	});

	// The standing rule of this whole surface: nothing is remembered, because write access is
	// somebody else's to grant and to take away between two openings of the door.
	test('asks again on the next opening rather than remembering the answer', async () => {
		const storage = connected();
		const opened = open(storage);
		await settle();
		expect(storage.rightsReads).toBe(1);

		press('close-connect-sequence');
		opened.props.open = true;
		flushSync();
		await settle();

		expect(storage.rightsReads).toBe(2);
	});

	// ⚠ **Story 77: the boundary stated up front rather than met as a Conflict.** ADR-0024 refuses to
	// answer two Alignments of one sheet, so this is a limit rather than a defect — and a limit
	// discovered at the end of an afternoon is the same sentence one afternoon later.
	test('states the one thing two people cannot both do, before either of them does it', () => {
		open(connected());

		const limit = text(at('shared-remote-limit'));
		expect(limit).toContain('different Projects at the same time');
		expect(limit).toContain('cannot both do is align the same Map Image');
		expect(limit).toContain('Conflict');
	});

	test('states it whether or not anybody may publish there', async () => {
		const storage = connected();
		storage.rightsAnswer = { canPush: false };
		open(storage);
		await settle();

		expect(at('shared-remote-limit')).toBeTruthy();
	});
});

// ⚠ **A `remote.json` this installation cannot corroborate is a question, asked once when it is
// true** (ADR-0038, ADR-0041). The binding is a file inside the published tree, so a fork, a
// colleague's copied folder and a restored Backup all carry one naming somebody else's repository.
// It always was a question; what changes is that it is asked where every other way to a Remote
// already is, rather than filed where questions go unread.
describe('a repository the Workspace’s own files name', () => {
	/** A Workspace carrying an uncorroborated `remote.json`, which is not a Remote. */
	function asked(): FakeStorage {
		const storage = new FakeStorage();
		storage.legacyRemote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		return storage;
	}

	test('is asked about, by name, ahead of every step of the path', () => {
		open(asked());

		expect(at('connect-legacy')).toBeTruthy();
		expect(text(at('legacy-remote'))).toBe('ada/atlas');
		expect(text(at('legacy-remote-offer'))).toContain('no record of ever having published there');
		expect(absent('connect-needs-account')).toBe(true);
		expect(absent('connect-sign-in')).toBe(true);
	});

	test('is not asked about at all when there is nothing to ask about', () => {
		open(new FakeStorage());

		expect(absent('connect-legacy')).toBe(true);
		expect(absent('legacy-remote-offer')).toBe(true);
	});

	// Nothing is spent on GitHub for a step the author may never reach: accepting connects the
	// Workspace without a listing at all.
	test('asks GitHub nothing while the question stands', async () => {
		const storage = asked();
		storage.signedIn = true;
		storage.identity = 'ada';
		storage.credential = 'a-credential-this-component-never-renders';
		const opened = open(storage);
		await settle();

		expect(opened.list).not.toHaveBeenCalled();
	});

	// ⚠ **Bound, and with no Baseline invented for it.** There is no evidence about what this machine
	// shared with that repository, and an empty Baseline would claim the Remote holds nothing — the
	// reading that licenses overwriting all of it.
	test('accepting connects the Workspace and says nothing is known about it yet', async () => {
		const opened = open(asked());

		press('accept-legacy-remote');
		await settle();

		expect(opened.storage.remote).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
		expect(at('connect-connected')).toBeTruthy();
		expect(text(at('connect-notice'))).toContain('no record of what is there yet');
		expect(text(at('remote-baseline'))).toContain('Cannot tell what has changed');
	});

	test('declining leaves the Workspace unbound, on the ordinary path to a repository', async () => {
		const opened = open(asked());

		press('decline-legacy-remote');
		await settle();

		expect(opened.storage.remote).toBeNull();
		expect(opened.storage.legacyRemote).toBeNull();
		expect(text(at('connect-notice'))).toContain('Left unbound');
		expect(at('connect-needs-account')).toBeTruthy();
	});

	test('uses `disabled` on neither answer', () => {
		open(asked());

		expect(at('connect-sequence').querySelectorAll('[disabled]')).toHaveLength(0);
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

	// The question a Workspace's own files raise is announced as the question it is, rather than as a
	// numbered step of a path it stands in front of.
	test('announces the question a Workspace’s own files raise', () => {
		const storage = new FakeStorage();
		storage.legacyRemote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		open(storage);

		expect(text(at('connect-step'))).toContain('ada/atlas');
		expect(text(at('connect-step'))).toContain('Say whether it is yours');
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
		],
		[
			'the question about a repository the files name',
			() => {
				const storage = new FakeStorage();
				storage.legacyRemote = { owner: 'ada', repository: 'atlas', branch: 'main' };
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

	// Story 124. The paste is the whole of this deployment's authentication, so the guidance it
	// carries has to be enough to make a token that works first time: both permissions, and the
	// **Resource owner** row, which is the trap — a token made under the wrong owner cannot see the
	// repository, and the symptom is a repository that appears not to exist.
	test('names both permissions the token needs, and the resource owner trap', () => {
		open(noApp());

		expect(said()).toContain('Contents: Read and write');
		expect(said()).toContain('Pages: Read and write');
		expect(said()).toContain('Resource owner');
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

// ⚠ **The escape hatch, and the whole of what makes it one: it is closed** (story 126).
//
// An instructor whose App installation has broken mid-class needs a way in that does not depend on
// the installation, and a student on the same deployment must never be offered a choice between two
// credentials. A disclosure is what those two facts add up to: the field is not in the document
// until somebody who knows what they are asking for asks for it, so the screen a student meets is
// the sign-in and nothing else.
describe('the way in for an installation that has broken', () => {
	test('is closed, with nothing behind it in the document', () => {
		open(signedIn());

		expect(at('connect-other-way-in')).toHaveAttribute('aria-expanded', 'false');
		expect(absent('connect-token-field')).toBe(true);
		expect(absent('connect-paste')).toBe(true);
	});

	test('says it is open once it is, and puts the field there', () => {
		open(signedIn());
		press('connect-other-way-in');

		expect(at('connect-other-way-in')).toHaveAttribute('aria-expanded', 'true');
		expect(at('connect-token-field')).toBeTruthy();
	});

	// The same bind the fork's own step makes, because it is the same act: what is different is who
	// is standing there and why, not what happens on the press.
	test('binds the typed repository with the pasted token', async () => {
		const opened = open(signedIn());
		press('connect-other-way-in');

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
	});

	// A Workspace that is already bound is the state an instructor mid-class is actually in: the
	// repository is not the question, so it is not asked again.
	test('arrives with the repository already named where there is one', () => {
		const storage = signedIn();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		open(storage);
		press('connect-other-way-in');

		expect((at('connect-repository-field') as HTMLInputElement).value).toBe('ada/atlas');
	});

	// Where there is no App there is nothing to be an escape from: the paste is the front door, and a
	// disclosure over the step the author is standing on would be a second copy of it.
	test('is not offered where the deployment has no App of its own', () => {
		open(noApp());

		expect(absent('connect-other-way-in')).toBe(true);
		expect(at('connect-no-app')).toBeTruthy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS TRUE OF THE SIGN-IN, AND THE ONE CHOICE ABOUT IT (ADR-0041, ADR-0042)
//
// Both were in the Remote dialog this Epic deletes, and both are about a sign-in — so they are on
// the door, which is where every other gesture about one already is. The claim is that the sentence
// states which of the two rules is *currently* in force, and that the choice is never a default
// somebody else made.
describe('the sign-in this computer holds', () => {
	test('says the sign-in is forgotten with the tab until the author says otherwise', () => {
		const storage = signedIn();
		open(storage);

		expect(text(at('connect-signed-in'))).toContain('Signed in to GitHub as ada');
		expect(text(at('connect-signed-in'))).toContain('forgotten when this tab closes');
		expect((at('remember-sign-in') as HTMLInputElement).checked).toBe(false);
	});

	test('states the other rule once the author has asked for it', () => {
		const storage = signedIn();
		storage.rememberSignIn = true;
		open(storage);

		expect(text(at('connect-signed-in'))).toContain('keeps the part that renews it');
		expect((at('remember-sign-in') as HTMLInputElement).checked).toBe(true);
	});

	test('records the choice on the press, and states the rule that is now in force', () => {
		const { storage } = open(signedIn());

		const box = at('remember-sign-in') as HTMLInputElement;
		box.checked = true;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		expect(storage.remembers).toEqual([true]);
		expect(text(at('connect-signed-in'))).toContain(
			'coming back tomorrow does not mean signing in'
		);
	});

	// Offered before the button is pressed, because it is a decision about this machine rather than
	// about the sign-in currently held — and that is the order a person meets it in.
	test('offers the choice signed out as well, and says nothing is held', () => {
		open(new FakeStorage());

		expect(text(at('connect-signed-out'))).toContain('Not signed in to GitHub');
		expect((at('remember-sign-in') as HTMLInputElement).checked).toBe(false);
	});

	// A fork's whole authentication is a pasted credential, which lives in the tab and has no
	// renewable half at all — so the choice would be a promise this deployment cannot keep.
	test('offers no such choice where the deployment has no App of its own', () => {
		open(noApp());

		expect(absent('connect-credential')).toBe(true);
		expect(absent('remember-sign-in')).toBe(true);
	});
});

/**
 * Where the door leaves the keyboard when it closes (user story 129, WCAG 2.4.3).
 *
 * The door is the one control on the bar for the whole GitHub relationship, so a scholar who opens
 * it, reads the answer and closes it again has to be put back on it — otherwise every visit to the
 * door costs a tab from the top of the document. `ModalDialog` performs the restoration and
 * `modal-dialog.dom.test.ts` asserts the three shapes it can take; what is asserted here is that the
 * door is one of its dialogs at all, which is the claim a rewrite of this surface could break.
 */
describe('closing the door', () => {
	test('puts focus back on the control that opened it', () => {
		// Standing in for the bar's own door button, which is `NavigationBar`'s: what this component
		// can be asked is where focus goes, and that is decided by what was focused when it opened.
		const door = document.createElement('button');
		door.dataset.testid = 'the-door';
		document.body.append(door);
		door.focus();

		open(new FakeStorage());
		press('close-connect-sequence');

		expect(document.activeElement).toBe(door);
	});
});

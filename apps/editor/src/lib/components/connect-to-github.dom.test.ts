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
// this component to the real sign-in, the real bind and a real Sync is one test in
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
	type RemoteReference
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
	canPush: true,
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
	readonly onsync: ReturnType<typeof vi.fn>;
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
	const onsync = vi.fn();
	const resolve = vi.fn(async (pasted: string) => {
		void pasted;
		if (address instanceof Error) throw address;
		return address instanceof Promise ? await address : address;
	});
	const main = document.createElement('main');
	document.body.append(main);
	const props = sequenceProps({
		storage: storage as unknown as WorkspaceStorage,
		onsync,
		list,
		resolveAddress: resolve
	});
	mounted = mount(ConnectToGitHub, { target: main, props });
	flushSync();
	return { storage, list, onsync, resolve, props };
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

/** A promise a test settles by hand, so a request in flight is a state and not a race. */
function deferred<T>(): { readonly promise: Promise<T>; readonly settle: (value: T) => void } {
	let settle: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		settle = resolve;
	});
	return { promise, settle: (value: T) => settle(value) };
}

/**
 * Let the injected listing, the injected bind and the Share Links acts settle, and render what they
 * answered.
 *
 * ⚠ **The turn count is a depth rather than a duration.** Each `await` here lets one generation of
 * queued microtasks run, and the deepest chain on this surface is a press calling an `async` wrapper
 * calling an `async` method that awaits — so a count that only just covered the shallowest one left a
 * button reading "Asking GitHub…" and a test looking for the answer behind it.
 */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
	flushSync();
}

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

	// The choice, the reason for it, and what choosing otherwise costs — said
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
	// ⚠ **A Workspace that already has a Remote is offered the choice again, not a step about the
	// Remote it has** (ADR-0044). The sequence survives only for connecting: the bar opens the Sync
	// modal for a Workspace with a repository, and the standing relationship is on the Workspace's
	// own row — so the one way back here is *Choose a different repository*, which is the list.
	test('offers the repository list again for a Workspace that already has a Remote', async () => {
		const storage = signedIn();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		const { list } = open(storage);
		await settle();

		expect(at('connect-choosing')).toBeTruthy();
		expect(list).toHaveBeenCalled();
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

	/**
	 * ⚠ **A repository the author already has and cannot see is answered here, not only after
	 * making a new one.** The other route to the same screen is behind *Create a new one*, which
	 * asks somebody who has a repository to make a second one they do not need — which is the
	 * failure the refusal-versus-empty-list rule above exists to prevent, reached from the list.
	 */
	test('offers the screen that lets Ballastella at a repository missing from the list', async () => {
		open(signedIn(), listed([ATLAS]));
		await settle();

		expect(text(at('repository-missing'))).toContain('not in this list');
		expect(at('grant-access').getAttribute('href')).toBe(
			`https://github.com/apps/${FAKE_APP.appSlug}/installations/new/permissions` +
				`?suggested_target_id=${NARROW.targetId}`
		);
	});

	// The same press the `creating` step has, and for the same reason: a repository added on GitHub's
	// screen a moment ago is exactly what this sequence has to be able to see without a reload.
	test('reads the listing again when the author comes back from that screen', async () => {
		const { list } = open(signedIn(), listed([ATLAS]));
		await settle();
		expect(list).toHaveBeenCalledTimes(1);

		press('reread-repositories');
		await settle();

		expect(list).toHaveBeenCalledTimes(2);
		expect(at('connect-choosing')).toBeTruthy();
	});

	// ⚠ **No link at all where widening is somebody else's, rather than a link they cannot save.**
	test('names the admin, and offers no link, where it is not the author’s to do', async () => {
		open(
			signedIn(),
			listed(
				[{ ...ATLAS, owner: 'harvard', canGrantAccess: false }],
				[{ ...NARROW, id: 9, account: 'harvard', targetId: 606, isOrganization: true }]
			)
		);
		await settle();

		expect(absent('grant-access')).toBe(true);
		expect(text(at('repository-missing'))).toContain('administers');
	});

	// Ballastella already reaches everything on this account, so a missing repository is not a
	// missing access — and naming one would be a confident wrong answer.
	test('says nothing about access where the reach already covers everything', async () => {
		open(signedIn(), listed([ATLAS], [WIDE]));
		await settle();

		expect(absent('repository-missing')).toBe(true);
		expect(absent('grant-access')).toBe(true);
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
		const onsync = vi.fn();
		const resolve = vi.fn(async (pasted: string) => {
			void pasted;
			return ATLAS_ADDRESS;
		});
		const storage = signedIn();
		const main = document.createElement('main');
		document.body.append(main);
		const props = sequenceProps({
			storage: storage as unknown as WorkspaceStorage,
			onsync,
			list,
			resolveAddress: resolve
		});
		mounted = mount(ConnectToGitHub, { target: main, props });
		flushSync();
		await settle();
		pressLink('create-repository');
		answer = then;
		return { storage, list, onsync, resolve, props };
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
	 * which is the wall an author reported hitting.
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

	// ⚠ **The sequence ends on the Sync modal, and there is no step saying it worked** (ADR-0044).
	// Connecting moves no bytes; what the author came for is the work, and the modal that opens is
	// where both sides are compared with everything the repository holds under To get.
	test('closes and hands off to the Sync modal', async () => {
		const opened = open(signedIn());
		await choose();

		expect(opened.onsync).toHaveBeenCalledTimes(1);
		expect(opened.props.open).toBe(false);
	});

	// ⚠ Turning a site on is a question about who may read this, and connecting is not
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
	// binding records where this Workspace belongs whether or not this author may send there.
	//
	// ⚠ **The connection stands, so the sequence ends the way every other connection does.** That the
	// relationship is read-only is a standing fact about the Workspace and is stated on its own row
	// (`WorkspaceRemote`, ADR-0044) — a second saying of it here would be one question with two
	// answers, on a screen the author is leaving.
	test('connects anyway where the credential cannot send, rather than refusing', async () => {
		const storage = signedIn();
		storage.bindAnswer = outcome({
			canPush: false,
			rightsNotice: 'This token cannot push to ada/atlas, so sending to it will be refused.'
		});
		const opened = open(storage);
		await choose();

		expect(storage.remote).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
		expect(opened.onsync).toHaveBeenCalledTimes(1);
		expect(absent('connect-problem')).toBe(true);
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

// ⚠ **The one path through this sequence that needs no account at all** (ADR-0031, ADR-0044). A
// student getting their instructor's shared Workspace is the likeliest thing this tool is asked
// to do, and a door whose first step is signing in locks exactly that person out of it. It is also
// how an organisation repository GitHub will not list is reached, which is the other half of why the
// field survives the sign-in.
describe('reaching a repository by typing its address', () => {
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
	// ⚠ **The typed address and the chosen repository are one act** (ADR-0044). The confirmation
	// connects through the same `bindRemote` the list's own choices use, so there is no second door
	// with its own rules about a Workspace that already has content — and the get that follows is the
	// ordinary Sync modal.
	//
	// ⚠ **No credential is handed over**, which is what makes the student with no account the person
	// this path is for.
	test('connects this Workspace to the repository it resolved, once that is confirmed', async () => {
		const opened = open(new FakeStorage());
		const { storage, resolve } = opened;
		press('open-by-address');

		fill('workspace-address-field', 'ada.github.io/atlas');
		press('find-workspace-address');
		await settle();

		expect(resolve).toHaveBeenCalledWith('ada.github.io/atlas');
		expect(text(at('resolved-address'))).toContain('ada/atlas');
		expect(text(at('resolved-address-why'))).toContain('ada/atlas');
		expect(storage.bindCalls).toEqual([]);

		press('open-resolved-address');
		await settle();

		expect(storage.bindCalls).toEqual([
			{ remote: { owner: 'ada', repository: 'atlas' }, token: null }
		]);
		expect(opened.onsync).toHaveBeenCalledTimes(1);
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
	test('leaves no refusal from the last time behind it', async () => {
		const storage = signedIn();
		storage.bindAnswer = new RemoteBindRefusedError(
			'no-repository',
			'GitHub has no repository at ada/atlas.'
		);
		const opened = open(storage);
		await settle();
		press('choose-repository');
		await settle();
		expect(text(at('connect-problem'))).toContain('no repository at ada/atlas');

		press('close-connect-sequence');
		opened.props.open = true;
		flushSync();

		expect(absent('connect-problem')).toBe(true);
	});
});

// A GitHub App's user token lasts eight hours, and one that has run out makes every later request
// fail — as a listing with nothing in it, or as a repository that refused the author. So the expiry
// is asked about the moment the sequence opens, before any of that can be misread.
describe('a sign-in that ran out', () => {
	const RAN_OUT = 'Your GitHub sign-in has expired, so nothing has been sent.';

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

	// ⚠ **Not as a repository problem and not as a failed send**, which are the two things an
	// expiry looks like from underneath: the listing comes back refused, and a send stops partway.
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

	// ⚠ **The same decline lands on the sign-in step for a Workspace that already has a Remote too.**
	// The trip is a redirect off the page, so the return leg reopens the sequence over whatever the
	// Workspace's state is — and the refusal has to be said over the button that starts the trip
	// again, wherever that is, rather than on the page the dialog is in front of.
	test('a sign-in GitHub declined is said over the button that starts the trip again', async () => {
		connectSequence.signInRefusal = 'GitHub refused the sign-in, so nothing has been signed in to.';
		const storage = new FakeStorage();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		openPastAccount(storage);
		await settle();

		expect(at('connect-sign-in')).toBeTruthy();
		expect(text(at('connect-sign-in-refused'))).toContain('GitHub refused the sign-in');
	});
});

// ⚠ **Two claims about *every* branch, enumerated rather than sampled.** No step of this sequence may
// be a dead end, and no step may say GitHub's own word for the per-account list. Both are properties
// of the whole union, so a fourteenth step added without them is the regression worth catching —
// which is why `CONNECT_STEPS` is a list the component exports and this table is keyed by it. A step
// added to the union and not to the table does not compile.
//
// ⚠ **There is no step at the end.** The steps that stated a standing relationship are gone with
// the doors they were the end of (ADR-0044): connecting hands off to the Sync modal, and what is
// true afterwards is a setting of the Workspace on its own row.
describe('every step of the sequence, enumerated', () => {
	/**
	 * A step reached, with the request it is waiting on where it is waiting on one.
	 *
	 * `answers` is present for the two steps the author passes *through* rather than lands on — a
	 * listing GitHub has not replied to, and a connection under way. Neither has anything to press,
	 * and what makes that not a dead end is that both end: the first on a list, the second on the
	 * Sync modal, with this surface closed behind it.
	 */
	type Arrived = { readonly answers?: () => Promise<void> };

	const RAN_OUT = 'Your GitHub sign-in has expired, so nothing has been sent.';
	const COULD_NOT_BE_READ = 'GitHub could not be reached, so your repositories could not be read.';

	const reach: Record<Step, { readonly shows: string; readonly go: () => Promise<Arrived> }> = {
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
						{ ...ATLAS, repository: 'notebook', canPush: false },
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

	// ⚠ **The word the interface never says.** The wall an author hit was the App's
	// Installation — a per-account list of repositories the interface had never mentioned — and the
	// remedy is not to explain it but to describe what Ballastella can see, in a sentence the author
	// can act on. `Installation` stays a term the codebase needs and the author never meets.
	//
	// Every step, including the ones carrying a sentence `packages/core` composed: those name a
	// setting on GitHub's own screens and are not this component's to reword, and none of them says
	// any of these either.
	const GITHUB_VOCABULARY = ['installation', 'installations', 'grant', 'permission'];

	/**
	 * ⚠ **Every landing the door can present, reachable by keyboard.**
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

	// ⚠ **Connecting once is not permanent**, and the sequence is where a repository is chosen however
	// often. *Choose a different repository* on the Workspace's own row opens this, which lands on the
	// listing read again rather than on a remembered one.
	test('a connected Workspace connects to a different repository through the same act', async () => {
		const storage = signedIn();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		const opened = open(storage, listed([{ ...ATLAS, repository: 'notebook' }]));
		await settle();
		expect(at('connect-choosing')).toBeTruthy();

		press('choose-repository');
		await settle();

		expect(opened.storage.bindCalls).toEqual([
			{ remote: { owner: 'ada', repository: 'notebook' }, token: null }
		]);
		expect(opened.onsync).toHaveBeenCalledTimes(1);
	});
});

describe('reaching every step without sight and without a pointer', () => {
	// One region, in the document from the first frame, whose words change with the step — a region
	// inserted at the moment its text first exists is not reliably announced (ADR-0016).
	test('announces each step as it changes', async () => {
		// A bind held open, so the step the press moves to is one the sequence is standing on rather
		// than one it has already handed off from.
		const storage = new PausedBind();
		storage.signedIn = true;
		storage.identity = 'ada';
		storage.credential = 'a-credential-this-component-never-renders';
		const opened = open(storage);
		expect(at('connect-step')).toHaveAttribute('role', 'status');

		await settle();
		expect(text(at('connect-step'))).toContain('choose where your map goes');

		press('choose-repository');
		await settle();
		expect(text(at('connect-step'))).toContain('connecting to ada/atlas');
		expect(at('connect-connecting')).toBeTruthy();

		storage.letGo();
		await settle();
		expect(opened.onsync).toHaveBeenCalledTimes(1);
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
		expect(opened.onsync).toHaveBeenCalledTimes(1);
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

	// The paste is the whole of this deployment's authentication, so the guidance it
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
	// The fork's own door has no list to fall back to, so a Workspace with a Remote opens on the
	// paste — which is where its author changes the repository as well as chooses the first one.
	test('opens on the paste for a Workspace that already has a Remote', () => {
		const storage = noApp();
		storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		open(storage);

		expect(at('connect-no-app')).toBeTruthy();
	});

	// The announcement, in a sequence that has one step fewer: it counts the steps this door has
	// rather than the ones the other one has.
	test('announces the fork’s own steps', async () => {
		const storage = new PausedBind();
		storage.signInWithGitHubOffered = false;
		open(storage);
		expect(text(at('connect-step'))).toContain('Step 1 of 2');

		fill('connect-repository-field', 'ada/atlas');
		fill('connect-token-field', 'github_pat_11ABCDE0000abcdefghijklmnop');
		submit();
		await settle();

		expect(text(at('connect-step'))).toContain('Step 2 of 2: connecting to ada/atlas');
	});
});

// ⚠ **The escape hatch, and the whole of what makes it one: it is closed.**
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
// WHAT IS TRUE OF THE SIGN-IN, AND THE ONE CHOICE ABOUT IT (ADR-0042, ADR-0044)
//
// Both are about a sign-in, so both are on the door, which is where every other gesture about one
// already is. The claim is that the sentence
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
 * Where the door leaves the keyboard when it closes (WCAG 2.4.3).
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

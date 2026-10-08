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
import { flushSync } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { connectSequence } from '$lib/connect-sequence.svelte.js';
import {
	absent,
	all,
	at,
	fill,
	inMain,
	press,
	said,
	settle,
	show,
	takeDown,
	textOf
} from '$lib/test-support/dom.js';

import ConnectToGitHub, { CONNECT_STEPS, type Step } from './ConnectToGitHub.svelte';
import {
	FAKE_APP,
	FAKE_REDIRECT_URI,
	FAKE_STATE,
	FakeStorage,
	outcome,
	sequenceProps
} from './connect-to-github-fake.svelte.js';
import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

const ATLAS: GrantedRepository = {
	owner: 'ada',
	repository: 'atlas',
	canPush: true,
	canGrantAccess: true,
	isPrivate: false
};

const NARROW: GrantedInstallation = {
	id: 42,
	account: 'ada',
	targetId: 5150,
	isOrganization: false,
	coversEverything: false
};
const WIDE: GrantedInstallation = { ...NARROW, coversEverything: true };
const HARVARD: GrantedInstallation = {
	...NARROW,
	id: 9,
	account: 'harvard',
	targetId: 606,
	isOrganization: true
};

const listed = (
	repositories: readonly GrantedRepository[] = [ATLAS],
	installations: readonly GrantedInstallation[] = [NARROW]
): GrantedRepositoriesOutcome => ({ kind: 'listed', repositories, installations });

const harvard = (canGrantAccess: boolean): GrantedRepositoriesOutcome =>
	listed([{ ...ATLAS, owner: 'harvard', canGrantAccess }], [HARVARD]);

const SIGN_IN_ENDED: GrantedRepositoriesOutcome = {
	kind: 'refused',
	refusal: 'credential',
	message: 'Your GitHub sign-in has ended, so your repositories could not be read.'
};

const grantScreen = (targetId: number): string =>
	`https://github.com/apps/${FAKE_APP.appSlug}/installations/new/permissions` +
	`?suggested_target_id=${targetId}`;

const FORBIDDEN = 'bind binding credential namespace token deploy upload push backup cloud'.split(
	' '
);
const forbiddenSaid = (): string[] =>
	FORBIDDEN.filter((word) => said().toLowerCase().includes(word));

const PAT = 'github_pat_11ABCDE0000abcdefghijklmnop';
const RAN_OUT = 'Your GitHub sign-in has expired, so nothing has been sent.';
const INSTALL_FIRST = `https://github.com/apps/${FAKE_APP.appSlug}/installations/new?state=${FAKE_STATE}`;
const AUTHORIZE_ONLY = authorizeUrl({
	app: FAKE_APP,
	redirectUri: FAKE_REDIRECT_URI,
	state: FAKE_STATE
});

afterEach(() => {
	takeDown();
	sessionStorage.clear();
	connectSequence.signInRefusal = '';
});

type Opened = ReturnType<typeof open>;

type Answer<T> = T | Error | Promise<T>;

const ATLAS_ADDRESS: AddressResolution = {
	kind: 'resolved',
	remote: { owner: 'ada', repository: 'atlas' },
	why: 'A published site at ada.github.io/atlas is usually the repository ada/atlas.'
};

const answering = <T>(answer: () => Answer<T>) =>
	vi.fn(async (asked: string): Promise<T> => {
		void asked;
		const given = answer();
		if (given instanceof Error) throw given;
		return given;
	});

function open(
	storage: FakeStorage,
	answer:
		Answer<GrantedRepositoriesOutcome> | (() => Answer<GrantedRepositoriesOutcome>) = listed(),
	address: Answer<AddressResolution> = ATLAS_ADDRESS
) {
	const list = answering(typeof answer === 'function' ? answer : () => answer);
	const resolve = answering(() => address);
	const onsync = vi.fn();
	const props = sequenceProps({
		storage: storage as unknown as WorkspaceStorage,
		onsync,
		list,
		resolveAddress: resolve
	});
	show(ConnectToGitHub, props, inMain());
	return { storage, list, onsync, resolve, props };
}

function openPastAccount(storage: FakeStorage): Opened {
	const opened = open(storage);
	press('connect-have-account');
	return opened;
}

function reopen(opened: Opened): void {
	press('close-connect-sequence');
	opened.props.open = true;
	flushSync();
}

function noApp<S extends FakeStorage = FakeStorage>(storage = new FakeStorage() as S): S {
	storage.signInWithGitHubOffered = false;
	return storage;
}

function signedIn<S extends FakeStorage = FakeStorage>(storage = new FakeStorage() as S): S {
	storage.signedIn = true;
	storage.identity = 'ada';
	storage.credential = 'a-credential-this-component-never-renders';
	return storage;
}

function bound(storage: FakeStorage): FakeStorage {
	storage.bound = { owner: 'ada', repository: 'atlas', branch: 'main' };
	return storage;
}

function expired(): FakeStorage {
	const storage = signedIn();
	storage.expiry = new Error(RAN_OUT);
	return storage;
}

function deferred<T>() {
	let settle!: (value: T) => void;
	const promise = new Promise<T>((resolve) => (settle = resolve));
	return { promise, settle };
}

class PausedBind extends FakeStorage {
	private readonly gate = deferred<void>();

	letGo(): void {
		this.gate.settle();
	}

	override async bind(remote: RemoteReference, token: string | null): Promise<RemoteBindOutcome> {
		await this.gate.promise;
		return super.bind(remote, token);
	}
}

const pressLink = (testId: string): void => {
	const stop = (event: Event): void => event.preventDefault();
	document.addEventListener('click', stop, true);
	try {
		press(testId);
	} finally {
		document.removeEventListener('click', stop, true);
	}
};

const paste = (repository: string, token: string): void => {
	fill('connect-repository-field', repository);
	fill('connect-token-field', token);
	at('connect-paste')
		.closest('form')
		?.dispatchEvent(new SubmitEvent('submit', { bubbles: true }));
	flushSync();
};

describe('which step the sequence shows', () => {
	test('asks for the sign-in when no credential is held, and begins it at the App’s install screen', () => {
		const { storage, list } = openPastAccount(new FakeStorage());

		expect(at('connect-sign-in')).toBeTruthy();
		expect(absent('connect-choosing')).toBe(true);
		expect(list).not.toHaveBeenCalled();
		expect(absent('connect-sign-out')).toBe(true);
		expect(at('open-by-address')).toBeTruthy();
		const advice = textOf(at('connect-choose-all-repositories'));
		expect(advice).toContain('All repositories');
		expect(advice).toContain('every one you make later');
		expect(advice).toMatch(/make after today will not be there/);

		press('connect-sign-in-with-github');
		expect(storage.signInsBegun).toBe(1);
		expect(storage.signInDepartures).toEqual([INSTALL_FIRST]);
		expect(sessionStorage.getItem('ballastella.connect-sequence-resuming')).toBe('yes');
	});

	test('says why this browser cannot start a sign-in', () => {
		const storage = new FakeStorage();
		storage.signInRefusal = 'This browser will not let this page remember the sign-in.';
		openPastAccount(storage);
		press('connect-sign-in-with-github');
		expect(textOf(at('connect-problem'))).toContain('will not let this page remember');
		expect(sessionStorage.getItem('ballastella.connect-sequence-resuming')).toBeNull();
	});

	test('lands on the granted repositories when a credential is held, and leaves when it goes', async () => {
		const storage = signedIn();
		open(storage, listed([ATLAS, { ...ATLAS, repository: 'seminar' }]));
		await settle();

		expect(absent('connect-sign-in')).toBe(true);
		expect(at('connect-choosing')).toBeTruthy();
		expect(textOf(at('connect-account'))).toBe('Signed in to GitHub as ada.');
		expect(all('granted-repository')).toHaveLength(2);
		expect(said()).toContain('ada/atlas');
		expect(at('connect-sequence').querySelectorAll('[disabled]')).toHaveLength(0);
		expect(at('open-by-address')).toBeTruthy();

		storage.signedIn = false;
		storage.credential = null;
		flushSync();
		expect(at('connect-sign-in')).toBeTruthy();
	});
});

describe('the repositories the sequence offers', () => {
	test('says what GitHub refused rather than an empty list, and offers the sign-in again', async () => {
		const { storage } = open(signedIn(), SIGN_IN_ENDED);
		await settle();

		expect(textOf(at('connect-choices-refused'))).toContain('sign-in has ended');
		expect(absent('repository-choice-empty')).toBe(true);
		expect(textOf(at('connect-step'))).toContain('could not be read');
		expect(textOf(at('connect-step'))).not.toContain('make one');
		expect(absent('connect-no-choices')).toBe(true);
		press('connect-sign-in-again');
		expect(storage.signInsBegun).toBe(1);
		expect(storage.signInDepartures).toEqual([AUTHORIZE_ONLY]);
	});

	test('offers the screen that lets Ballastella at a missing repository, and re-reads on return', async () => {
		const { list } = open(signedIn(), listed([ATLAS]));
		await settle();

		expect(textOf(at('repository-missing'))).toContain('not in this list');
		expect(at('grant-access').getAttribute('href')).toBe(grantScreen(NARROW.targetId));
		expect(list).toHaveBeenCalledTimes(1);
		press('reread-repositories');
		await settle();

		expect(list).toHaveBeenCalledTimes(2);
		expect(at('connect-choosing')).toBeTruthy();
	});

	test('names the admin, and offers no link, where it is not the author’s to do', async () => {
		open(signedIn(), harvard(false));
		await settle();

		expect(absent('grant-access')).toBe(true);
		expect(textOf(at('repository-missing'))).toContain('administers');
	});

	test('says nothing about access where the reach already covers everything', async () => {
		open(signedIn(), listed([ATLAS], [WIDE]));
		await settle();

		expect(absent('repository-missing')).toBe(true);
		expect(absent('grant-access')).toBe(true);
	});
});

describe('making a repository, without leaving the sequence', () => {
	const nothing = (): GrantedRepositoriesOutcome => listed([]);
	const HARBOUR: GrantedRepository = { ...ATLAS, repository: 'harbour' };

	async function leaveToCreate(
		first: GrantedRepositoriesOutcome,
		then: GrantedRepositoriesOutcome = first
	): Promise<Opened> {
		let answer = first;
		const opened = open(signedIn(), () => answer);
		await settle();
		pressLink('create-repository');
		answer = then;
		return opened;
	}

	async function rereadAfterCreating(
		first: GrantedRepositoriesOutcome,
		then?: GrantedRepositoriesOutcome
	): Promise<Opened> {
		const opened = await leaveToCreate(first, then);
		press('reread-repositories');
		await settle();
		return opened;
	}

	const instructions = (): string[] => all('creating-instruction').map(textOf);

	test('offers GitHub’s new-repository screen, named, in a second tab, with an empty list or a full one', async () => {
		const storage = signedIn();
		storage.name = 'Amsterdam 1625';
		open(storage, nothing());
		await settle();

		expect(at('connect-no-choices')).toBeTruthy();
		const link = at('create-repository');
		expect(link.getAttribute('href')).toBe('https://github.com/new?name=amsterdam-1625');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(textOf(at('create-repository-note'))).toContain('amsterdam-1625');
		takeDown();
		open(signedIn(), listed([ATLAS]));
		await settle();
		expect(at('connect-choosing')).toBeTruthy();
		expect(at('create-repository')).toBeTruthy();
	});

	test.each([
		['a narrow grant', nothing(), ['give Ballastella access to it', 'second screen']],
		['a non-admin', harvard(false), ['admin']],
		[
			'only another account’s wide grant',
			listed([], [NARROW, { ...HARVARD, coversEverything: true }]),
			['give Ballastella access to it']
		]
	])(
		'names all three things to do, in the order that works, for %s',
		async (_name, first, grant) => {
			await leaveToCreate(first);

			expect(at('connect-creating')).toBeTruthy();
			const steps = instructions();
			expect(steps).toHaveLength(3);
			expect(steps[0]).toContain('has to be public');
			for (const words of grant) expect(steps[1]).toContain(words);
			expect(steps[2]).toContain('Come back to this tab');
			expect(steps.join(' ')).not.toContain('the same screen');
		}
	);

	test('asks for nothing but the repository when the grant already covers everything, before and after a re-read', async () => {
		await leaveToCreate(listed([], [WIDE]));

		expect(at('connect-creating')).toBeTruthy();
		const steps = instructions();
		expect(steps).toHaveLength(2);
		expect(steps[0]).toContain('has to be public');
		expect(steps[1]).toContain('Come back to this tab');
		expect(steps.join(' ')).not.toContain('access');
		expect(absent('grant-access')).toBe(true);

		press('reread-repositories');
		await settle();
		expect(at('connect-creating')).toBeTruthy();
		expect(absent('grant-access')).toBe(true);
		expect(absent('created-not-granted')).toBe(true);
		expect(textOf(at('created-not-listed'))).not.toContain('access');
	});

	test.each([
		['the window regains focus', () => window.dispatchEvent(new Event('focus'))],
		['the document becomes visible', () => document.dispatchEvent(new Event('visibilitychange'))],
		['the control is pressed', () => press('reread-repositories')]
	])(
		're-reads the listing when %s, and stops watching once the repository appears',
		async (_name, arrive) => {
			const opened = await leaveToCreate(nothing(), listed([HARBOUR]));
			expect(opened.list).toHaveBeenCalledTimes(1);
			arrive();
			await settle();

			expect(opened.list).toHaveBeenCalledTimes(2);
			expect(at('connect-choosing')).toBeTruthy();
			window.dispatchEvent(new Event('focus'));
			await settle();
			expect(opened.list).toHaveBeenCalledTimes(2);
		}
	);

	test('puts a repository that was not there before at the top, marked as new', async () => {
		await rereadAfterCreating(listed([ATLAS]), listed([ATLAS, HARBOUR]));

		const rows = all('granted-repository').map(textOf);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain('ada/harbour');
		expect(rows[0]).toContain('New');
		expect(rows[1]).not.toContain('New');
	});

	test('names the missing grant when the listing comes back unchanged, and sends it to the App’s own screen', async () => {
		await rereadAfterCreating(nothing());

		expect(textOf(at('created-not-granted'))).toContain('has not been given access to it');
		expect(at('grant-access').getAttribute('href')).toBe(grantScreen(NARROW.targetId));
		expect(absent('repository-choice-empty')).toBe(true);
	});

	test('offers the link only where the author administers the organisation’s repositories', async () => {
		await rereadAfterCreating(harvard(false));
		expect(absent('grant-access')).toBe(true);
		expect(textOf(at('created-not-granted'))).toContain('admin');
		takeDown();
		sessionStorage.clear();

		await rereadAfterCreating(harvard(true));
		expect(at('grant-access').getAttribute('href')).toBe(grantScreen(606));
	});

	test('does not ask GitHub twice for one return', async () => {
		const opened = await leaveToCreate(nothing());

		window.dispatchEvent(new Event('focus'));
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();

		expect(opened.list).toHaveBeenCalledTimes(2);
	});

	test('reports a re-read GitHub refused as a refusal, not as a missing grant', async () => {
		await rereadAfterCreating(nothing(), SIGN_IN_ENDED);

		expect(textOf(at('connect-choices-refused'))).toContain('sign-in has ended');
		expect(absent('created-not-granted')).toBe(true);
		expect(at('connect-sign-in-again')).toBeTruthy();
		expect(textOf(at('connect-step'))).toContain('could not be read');
	});
});

describe('connecting, which is one act', () => {
	async function choose(storage = signedIn()): Promise<Opened> {
		const opened = open(storage);
		await settle();
		press('choose-repository');
		await settle();
		return opened;
	}

	test('hands the chosen repository to the bind once, closes, hands off to Sync, and asks nothing of Pages', async () => {
		const opened = await choose();

		expect(opened.storage.bindCalls).toEqual([
			{ remote: { owner: 'ada', repository: 'atlas' }, token: null }
		]);
		expect(opened.onsync).toHaveBeenCalledTimes(1);
		expect(opened.props.open).toBe(false);
		expect(opened.storage.pagesAsks).toBe(0);
		expect(absent('connect-notice')).toBe(true);
		expect(said()).not.toContain('Pages');
	});

	test('connects anyway where the credential cannot send, rather than refusing', async () => {
		const storage = signedIn();
		storage.bindAnswer = outcome({
			canPush: false,
			rightsNotice: 'This token cannot push to ada/atlas, so sending to it will be refused.'
		});
		const opened = await choose(storage);
		expect(storage.bound).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
		expect(opened.onsync).toHaveBeenCalledTimes(1);
		expect(absent('connect-problem')).toBe(true);
	});
});

describe('the student who has never heard of GitHub', () => {
	test('says an account is needed, what it is for, that it is free, and links to GitHub’s sign-up', () => {
		open(new FakeStorage());
		const words = textOf(at('connect-needs-account'));
		expect(words).toContain('You need a GitHub account');
		expect(words).toContain('where your map will live');
		expect(words).toContain('free');
		const link = at('connect-sign-up');
		expect(link).toHaveAttribute('href', 'https://github.com/signup');
		expect(link).toHaveAttribute('target', '_blank');
		expect(link).toHaveAttribute('rel', 'noreferrer noopener');
	});

	test('is offered once to a tab, and again to the next one', () => {
		const opened = open(new FakeStorage());
		press('connect-have-account');
		expect(at('connect-sign-in')).toBeTruthy();
		reopen(opened);
		expect(at('connect-sign-in')).toBeTruthy();
		takeDown();
		open(new FakeStorage());
		expect(at('connect-sign-in')).toBeTruthy();
		expect(absent('connect-needs-account')).toBe(true);

		sessionStorage.clear();
		takeDown();
		open(new FakeStorage());
		expect(at('connect-needs-account')).toBeTruthy();
	});

	test('lands at the sign-in on the way back from making an account', () => {
		open(new FakeStorage());
		const link = at('connect-sign-up');
		link.addEventListener('click', (event) => event.preventDefault());
		link.click();
		flushSync();
		expect(at('connect-sign-in')).toBeTruthy();
		takeDown();
		open(new FakeStorage());
		expect(at('connect-sign-in')).toBeTruthy();
		expect(absent('connect-needs-account')).toBe(true);
	});
});

describe('reaching a repository by typing its address', () => {
	test('is reached signed out, asking nothing of the author’s repositories, and left for the step before', () => {
		const { storage, list } = open(new FakeStorage());

		press('open-by-address');
		expect(at('connect-by-address')).toBeTruthy();
		expect(storage.signedIn).toBe(false);
		expect(list).not.toHaveBeenCalled();
		press('leave-by-address');
		expect(at('connect-needs-account')).toBeTruthy();
	});

	async function find(address: string): Promise<void> {
		press('open-by-address');
		fill('workspace-address-field', address);
		press('find-workspace-address');
		await settle();
	}

	test('connects this Workspace to the repository it resolved, once that is confirmed', async () => {
		const opened = open(new FakeStorage());
		const { storage, resolve } = opened;
		await find('ada.github.io/atlas');

		expect(resolve).toHaveBeenCalledWith('ada.github.io/atlas');
		expect(textOf(at('resolved-address'))).toContain('ada/atlas');
		expect(textOf(at('resolved-address-why'))).toContain('ada/atlas');
		expect(storage.bindCalls).toEqual([]);
		press('open-resolved-address');
		await settle();

		expect(storage.bindCalls).toEqual([
			{ remote: { owner: 'ada', repository: 'atlas' }, token: null }
		]);
		expect(opened.onsync).toHaveBeenCalledTimes(1);
	});

	test('takes “that is not it” back to the address', async () => {
		open(new FakeStorage());
		await find('ada.github.io/atlas');

		press('reject-resolved-address');
		expect(absent('resolved-address')).toBe(true);
		expect(at('workspace-address-field')).toBeTruthy();
	});

	test('refuses a custom domain by naming what to paste instead', async () => {
		open(new FakeStorage(), listed(), resolveWorkspaceAddress('https://maps.example.org/atlas'));
		await find('https://maps.example.org/atlas');

		expect(textOf(at('workspace-address-refused'))).toContain('owner/repository');
		expect(absent('resolved-address')).toBe(true);
	});

	test('is forgotten on a close, along with what was typed into it', async () => {
		const opened = open(new FakeStorage());
		press('open-by-address');
		fill('workspace-address-field', 'ada.github.io/atlas');
		reopen(opened);
		await settle();

		expect(at('connect-needs-account')).toBeTruthy();
		press('open-by-address');
		expect((at('workspace-address-field') as HTMLInputElement).value).toBe('');
	});
});

describe('leaving the sequence, and coming back to it', () => {
	test.each([
		['the choice', () => {}],
		['the create-and-grant step', () => pressLink('create-repository')]
	])('reopens on the repository list after a close from %s', async (_name, leave) => {
		const opened = open(signedIn());
		await settle();
		leave();
		press('close-connect-sequence');
		expect(opened.props.open).toBe(false);

		opened.props.open = true;
		flushSync();
		await settle();

		expect(absent('connect-creating')).toBe(true);
		expect(at('connect-choosing')).toBeTruthy();
		expect(opened.list).toHaveBeenCalledTimes(2);
	});

	test('leaves a refused repository’s choice on screen, and no refusal behind it on a reopen', async () => {
		const storage = signedIn();
		storage.bindAnswer = new RemoteBindRefusedError(
			'no-repository',
			'GitHub has no repository at ada/atlas, or none this sign-in can see.'
		);
		const opened = open(storage);
		await settle();
		press('choose-repository');
		await settle();
		expect(textOf(at('connect-problem'))).toContain('no repository at ada/atlas');
		expect(at('choose-repository')).toBeTruthy();
		reopen(opened);
		expect(absent('connect-problem')).toBe(true);
	});
});

describe('a sign-in that ran out', () => {
	test('says the sign-in ended, not that there are no repositories, and signs in again at the plain authorize screen, never the account step', async () => {
		const opened = open(expired());
		await settle();

		expect(textOf(at('connect-expiry'))).toBe(RAN_OUT);
		expect(absent('connect-choosing')).toBe(true);
		expect(absent('repository-choice-empty')).toBe(true);
		press('connect-sign-in-with-github');
		expect(opened.storage.signInsBegun).toBe(1);
		expect(opened.storage.signInDepartures).toEqual([AUTHORIZE_ONLY]);

		reopen(opened);
		await settle();
		expect(at('connect-sign-in')).toBeTruthy();
		expect(absent('connect-needs-account')).toBe(true);
	});

	test('is its own screen and its own announcement, beside a listing GitHub would not answer', async () => {
		const ENDED = 'Your GitHub sign-in has ended. Sign in to GitHub again to carry on.';
		const storage = signedIn();
		storage.expiry = new Error(ENDED);
		open(storage);
		await settle();

		expect(textOf(at('connect-expiry'))).toBe(ENDED);
		expect(absent('connect-refused-choices')).toBe(true);
		const asAnExpiry = textOf(at('connect-step'));
		takeDown();
		sessionStorage.clear();

		open(signedIn(), { kind: 'refused', refusal: 'credential', message: ENDED });
		await settle();

		expect(textOf(at('connect-choices-refused'))).toBe(ENDED);
		expect(absent('connect-sign-in-ended')).toBe(true);
		expect(textOf(at('connect-step'))).not.toBe(asAnExpiry);
		expect(asAnExpiry).toContain('sign-in has ended');
		expect(textOf(at('connect-step'))).toContain('could not be read');
	});
});

describe('every refusal names what to do next', () => {
	test.each<[string, Answer<GrantedRepositoriesOutcome>, string]>([
		[
			'refused',
			{ kind: 'refused', refusal: 'network', message: 'GitHub could not be reached.' },
			'could not be reached'
		],
		['threw', new Error('The browser gave up on the request.'), 'gave up on the request']
	])(
		'a listing read that %s is a refusal that offers to ask again',
		async (_name, answer, words) => {
			const opened = open(signedIn(), answer);
			await settle();

			expect(textOf(at('connect-choices-refused'))).toContain(words);
			expect(absent('connect-loading-choices')).toBe(true);
			press('connect-read-again');
			await settle();

			expect(opened.list).toHaveBeenCalledTimes(2);
		}
	);

	test.each([
		['an unconnected', new FakeStorage()],
		['a connected', bound(new FakeStorage())]
	])(
		'a sign-in GitHub declined is said over the button that starts it again, in %s Workspace',
		async (_name, storage) => {
			connectSequence.signInRefusal =
				'GitHub refused the sign-in, so nothing has been signed in to.';
			openPastAccount(storage);
			await settle();

			expect(at('connect-sign-in')).toBeTruthy();
			expect(textOf(at('connect-sign-in-refused'))).toContain('GitHub refused the sign-in');
			press('connect-sign-in-with-github');
			expect(storage.signInsBegun).toBe(1);
		}
	);
});

describe('every step of the sequence, enumerated', () => {
	const reach: Record<Step, [shows: string, go: () => unknown]> = {
		'by-address': [
			'connect-by-address',
			() => {
				open(new FakeStorage());
				press('open-by-address');
			}
		],
		'no-app': ['connect-no-app', () => open(noApp())],
		'needs-account': ['connect-needs-account', () => open(new FakeStorage())],
		'needs-sign-in': ['connect-sign-in', () => openPastAccount(new FakeStorage())],
		'sign-in-ended': ['connect-sign-in-ended', () => open(expired())],
		'loading-choices': [
			'connect-loading-choices',
			() => {
				const held = deferred<GrantedRepositoriesOutcome>();
				open(signedIn(), held.promise);
				return () => held.settle(listed());
			}
		],
		choosing: [
			'connect-choosing',
			() =>
				open(
					signedIn(),
					listed([
						ATLAS,
						{ ...ATLAS, repository: 'notebook', canPush: false },
						{ ...ATLAS, repository: 'diary', isPrivate: true }
					])
				)
		],
		'no-choices': ['connect-no-choices', () => open(signedIn(), listed([]))],
		'choices-refused': [
			'connect-refused-choices',
			() =>
				open(signedIn(), {
					kind: 'refused',
					refusal: 'network',
					message: 'GitHub could not be reached, so your repositories could not be read.'
				})
		],
		creating: [
			'connect-creating',
			async () => {
				open(signedIn());
				await settle();
				pressLink('create-repository');
				press('reread-repositories');
			}
		],
		connecting: [
			'connect-connecting',
			async () => {
				const storage = signedIn(new PausedBind());
				open(storage);
				await settle();
				press('choose-repository');
				return () => storage.letGo();
			}
		]
	};

	const GITHUB_VOCABULARY = ['installation', 'installations', 'grant', 'permission'];

	test.each([...CONNECT_STEPS])(
		'%s says none of GitHub’s words nor a student’s, can be closed, and renders named, tabbable controls, or is a request that answers',
		async (step) => {
			const [shows, go] = reach[step];
			const answers = await go();
			await settle();
			expect(at(shows)).toBeTruthy();
			expect(at('close-connect-sequence')).toBeTruthy();
			const words = said().toLowerCase();
			expect(GITHUB_VOCABULARY.filter((word) => words.includes(word))).toEqual([]);
			if (step !== 'no-app') expect(forbiddenSaid()).toEqual([]);

			if (typeof answers === 'function') {
				answers();
				await settle();
				expect(absent(shows)).toBe(true);
			}
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
});

describe('signing out, and changing where the work goes', () => {
	test('signs out from the sequence, the account going with it and no account step coming back', async () => {
		const opened = open(signedIn());
		await settle();
		expect(absent('connect-needs-account')).toBe(true);

		press('connect-sign-out');
		await settle();

		expect(opened.storage.signOuts).toBe(1);
		expect(opened.storage.credential).toBeNull();
		expect(opened.storage.identity).toBe('');
		expect(at('connect-sign-in')).toBeTruthy();
		expect(absent('connect-needs-account')).toBe(true);
	});

	test('a connected Workspace connects to a different repository through the same act', async () => {
		const opened = open(bound(signedIn()), listed([{ ...ATLAS, repository: 'notebook' }]));
		await settle();
		expect(at('connect-choosing')).toBeTruthy();
		expect(opened.list).toHaveBeenCalled();
		press('choose-repository');
		await settle();

		expect(opened.storage.bindCalls).toEqual([
			{ remote: { owner: 'ada', repository: 'notebook' }, token: null }
		]);
		expect(opened.onsync).toHaveBeenCalledTimes(1);
	});
});

describe('reaching every step without sight and without a pointer', () => {
	test('announces each step as it changes', async () => {
		const storage = signedIn(new PausedBind());
		const opened = open(storage);
		expect(at('connect-step')).toHaveAttribute('role', 'status');

		await settle();
		expect(textOf(at('connect-step'))).toContain('choose where your map goes');
		press('choose-repository');
		await settle();
		expect(textOf(at('connect-step'))).toContain('connecting to ada/atlas');
		expect(at('connect-connecting')).toBeTruthy();

		storage.letGo();
		await settle();
		expect(opened.onsync).toHaveBeenCalledTimes(1);
	});
});

describe('the words the sequence uses', () => {
	test('the connected step, the empty grant and the create step say none a student would have to learn', async () => {
		open(bound(signedIn()));
		expect(forbiddenSaid()).toEqual([]);
		takeDown();

		open(signedIn(), listed([]));
		await settle();
		expect(forbiddenSaid()).toEqual([]);
		pressLink('create-repository');
		press('reread-repositories');
		await settle();

		expect(at('connect-creating')).toBeTruthy();
		expect(textOf(at('created-not-granted'))).not.toBe('');
		expect(forbiddenSaid()).toEqual([]);
	});
});

describe('a fork that has registered no GitHub App', () => {
	test('offers the paste first, naming the token’s permissions, and no sign-in or other way in', () => {
		const storage = noApp();
		storage.name = 'Amsterdam 1625';
		const { list } = open(storage);

		expect(at('connect-no-app')).toBeTruthy();
		expect(absent('connect-sign-in')).toBe(true);
		expect(absent('connect-sign-in-with-github')).toBe(true);
		expect(list).not.toHaveBeenCalled();
		expect(absent('connect-other-way-in')).toBe(true);
		expect(absent('connect-credential')).toBe(true);
		expect(absent('remember-sign-in')).toBe(true);
		expect(said()).toContain('Contents: Read and write');
		expect(said()).toContain('Pages: Read and write');
		expect(said()).toContain('Resource owner');
		expect(said()).toContain('Administration: Read and write');
		expect(said()).toContain('delete the repository');
		expect(at('connect-create-repository')).toHaveAttribute(
			'href',
			'https://github.com/new?name=amsterdam-1625'
		);
		expect(said()).toContain('It has to be public');
	});

	test('connects the typed repository with the pasted token, announcing its own steps', async () => {
		const storage = noApp(new PausedBind());
		const opened = open(storage);
		expect(textOf(at('connect-step'))).toContain('Step 1 of 2');
		paste('ada/atlas', PAT);
		await settle();
		expect(textOf(at('connect-step'))).toContain('Step 2 of 2: connecting to ada/atlas');
		storage.letGo();
		await settle();

		expect(opened.storage.bindCalls).toEqual([
			{ remote: { owner: 'ada', repository: 'atlas' }, token: PAT }
		]);
		expect(opened.onsync).toHaveBeenCalledTimes(1);
	});

	test.each([
		['an address that is not one', 'atlas', PAT, 'owner/repository'],
		['a token that is half a token', 'ada/atlas', 'github_pat_11', 'too short']
	])('says %s is not one, and asks GitHub nothing', (_name, repository, token, problem) => {
		const opened = open(noApp());
		paste(repository, token);
		expect(textOf(at('connect-problem'))).toContain(problem);
		expect(opened.storage.bindCalls).toEqual([]);
	});

	test('opens on the paste for a Workspace that already has a Remote', () => {
		open(bound(noApp()));
		expect(at('connect-no-app')).toBeTruthy();
	});
});

describe('the way in for an installation that has broken', () => {
	test('is closed, with no token field behind it before or after the listing', async () => {
		open(signedIn());
		expect(at('connect-other-way-in')).toHaveAttribute('aria-expanded', 'false');
		expect(absent('connect-token-field')).toBe(true);
		expect(absent('connect-paste')).toBe(true);
		await settle();
		expect(absent('connect-no-app')).toBe(true);
		expect(absent('connect-token-field')).toBe(true);
	});

	test('expands a named personal access token sign-in form that binds what is pasted', async () => {
		const opened = open(signedIn());
		press('connect-other-way-in');
		expect(at('connect-other-way-in')).toHaveAttribute('aria-expanded', 'true');
		expect(textOf(at('connect-other-way-in'))).toBe('Hide personal access token sign-in');
		expect(textOf(at('connect-other-way-in-panel'))).toContain(
			'Sign in with a personal access token'
		);

		paste('ada/atlas', PAT);
		await settle();

		expect(opened.storage.bindCalls).toEqual([
			{ remote: { owner: 'ada', repository: 'atlas' }, token: PAT }
		]);
	});

	test('arrives with the repository already named where there is one', () => {
		open(bound(signedIn()));
		press('connect-other-way-in');
		expect((at('connect-repository-field') as HTMLInputElement).value).toBe('ada/atlas');
	});
});

describe('the sign-in this computer holds', () => {
	const remembering = (): boolean => (at('remember-sign-in') as HTMLInputElement).checked;

	test('states the other rule once the author has asked for it', () => {
		const storage = signedIn();
		storage.rememberSignIn = true;
		open(storage);
		expect(textOf(at('connect-signed-in'))).toContain('keeps the part that renews it');
		expect(remembering()).toBe(true);
	});

	test('forgets the sign-in with the tab until the press, then states the rule now in force', () => {
		const { storage } = open(signedIn());
		expect(textOf(at('connect-signed-in'))).toContain('Signed in to GitHub as ada');
		expect(textOf(at('connect-signed-in'))).toContain('forgotten when this tab closes');
		expect(remembering()).toBe(false);

		const box = at('remember-sign-in') as HTMLInputElement;
		box.checked = true;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(storage.remembers).toEqual([true]);
		expect(textOf(at('connect-signed-in'))).toContain(
			'coming back tomorrow does not mean signing in'
		);
	});

	test('offers the choice signed out as well, and says nothing is held', () => {
		open(new FakeStorage());
		expect(textOf(at('connect-signed-out'))).toContain('Not signed in to GitHub');
		expect(remembering()).toBe(false);
	});
});

describe('closing the door', () => {
	test('puts focus back on the control that opened it', () => {
		const door = document.createElement('button');
		door.dataset.testid = 'the-door';
		document.body.append(door);
		door.focus();

		open(new FakeStorage());
		press('close-connect-sequence');
		expect(document.activeElement).toBe(door);
	});
});

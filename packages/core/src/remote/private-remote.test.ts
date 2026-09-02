import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import { enableRemotePages } from './bind-remote.js';
import { createFakeGitHub } from './fake-github.js';
import { FakeMetadataStorage } from './fake-metadata-storage.js';
import { LocalChangeIndex, checkSourceStatus } from './local-change-index.js';
import type { RemoteRepository } from './send-to-remote.js';
import {
	RemoteStatusUnavailableError,
	anonymousDetermination,
	readRemoteInventory
} from './remote-status.js';
import { SynchronizationMetadata } from './synchronization-metadata.js';
import { sendWorkspaceToRemote } from './synchronization-send.js';
import { UpdateRefusedError, getFromRemote } from './get-from-remote.js';

// A private repository, which until ADR-0044 could not be chosen at all. The claim is that it is the
// same engine, the same namespace and the same Baseline — so what is asserted here is deliberately
// the *ordinary* behaviour, driven against a fake that answers a private repository the way GitHub
// does, and the two places where being private genuinely changes something.
//
// ⚠ **GitHub answers 404 to every anonymous read of a private repository, on the API host and the
// raw host alike** — it will not admit that a repository the caller cannot see exists. That is the
// whole reason the two narrowed halves are narrowed: an anonymous get cannot tell a private Remote
// from a deleted one, so it offers a sign-in rather than reporting a repository missing; and an
// anonymous status check reaches `Cannot tell` rather than the agreement it would otherwise keep
// claiming.
//
// What is *not* here, and must not be: any reading of the author's GitHub plan. Pages on a private
// repository needs a paid one, that cannot be read reliably from the App's token, and guessing would
// lock out authors who have paid — so Share Links are offered and GitHub's refusal is reported.

const REMOTE: RemoteRepository = { owner: 'ada', repository: 'atlas', branch: 'main' };
const TOKEN = 'ghp_a-token';
const WORKSPACE = 'opfs:Atlas';

const encode = (text: string): Bytes => new TextEncoder().encode(text);

/** A Workspace of one Project, and a private repository with a first commit in it. */
async function workspace() {
	const store = new MemoryProjectStore();
	await store.write(
		'amsterdam-1625/project.json',
		encode('{"formatVersion":1,"name":"Amsterdam"}')
	);
	await store.write(
		'amsterdam-1625/annotations/notes.json',
		encode('{"type":"FeatureCollection","features":[]}')
	);
	const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
	github.privateRepository = true;
	const storage = new FakeMetadataStorage();
	return {
		store,
		github,
		metadata: new SynchronizationMetadata(storage, WORKSPACE),
		changes: new LocalChangeIndex(storage, WORKSPACE, { flushInterval: 0 })
	};
}

type Apparatus = Awaited<ReturnType<typeof workspace>>;

const send = (kit: Apparatus) =>
	sendWorkspaceToRemote(kit.store, {
		token: TOKEN,
		remote: REMOTE,
		metadata: kit.metadata,
		changes: kit.changes,
		fetch: kit.github.fetch
	});

const get = (kit: Apparatus, token: string | null) =>
	getFromRemote(kit.store, {
		remote: REMOTE,
		token,
		baseline: null,
		fetch: kit.github.fetch
	});

/** The refusal a get raised, having asserted it raised one at all. */
async function refusal(run: Promise<unknown>): Promise<UpdateRefusedError> {
	const caught = await run.then(
		() => null,
		(cause: unknown) => cause
	);
	if (!(caught instanceof UpdateRefusedError)) {
		throw new Error(`expected an UpdateRefusedError, got ${String(caught)}`);
	}
	return caught;
}

describe('a private repository', () => {
	it('takes a send, so that work can leave the laptop without going on the open web', async () => {
		const kit = await workspace();

		await send(kit);

		// The scholar's own files, and the `README.md` the repository already had left alone.
		expect([...kit.github.files().keys()]).toEqual([
			'README.md',
			'amsterdam-1625/annotations/notes.json',
			'amsterdam-1625/project.json'
		]);
	});

	it('is got from by a signed-in scholar, bytes and all', async () => {
		const kit = await workspace();
		await kit.github.commitFiles({
			'delft/project.json': '{"formatVersion":1,"name":"Delft"}'
		});

		const update = await get(kit, TOKEN);

		expect(update.added).toEqual(['delft/project.json']);
		// ⚠ **The bytes, not just the listing.** `raw.githubusercontent.com` answers 404 rather than
		// 401 to an anonymous read of a private repository, so a get that listed the tree signed in and
		// fetched the bytes anonymously would not fail — it would refuse every file as missing.
		expect(new TextDecoder().decode(await kit.store.read('delft/project.json'))).toBe(
			'{"formatVersion":1,"name":"Delft"}'
		);
	});

	it('offers a signed-out get a sign-in rather than reporting the repository missing', async () => {
		const kit = await workspace();
		await kit.github.commitFiles({ 'delft/project.json': '{"formatVersion":1,"name":"Delft"}' });

		const refused = await refusal(get(kit, null));

		expect(refused.message).toContain('sign in to GitHub');
		// A 404 read back as "there is no such repository" sends a scholar off to check an address that
		// is fine, and says nothing about the one thing that would work.
		expect(refused.message).toContain('private repository');
		expect(await kit.store.list('')).not.toContain('delft/project.json');
	});

	it('is Cannot tell to a signed-out status check, and never agreement', async () => {
		const kit = await workspace();
		await send(kit);
		const baseline = await kit.metadata.readBaseline(REMOTE);

		// Signed in, the two sides agree — which is the determination the signed-out check must not
		// inherit once GitHub stops answering it.
		const signedIn = await checkSourceStatus({
			changes: kit.changes,
			remote: await readRemoteInventory({ remote: REMOTE, token: TOKEN, fetch: kit.github.fetch }),
			baseline
		});
		expect(signedIn.status).toBe('in-sync');

		const failed = await readRemoteInventory({
			remote: REMOTE,
			token: null,
			fetch: kit.github.fetch
		}).then(
			() => null,
			(cause: unknown) => cause
		);
		expect(failed).toBeInstanceOf(RemoteStatusUnavailableError);
		expect(anonymousDetermination((failed as RemoteStatusUnavailableError).refusal)).toBe(
			'cannot-tell'
		);
	});

	it('is still offered Share Links, and reports GitHub’s refusal through the guided step', async () => {
		const kit = await workspace();
		await send(kit);
		// GitHub's plan requirement is not modelled and must not be: what reaches this app is a
		// refusal, and a refusal is a refusal whatever its cause.
		kit.github.refusePages = true;

		const outcome = await enableRemotePages({
			token: TOKEN,
			remote: REMOTE,
			fetch: kit.github.fetch
		});

		expect(outcome.enabled).toBe(false);
		expect(outcome.next).toBe('guided');
		expect(outcome.settingsUrl).toBe('https://github.com/ada/atlas/settings/pages');
		expect(outcome.branch).toBe('main');
	});
});

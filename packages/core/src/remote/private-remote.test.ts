import { describe, expect, it } from 'vitest';

import { rejection, seeded } from '../test-support.js';
import { enableRemotePages } from './bind-remote.js';
import { createFakeGitHub } from './fake-github.js';
import { FakeMetadataStorage } from './fake-metadata-storage.js';
import { checkSourceStatus } from './local-change-index.js';
import { ATLAS as REMOTE, changeIndex, storedText } from './remote-test-support.js';
import {
	RemoteStatusUnavailableError,
	anonymousDetermination,
	readRemoteInventory
} from './remote-status.js';
import { SynchronizationMetadata } from './synchronization-metadata.js';
import { sendWorkspaceToRemote } from './synchronization-send.js';
import { getFromRemote } from './get-from-remote.js';
import { UpdateRefusedError } from './update-transaction.js';

const TOKEN = 'ghp_a-token';
const WORKSPACE = 'opfs:Atlas';

async function workspace() {
	const store = await seeded({
		'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}',
		'amsterdam-1625/annotations/notes.json': '{"type":"FeatureCollection","features":[]}'
	});
	const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
	github.privateRepository = true;
	const storage = new FakeMetadataStorage();
	return {
		store,
		github,
		metadata: new SynchronizationMetadata(storage, WORKSPACE),
		changes: changeIndex(storage, WORKSPACE)
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
	getFromRemote(kit.store, { remote: REMOTE, token, baseline: null, fetch: kit.github.fetch });

describe('a private repository', () => {
	it('takes a send, so that work can leave the laptop without going on the open web', async () => {
		const kit = await workspace();

		await send(kit);

		expect([...kit.github.files().keys()]).toEqual([
			'README.md',
			'amsterdam-1625/annotations/notes.json',
			'amsterdam-1625/project.json'
		]);
	});

	it('is got from by a signed-in scholar, bytes and all', async () => {
		const kit = await workspace();
		await kit.github.commitFiles({ 'delft/project.json': '{"formatVersion":1,"name":"Delft"}' });

		const update = await get(kit, TOKEN);
		expect(update.added).toEqual(['delft/project.json']);
		expect(await storedText(kit.store, 'delft/project.json')).toBe(
			'{"formatVersion":1,"name":"Delft"}'
		);
	});

	it('offers a signed-out get a sign-in rather than reporting the repository missing', async () => {
		const kit = await workspace();
		await kit.github.commitFiles({ 'delft/project.json': '{"formatVersion":1,"name":"Delft"}' });

		const refused = await rejection(UpdateRefusedError, get(kit, null));
		expect(refused.message).toContain('sign in to GitHub');
		expect(refused.message).toContain('private repository');
		expect(await kit.store.list('')).not.toContain('delft/project.json');
	});

	it('is Cannot tell to a signed-out status check, and never agreement', async () => {
		const kit = await workspace();
		await send(kit);
		const baseline = await kit.metadata.readBaseline(REMOTE);

		const signedIn = await checkSourceStatus({
			changes: kit.changes,
			remote: await readRemoteInventory({ remote: REMOTE, token: TOKEN, fetch: kit.github.fetch }),
			baseline
		});
		expect(signedIn.status).toBe('in-sync');

		const failed = await rejection(
			RemoteStatusUnavailableError,
			readRemoteInventory({ remote: REMOTE, token: null, fetch: kit.github.fetch })
		);
		expect(anonymousDetermination(failed.refusal)).toBe('cannot-tell');
	});

	it('is still offered Share Links, and reports GitHub’s refusal through the guided step', async () => {
		const kit = await workspace();
		await send(kit);
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

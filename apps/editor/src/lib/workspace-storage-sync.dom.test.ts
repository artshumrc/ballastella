import { describe, expect, test, vi } from 'vitest';

import {
	PUBLISHED_SITE_RECORD_NAME,
	serialiseJson,
	type ProjectSummary,
	type PublishedSitePlan,
	type RemoteRights
} from '@ballastella/core';
import { MemoryProjectStore } from '@ballastella/core/testing';

import { ATLAS, emptyForecast, localPlan } from './sync/sync-dialog-forecast.js';
import { Remote } from './remote.svelte.js';

vi.mock('./sync/viewer-bundle-source', () => ({
	loadViewerBundle: async () => ({ version: 'test', files: [] }),
	readBundleAsset: async () => new Uint8Array(0)
}));

const unreachable = new Error('GitHub could not be reached.');

class FakeSession {
	store = new MemoryProjectStore();
	projects: ProjectSummary[] = [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' } as never];
	forecast = emptyForecast({ unchanged: false });
	withdrawing = false;
	withdrawalsCleared = 0;
	failGet = false;
	failSend = false;
	gets = 0;
	readonly forecasts: (boolean | undefined)[] = [];
	readonly sends: (readonly string[] | undefined)[] = [];
	readonly sitesWritten: string[][] = [];
	synchronization = {
		readBaseline: async () => null,
		readWithdrawal: async () => this.withdrawing,
		clearWithdrawal: async () => void (this.withdrawalsCleared += 1)
	};

	async planPublishedSite(): Promise<PublishedSitePlan> {
		return { ...localPlan(), projects: [...this.projects] } as PublishedSitePlan;
	}

	async planRemoteSend(options: { sending?: boolean }) {
		this.forecasts.push(options.sending);
		return this.forecast;
	}

	async writePublishedSite(options: { plan: PublishedSitePlan }) {
		this.sitesWritten.push(options.plan.projects.map((project) => project.directory));
		return null;
	}

	async updateFromRemote() {
		this.gets += 1;
		if (this.failGet) throw unreachable;
		this.projects = [...this.projects, { directory: 'delft', name: 'Delft' } as never];
		const update = { added: ['delft/project.json'], replaced: [], removed: [], notice: '' };
		return { update, baselineKept: true };
	}

	async sendToRemote(options: { overwrite?: readonly string[] }) {
		this.sends.push(options.overwrite);
		if (this.failSend) throw unreachable;
		return { commit: 'newc0mmit', plan: this.forecast, baselineKept: true };
	}
}

type Situation = {
	carried?: boolean;
	remoteSite?: boolean;
	withdrawing?: boolean;
	credential?: string | null;
	rights?: RemoteRights | Error;
};

async function syncing({
	carried = false,
	remoteSite = false,
	withdrawing = false,
	credential = 'a-credential',
	rights = { canPush: true }
}: Situation = {}) {
	const session = new FakeSession();
	if (carried) await session.store.write(PUBLISHED_SITE_RECORD_NAME, serialiseJson({}));
	session.forecast = emptyForecast({ unchanged: false, shareLinks: remoteSite });
	session.withdrawing = withdrawing;
	const storage = new Remote(session as never, {
		name: () => 'Atlas',
		github: { credential } as never
	});
	storage.bound = ATLAS;
	storage.readRights = async () => {
		if (rights instanceof Error) throw rights;
		return rights;
	};
	return { session, storage };
}

describe('planning a Sync', () => {
	test.each<[string, Situation, boolean, boolean | null, boolean[]]>([
		['the Workspace carries a site', { carried: true }, true, true, [true]],
		['the Remote carries a site', { remoteSite: true }, true, true, [true, true]],
		['the site is being withdrawn', { remoteSite: true, withdrawing: true }, false, true, [true]],
		['the sign-in may not push', { rights: { canPush: false } }, false, false, [false]],
		['nobody is signed in', { credential: null, rights: unreachable }, false, false, [false]],
		['the rights cannot be read', { rights: unreachable }, false, null, [false]]
	])('where %s', async (_, situation, site, canSend, forecasts) => {
		const { session, storage } = await syncing(situation);

		const read = await storage.planSync();

		expect(read.plan !== null).toBe(site);
		expect(read.canSend).toBe(canSend);
		expect(session.forecasts).toEqual(forecasts);
	});
});

describe('a Sync', () => {
	test.each([
		['get', 1, []],
		['send', 0, [undefined]],
		['both', 1, [undefined]],
		['overwrite', 0, [['florida-1657/project.json']]]
	] as const)('to %s gets %i times and sends %j', async (mode, gets, sends) => {
		const { session, storage } = await syncing();

		await storage.sync(mode, { overwrite: ['florida-1657/project.json'] });

		expect(session.gets).toBe(gets);
		expect(session.sends).toEqual(sends);
	});

	test('leaves the send unattempted when the get fails', async () => {
		const { session, storage } = await syncing();
		session.failGet = true;

		await expect(storage.sync('both')).rejects.toMatchObject({ got: false, written: false });
		expect(session.sends).toEqual([]);
	});

	test('says the site was written when the send after it fails', async () => {
		const { session, storage } = await syncing();
		session.failSend = true;

		await expect(storage.sync('send', { site: localPlan() })).rejects.toMatchObject({
			message: unreachable.message,
			written: true
		});
	});

	test('rebuilds the site from what the get brought in, on a get and send in one press', async () => {
		const { session, storage } = await syncing({ carried: true });

		await storage.sync('both', { site: (await storage.planSync()).plan });

		expect(session.sitesWritten).toEqual([['amsterdam-1625', 'delft']]);
	});

	test.each<[string, Situation & { site?: PublishedSitePlan | null }, number]>([
		['the site it is handed', { site: localPlan() }, 1],
		['no site when handed none', { carried: true, site: null }, 0],
		['the site the Workspace carries', { carried: true }, 1],
		['the site the Remote carries', { remoteSite: true }, 1],
		['no site while it is being withdrawn', { remoteSite: true, withdrawing: true }, 0]
	])('sends %s', async (_, { site, ...situation }, written) => {
		const { session, storage } = await syncing(situation);

		await storage.sync('send', site === undefined ? {} : { site });

		expect(session.sitesWritten).toHaveLength(written);
		expect(session.withdrawalsCleared).toBe(1);
	});
});

import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { acceptCaptured, captured, corpus } from './corpus-fixture.js';
import { readRemoteImageService } from './image-service';

const live = process.env['BALLASTELLA_NETWORK_TESTS'] === '1';

describe.runIf(live)('the captured corpus, against the services themselves', () => {
	it.each(corpus.services.map((entry) => entry.name))(
		'%s still declares the pyramid that was captured',
		async (name) => {
			const remote = await readRemoteImageService(captured(name).fetchedFrom, {
				fetch: (input, init) => fetch(input as string, init)
			});
			const fromFixture = await acceptCaptured(name);
			expect(remote.imageId, `${name} identity`).toBe(fromFixture.imageId);
			expect(remote.tileSize, `${name} tile size`).toBe(fromFixture.tileSize);
			expect([remote.width, remote.height], `${name} dimensions`).toEqual([
				fromFixture.width,
				fromFixture.height
			]);
			expect(remote.synthesisedCoarsestScaleFactor, `${name} synthesised levels`).toBe(
				fromFixture.synthesisedCoarsestScaleFactor
			);
		},
		60_000
	);
});

describe.runIf(live)('the Allmaps community lookup', () => {
	it('still keys an image on generateId of its service URI', async () => {
		const remote = await readRemoteImageService(captured('bodleian').fetchedFrom, {
			fetch: (input, init) => fetch(input as string, init)
		});

		const response = await fetch(`https://annotations.allmaps.org/?url=${remote.uri}/info.json`, {
			redirect: 'manual',
			signal: AbortSignal.timeout(30_000)
		});
		const location = response.headers.get('location') ?? '';
		expect(remote.imageId).toBe('a8eb9e9cf936cc3d');
		expect(location, 'the API should redirect to /images/<generateId(uri)>').toContain(
			`/images/${remote.imageId}`
		);
	}, 60_000);
});

describe.runIf(!live)('the live-service checks', () => {
	it('are skipped, and say so rather than passing quietly', () => {
		expect(live).toBe(false);
		expect(corpus.services.length).toBeGreaterThan(10);
	});
});

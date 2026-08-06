import { readFileSync } from 'node:fs';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { acceptRemoteImageService, readRemoteImageService } from './image-service';

// Against the live internet, and therefore **skipped unless `BALLASTELLA_NETWORK_TESTS=1`**.
//
// The corpus in `fixtures/real-world-image-services.json` is what the unit tests reason about, and
// captured documents are the right thing for them: they are deterministic, they work in an archive
// with hostile wifi, and they keep a finding in the tree rather than in a report nobody opens again.
// But a captured document also cannot tell you that a library has since changed its service, and it
// is exactly the kind of fixture that quietly stops describing reality.
//
// So this is the other half: the same services, fetched now, checked for the two properties the
// whole slice rests on. It is not part of `pnpm test` because a red build must mean this repository
// is wrong, never that the Bodleian is having a bad afternoon.
//
//   BALLASTELLA_NETWORK_TESTS=1 pnpm --filter @ballastella/core test

const live = process.env['BALLASTELLA_NETWORK_TESTS'] === '1';

const corpus = JSON.parse(
	readFileSync(new URL('fixtures/real-world-image-services.json', import.meta.url), 'utf8')
) as {
	capturedOn: string;
	services: { name: string; fetchedFrom: string; info: unknown }[];
};

describe.runIf(live)('the captured corpus, against the services themselves', () => {
	it.each(corpus.services.map((entry) => [entry.name, entry] as const))(
		'%s still declares the pyramid that was captured',
		async (name, captured) => {
			const remote = await readRemoteImageService(captured.fetchedFrom, {
				fetch: (input, init) => fetch(input as string, init)
			});
			const fromFixture = await acceptRemoteImageService(captured.info, {
				requestedUrl: captured.fetchedFrom,
				fallbackUri: captured.fetchedFrom.replace(/\/info\.json$/, '')
			});

			// Same identity and same geometry. A service that has changed either is a fixture that has
			// stopped describing reality, and the fix is to re-capture and re-read the finding — never to
			// edit the captured document into agreeing.
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
		// The pivot of the whole feature, and the one fact in ADR-0015 that is not ours to control:
		// `annotations.allmaps.org/?url=<uri>/info.json` **redirects to `/images/<generateId(uri)>`**.
		// If that ever stops holding, the community lookup silently finds nothing for every image, so
		// it is worth a live check rather than a comment.
		const bodleian = corpus.services.find((entry) => entry.name === 'bodleian');
		const remote = await readRemoteImageService(bodleian!.fetchedFrom, {
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
		// A skipped suite that reports nothing is a suite everybody forgets exists. This is the one
		// assertion that runs by default, and it exists so `pnpm test`'s output carries the sentence.
		expect(live).toBe(false);
		expect(corpus.services.length).toBeGreaterThan(10);
	});
});

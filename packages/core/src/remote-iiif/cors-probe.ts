// The add-time gate on a remote image service: can this host's tiles actually reach a WebGL
// texture, and does it serve the pixels it was asked for?
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY AT ADD TIME AND NOT AT RENDER TIME
//
// ADR-0007. `@allmaps/maplibre` uploads every tile into a WebGL texture, which requires the
// response to be cross-origin *readable* — not merely fetchable. Most IIIF services send
// `Access-Control-Allow-Origin: *`, and most of the rest reflect the requesting origin, but not
// all do: `viewerd.kbr.be` answers with a single allowlisted origin that is not ours. **Without
// that header the map renders blank with no error at all** — unactionable for a humanities
// scholar, and a support request for whoever maintains this. So the question is asked once, at
// the moment the user adds the resource, when there is still a dialog to put the answer in.
//
// Mirroring is not a way round it (ticket 15): an offline copy has to fetch the tiles too.
//
// **`info.json` and one tile are both probed, and the tile is the one that matters.** They are
// commonly served by different infrastructure — a JSON endpoint behind one proxy, image bytes
// behind a CDN — so a gate that checks only `info.json` passes a naive test and then ships
// exactly the blank map it was written to prevent.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// AND WHILE WE HAVE A TILE IN HAND: THE EXACT-RESIZE ASSUMPTION
//
// `ImagePaneTile.placement` is `region ÷ scaleFactor`, which is right only under IIIF's own
// semantics for `size=w,h`: the returned image *is* exactly w×h pixels and its full extent is
// the full extent of the requested region. Ticket 05 asserts our own tiler honours that. **We
// cannot assert it of a stranger's server** — and the error, up to 0.6% at the right and bottom
// margins of a ragged tile, is sub-pixel, systematic, and invisible to every other test.
//
// So the one thing that *is* checkable is checked, on the one tile that can show it: the probe
// tile is ragged (see `chooseProbeTiles`), and its **decoded** dimensions must equal the dimensions
// that were requested. That catches every server that rounds, floors, pads to a whole tile, or
// silently substitutes a size — the whole class of "the map is very slightly stretched and nobody
// can tell why".
//
// What it cannot catch is a server that returns the right dimensions having *padded* rather than
// resized within them. Detecting that would mean decoding a full-resolution tile as well and
// comparing pixels, per service, on every add — expensive, and a false positive on any lossily
// compressed tile. So it is tolerated and written down rather than detected: the residue is bounded
// at 0.6% of one tile along two margins of the sheet, it is inside the same order as the JPEG noise
// the tiles already carry, and "make an offline copy" removes it outright by re-cutting the pyramid
// with the tiler ticket 05 *does* assert exact-resize of.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// A GATE THAT REFUSES A FLAKY HOST IS A BUG, NOT A STRICTER GATE
//
// This started as one request per URL, no retries, and a refusal sentence per *stage* with the
// cause interpolated into it. Both halves of that were wrong, and a real host showed it:
// `cdm17272.contentdm.oclc.org` (Cantaloupe behind an F5) serves this pyramid perfectly and
// intermittently hangs for sixty seconds on a **cold** derivative before answering `502` — measured
// at roughly one request in five. The gate asks for the far-corner ragged tile, which is by
// construction the coldest tile in the pyramid, so it walked straight into it, timed out, and
// refused an entirely usable map.
//
// So two rules, and they are the reason this file has more prose than logic:
//
// **A timeout, a 5xx, or a 429 is asked again.** Those are the signatures of a host that is busy or
// briefly broken, not of one that will never work — and the whole cost of being wrong is a few
// seconds. A rejected `fetch` and a 4xx are *not* retried: a missing
// `Access-Control-Allow-Origin` header will not appear on the second ask, and a service that says
// `404` for a tile it declares has answered the question. Retrying those would only make the
// common failure three times slower to report.
//
// **The refusal is chosen by the evidence, not by the stage.** The sentence about WebGL textures
// and blank maps is a claim about the *host's CORS policy*, and it may only be said when the
// browser really refused the read — a `fetch` that rejects with no status. A timeout says nothing
// whatsoever about CORS. Saying it anyway sent a user to argue with their library about headers
// that were already correct (`Access-Control-Allow-Origin: *`, in that case), which is worse than
// no diagnosis: it is a confident wrong one. See {@link ProbeRefusals} for the three-way split.

import type { FetchFn } from '../injection/store-image-fetch.js';
import type { RemoteImageService } from './image-service.js';
import { REMOTE_IIIF_LIMITS } from './remote-resource.js';

/** Which half of the gate refused, so a caller can say something specific. */
export type RemoteProbeStage =
	/** The `info.json` could not be read cross-origin. */
	| 'info'
	/** A tile could not be read cross-origin — the failure that renders a blank map. */
	| 'tile'
	/** The tile arrived, and is not the size it was asked for. */
	| 'geometry';

/**
 * This host's images cannot be drawn, and why.
 *
 * Separate from `RemoteIiifRejectedError` because the recovery is different: that one means the
 * document is wrong, this one means the *host's policy or server* is wrong, and the only things
 * the user can do about it are ask the institution to allow cross-origin reads or download the
 * image and add it from a file.
 */
export class RemoteImageUnusableError extends Error {
	readonly host: string;
	readonly url: string;
	readonly stage: RemoteProbeStage;
	/** How many times {@link url} was asked for before the gate gave up. */
	readonly attempts: number;
	/**
	 * Whether the evidence says asking again later might succeed.
	 *
	 * A field rather than only a turn of phrase in the message, because the two outcomes want
	 * different UI: a transient fault deserves a "Try again" button beside the sentence, and a host
	 * that refuses cross-origin reads deserves no such button — there is nothing for it to change.
	 * Nothing offers that button yet; the field is what makes offering it a change to one component
	 * rather than a re-derivation of the diagnosis from the prose.
	 */
	readonly transient: boolean;

	constructor(options: {
		host: string;
		url: string;
		stage: RemoteProbeStage;
		reason: string;
		attempts?: number;
		transient?: boolean;
	}) {
		super(options.reason);
		this.name = 'RemoteImageUnusableError';
		this.host = options.host;
		this.url = options.url;
		this.stage = options.stage;
		this.attempts = options.attempts ?? 1;
		this.transient = options.transient ?? false;
	}
}

/**
 * How a fetched tile's real pixel dimensions are measured.
 *
 * Injected because the browser's answer is `createImageBitmap`, which does not exist in Node,
 * and because *using* it is half the point: `createImageBitmap` on a `Blob` from a
 * non-CORS-readable response is precisely the operation `@allmaps/maplibre` performs before the
 * texture upload, so a probe that succeeds here has demonstrated the thing that matters rather
 * than argued for it.
 */
export type MeasureTile = (bytes: Blob) => Promise<{ width: number; height: number }>;

/** `createImageBitmap`, as the browser provides it. Not used in Node. */
export const measureTileWithImageBitmap: MeasureTile = async (bytes) => {
	const bitmap = await createImageBitmap(bytes);
	try {
		return { width: bitmap.width, height: bitmap.height };
	} finally {
		bitmap.close();
	}
};

/**
 * How many times one URL is asked for before the gate gives up on it.
 *
 * Three, and only for a transient fault (see the note at the top of this file). Two would not have
 * survived the host that prompted this — at one failure in five, two attempts still refuse a good
 * map 4% of the time, where three brings it under 1% — and more than three turns a genuinely dead
 * host into a minute of waiting before the user is told anything.
 */
export const PROBE_ATTEMPTS = 3;

/**
 * The waits before the second and third attempts, in milliseconds.
 *
 * Short, because a person is watching a dialog. The point of pausing at all is that the thing being
 * waited out is usually a derivative being generated or a worker being restarted, and asking again
 * instantly mostly just queues behind the same work.
 */
const TRANSIENT_BACKOFF_MS: readonly number[] = [500, 2000];

export type ProbeRemoteImageOptions = {
	readonly fetch: FetchFn;
	readonly measureTile: MeasureTile;
	readonly timeoutMs?: number;
	/**
	 * How the pause between attempts is taken. Injected so the tests can assert the retry policy
	 * without spending {@link TRANSIENT_BACKOFF_MS} of real time on every case.
	 */
	readonly delay?: (ms: number) => Promise<void>;
};

/**
 * What the gate found, when it did not refuse.
 *
 * **Nothing shows this yet.** It is returned so that a caller can tell the user which requests were
 * made on their behalf — the community lookup discloses itself (ADR-0015) and a probe of a third
 * party's server has the same claim on being disclosed — but the one call site,
 * `add-remote-map.svelte.ts`, discards it. Surfacing it is a line beside the "checking Allmaps…"
 * note in the add flow, listing {@link tileUrls}; until that exists the fields are asserted by
 * `cors-probe.test.ts` and read by nothing else, which is said here rather than left to be
 * discovered.
 */
export type RemoteImageProbe = {
	readonly host: string;
	/** Every tile URL that was fetched, in the order they were fetched. */
	readonly tileUrls: readonly string[];
	/** Whether a ragged tile was among them, and so whether the exact-resize check meant anything. */
	readonly checkedGeometry: boolean;
};

/**
 * Fetch `info.json` and one tile under CORS, and refuse the resource if either cannot be read.
 *
 * Throws {@link RemoteImageUnusableError} naming the host. Never resolves for a host whose tiles
 * would render blank.
 */
export async function probeRemoteImageService(
	service: RemoteImageService,
	options: ProbeRemoteImageOptions
): Promise<RemoteImageProbe> {
	const host = new URL(service.uri).hostname;
	const timeoutMs = options.timeoutMs ?? REMOTE_IIIF_LIMITS.timeoutMs;
	const infoUrl = `${service.uri}/info.json`;

	// The `info.json` half. It has already been fetched once to get here, but not necessarily by
	// the browser under CORS — a captured document, a mirrored copy, or an embedded service
	// description in a Manifest all reach `acceptRemoteImageService` without a cross-origin read.
	// Asking again is one request and removes the case where the gate only *looks* like it ran.
	await readOrRefuse(infoUrl, {
		...options,
		host,
		stage: 'info',
		timeoutMs,
		refusals: {
			subject: 'its description of this image',
			crossOrigin: (detail) =>
				`${host} will not let another website read its image descriptions${detail}. Ballastella ` +
				`needs to read ${infoUrl} from your browser, and this host does not send the ` +
				`Access-Control-Allow-Origin header that permits it. Nothing has been added. Ask whoever ` +
				`runs ${host} to allow cross-origin reads — most IIIF services do — or download the image ` +
				`and add it from a file.`,
			declined: (status) =>
				`${host} answered ${status} for ${infoUrl}. That is the image description Ballastella ` +
				`has to read before it can draw anything, so there is nothing to add. Check the address ` +
				`— if you copied it from a viewer page rather than from a “IIIF” link, it may name a page ` +
				`rather than the image service.`
		}
	});

	const tileUrls: string[] = [];

	for (const tile of service.probeTiles) {
		const tileUrl = tile.url;
		tileUrls.push(tileUrl);

		const synthesised = tile.scaleFactor === service.synthesisedCoarsestScaleFactor;
		const tileBytes = await readOrRefuse(tileUrl, {
			...options,
			host,
			stage: 'tile',
			timeoutMs,
			refusals: {
				subject: synthesised
					? 'the wider tile Ballastella needs to show the whole sheet at once'
					: 'a tile of this image',
				// CORS is a property of the host, not of which tile was asked for, so both kinds of probe
				// tile get the same sentence here. What differs between them is `declined` — see below.
				crossOrigin: (detail) =>
					`${host} serves its image descriptions to other websites but not its image ` +
					`tiles${detail}. Ballastella draws a Historical Map by uploading tiles into the ` +
					`graphics card, which the browser only permits for a response marked readable ` +
					`cross-origin — so this map would appear completely blank with nothing to say why. ` +
					`Nothing has been added. The tile that was refused is ${tileUrl}.`,
				declined: (status) =>
					synthesised
						? // A level this app worked out rather than one the service declared — see
							// `extendedTileset`. The service said it serves any region at any size, and a
							// definite answer proves it does not, so the honest report says exactly that.
							`${host} declares tiles only down to a zoom at which this image is still ` +
							`${Math.ceil(service.width / (service.tileSize * (service.synthesisedCoarsestScaleFactor ?? 1)))} ` +
							`tiles across, and it also declares that it serves any region at any size — so ` +
							`Ballastella asked for the wider tile it needs to show the whole sheet at once, and ` +
							`the answer was no — it answered ${status}. Nothing has been added. The request was ` +
							`${tileUrl}.`
						: // A tile the service's own `info.json` declares, refused by the service. Not a CORS
							// matter and not something the user can fix by asking for headers, so it does not
							// get the CORS sentence.
							`${host} answered ${status} for a tile its own image description says it serves. ` +
							`Ballastella asked for ${tileUrl}, which is the ${tile.request.size.width}×` +
							`${tile.request.size.height} tile at the corner of the sheet. Either this image is ` +
							`incomplete on the host or its description does not match what it will serve — ` +
							`nothing has been added, and this is one to report to whoever runs ${host}.`
			}
		});

		const requested = tile.request.size;
		let measured: { width: number; height: number };
		try {
			measured = await options.measureTile(tileBytes);
		} catch (cause) {
			throw new RemoteImageUnusableError({
				host,
				url: tileUrl,
				stage: 'tile',
				reason:
					`${host} answered for a tile, but your browser could not decode it as an image ` +
					`(${message(cause)}). Ballastella has to be able to read a tile's pixels to draw it, so ` +
					`this map would render blank. Nothing has been added. The tile was ${tileUrl}.`
			});
		}

		if (measured.width !== requested.width || measured.height !== requested.height) {
			throw new RemoteImageUnusableError({
				host,
				url: tileUrl,
				stage: 'geometry',
				reason:
					`${host} served a ${measured.width}×${measured.height} tile where Ballastella asked ` +
					`for ${requested.width}×${requested.height}. IIIF's size parameter means the returned ` +
					`image *is* exactly that many pixels, and Ballastella places every tile on that basis — ` +
					`so a service that rounds, pads, or substitutes a size draws this map slightly stretched ` +
					`at its right and bottom edges, which looks like an imprecise alignment rather than ` +
					`like a broken service. That is why this is refused instead of drawn. Nothing has been ` +
					`added; “make an offline copy” re-cuts the tiles with Ballastella's own geometry and ` +
					`avoids the problem entirely. The tile was ${tileUrl}.`
			});
		}
	}

	return { host, tileUrls, checkedGeometry: service.probeTileIsRagged };
}

/**
 * The three sentences one probed URL can be refused with, chosen by what the host actually did.
 *
 * Two are the caller's to write, because only the caller knows what this URL was for; the third is
 * composed from {@link subject} in {@link unavailableReason}, because "the host is having a bad
 * day" reads the same whatever was being fetched.
 */
type ProbeRefusals = {
	/**
	 * The browser would not let the response be read: a `fetch` that rejected with no status, or a
	 * body that could not be read. **This and only this is the CORS verdict** — the one the
	 * `Access-Control-Allow-Origin` and blank-map prose belongs to.
	 *
	 * @param detail a parenthesised aside naming the browser's own message
	 */
	readonly crossOrigin: (detail: string) => string;
	/**
	 * The host answered, and the answer was a definite no — a 4xx. It read the request, understood
	 * it, and declined; nothing about headers and nothing to retry.
	 */
	readonly declined: (status: number) => string;
	/**
	 * What the host failed to provide, as a noun phrase that follows "did not manage to serve".
	 * Used for the transient case only.
	 */
	readonly subject: string;
};

/** What one attempt at reading a URL produced. */
type Attempt =
	| { readonly ok: true; readonly bytes: Blob }
	/** The `fetch` rejected: no status, no headers, nothing but the browser's own message. */
	| { readonly ok: false; readonly fault: 'refused'; readonly detail: string }
	/** Nothing arrived inside the timeout. */
	| { readonly ok: false; readonly fault: 'timeout' }
	/** Something arrived, with a status that is not a success. */
	| { readonly ok: false; readonly fault: 'status'; readonly status: number }
	/** A response arrived and its body could not be read. */
	| { readonly ok: false; readonly fault: 'opaque'; readonly detail: string };

type Failed = Extract<Attempt, { ok: false }>;

/**
 * Whether asking again could plausibly give a different answer.
 *
 * A timeout and a 5xx are the host being busy or briefly broken. A 429 is the host asking to be
 * asked more slowly, which is exactly what the backoff does. Everything else is an answer.
 */
const isTransient = (attempt: Failed): boolean =>
	attempt.fault === 'timeout' ||
	(attempt.fault === 'status' && (attempt.status >= 500 || attempt.status === 429));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one URL, retrying a transient fault, and hand back its bytes or refuse.
 *
 * The refusal is chosen by the evidence — see {@link ProbeRefusals} and the note at the top of
 * this file. This function is where "the host did not answer" stopped being reported as "the host
 * forbids cross-origin reads".
 */
async function readOrRefuse(
	url: string,
	options: ProbeRemoteImageOptions & {
		host: string;
		stage: RemoteProbeStage;
		timeoutMs: number;
		refusals: ProbeRefusals;
	}
): Promise<Blob> {
	const wait = options.delay ?? sleep;
	let attempts = 0;
	let failure: Failed;

	for (;;) {
		if (attempts > 0) await wait(TRANSIENT_BACKOFF_MS[attempts - 1] ?? 0);
		attempts += 1;

		const attempt = await attemptRead(url, options);
		if (attempt.ok) return attempt.bytes;

		failure = attempt;
		if (attempts >= PROBE_ATTEMPTS || !isTransient(attempt)) break;
	}

	const refuse = (reason: string, transient = false) =>
		new RemoteImageUnusableError({
			host: options.host,
			url,
			stage: options.stage,
			reason,
			attempts,
			transient
		});

	switch (failure.fault) {
		case 'refused':
			throw refuse(options.refusals.crossOrigin(` (${failure.detail})`));
		case 'opaque':
			// An opaque response reaching here means somebody made the request `no-cors`. Reading its
			// body yields nothing, and that is the state this whole module exists to refuse.
			throw refuse(
				options.refusals.crossOrigin(` (its response could not be read: ${failure.detail})`)
			);
		case 'status':
			if (!isTransient(failure)) throw refuse(options.refusals.declined(failure.status));
			throw refuse(
				unavailableReason(options, url, attempts, `the last answer was ${failure.status}`),
				true
			);
		case 'timeout':
			throw refuse(
				unavailableReason(options, url, attempts, 'nothing came back inside the time allowed'),
				true
			);
	}
}

/**
 * The sentence for a host that is neither refusing nor answering — the one the flaky Cantaloupe
 * that prompted the retry policy earns.
 *
 * It says three things on purpose: that the fault is at the host, that it is not about the user's
 * Project or this particular map, and that trying again later is a reasonable thing to do. A user
 * who has just been told a map cannot be added will otherwise go looking for what they did wrong.
 */
function unavailableReason(
	options: { host: string; refusals: ProbeRefusals },
	url: string,
	attempts: number,
	detail: string
): string {
	const { host, refusals } = options;
	return (
		`${host} did not manage to serve ${refusals.subject}. Ballastella asked ${attempts} times, ` +
		`pausing between each, and ${detail}. That is a fault at the host — it says nothing about ` +
		`your Project or about this map, and a service that answers most requests and fails some is ` +
		`usually busy or briefly broken rather than unable to do it at all. Nothing has been added; ` +
		`trying again, now or in a few minutes, is often all it takes. The request was ${url}.`
	);
}

/**
 * One request, classified.
 *
 * Returns rather than throws, so that {@link readOrRefuse} owns the whole retry-and-refuse
 * decision and this function owns only "what did the network do".
 */
async function attemptRead(
	url: string,
	options: { fetch: FetchFn; timeoutMs: number }
): Promise<Attempt> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), options.timeoutMs);
	try {
		let response: Response;
		try {
			// No `mode` and no `credentials`: the page's own `fetch` defaults are `cors` and
			// `same-origin`, which is exactly the request `@allmaps/maplibre` will make. Setting
			// `mode: 'no-cors'` here would make the probe pass for every host on earth and hand back
			// an opaque response — the single most tempting way to make this gate useless.
			response = await options.fetch(url, { signal: abort.signal });
		} catch (cause) {
			// **A cross-origin `fetch` the host does not permit rejects**, so this branch is the real
			// CORS failure in a real browser. The timeout arrives here too, as an abort, and the two
			// must not be conflated — which is the whole point of the signal check.
			return abort.signal.aborted
				? { ok: false, fault: 'timeout' }
				: { ok: false, fault: 'refused', detail: message(cause) };
		}

		if (!response.ok) return { ok: false, fault: 'status', status: response.status };

		try {
			return { ok: true, bytes: await response.blob() };
		} catch (cause) {
			// The body can also be cut off by the timeout, mid-stream. That is a slow host, not an
			// unreadable response, and it is retried as one.
			return abort.signal.aborted
				? { ok: false, fault: 'timeout' }
				: { ok: false, fault: 'opaque', detail: message(cause) };
		}
	} finally {
		clearTimeout(timer);
	}
}

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

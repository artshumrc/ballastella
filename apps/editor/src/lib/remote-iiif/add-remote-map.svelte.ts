// Adding a Map Image from a IIIF URL: the state of that job, from paste to Layer.
//
// A class of its own rather than more fields on `EditorSession`, because none of it is
// `project.json`. Pasting a URL, browsing a Collection, reading a library's rights statement and
// asking Allmaps for existing work are all things that happen *before* a Project changes, and every
// one of them can be abandoned with nothing written. `EditorSession` stays the app's only writer of
// the document (and it is the one that does the writing at the end of this) — see `addSelected`.
//
// The order of operations is fixed, and it is the order that matters:
//
//   1. parse the URL, refusing what cannot be fetched at all;
//   2. read the resource, bounded, and describe it for the user;
//   3. the user selects a canvas — and **only its image service URI crosses** (ADR-0018);
//   4. read that service's `info.json` and run every pyramid guard;
//   5. probe CORS and geometry against the real host, before anything is written;
//   6. ask Allmaps, if the user has left that on;
//   7. and only then write.
//
// Nothing before step 7 touches the Project. A refusal at any earlier step leaves the Workspace
// exactly as it was, which is the same property Project import has and for the same reason.

import {
	COMMUNITY_ALIGNMENT_DISCLOSURE,
	RemoteImageResponseError,
	fetchRemoteImageFile,
	describeRemoteResource,
	findCommunityAlignments,
	imageServiceUriCrossingBoundary,
	measureTileWithImageBitmap,
	probeRemoteImageService,
	readRemoteIiifResource,
	readRemoteImageService,
	type Alignment,
	type CommunityAlignmentOffer,
	type DescribedResource,
	type FetchFn,
	type MapLayer,
	type RemoteIiifResource,
	type RemoteImageService
} from '@ballastella/core';

import type { EditorSession } from '../editor-session.svelte.js';
import { communityLookup } from './lookup-setting.svelte.js';
import { recordRemoteRequest } from './browser-test-handle.js';

/** Which step the job is on, for the region that announces it. */
export type AddRemoteStep =
	| 'idle'
	/** Fetching and parsing what the pasted URL names. */
	| 'reading'
	/** The resource is in hand; the user is choosing. */
	| 'choosing'
	/** Reading the chosen image service and probing its host. */
	| 'checking'
	/** The address was an image file, and its bytes are on their way here. */
	| 'downloading'
	/** Writing the Layer. */
	| 'adding';

export class AddRemoteMap {
	/**
	 * Read through a getter rather than captured, so this job always talks to the session the page is
	 * currently showing. Captured, it would keep writing into the session a *previous* Project was
	 * opened with — which is a `remote.json` written into somebody else's folder rather than an error.
	 */
	readonly #session: () => EditorSession;

	/** What the user has typed. */
	url = $state('');
	step = $state<AddRemoteStep>('idle');
	/** The refusal to show, in the words the core modules chose. `''` when there is nothing wrong. */
	error = $state('');
	/**
	 * Something that happened which the user did not ask for and would otherwise not find out about.
	 * `''` when there is nothing to say.
	 *
	 * Not an error — the Layer was added — and deliberately **not cleared by {@link reset}**, which
	 * runs the moment the add succeeds and takes the whole panel back to its empty state. A message
	 * about what just happened that vanishes with the thing that caused it is not a message.
	 */
	notice = $state('');

	/**
	 * The image file just downloaded and handed to the tiler, by name, or `''`.
	 *
	 * How this panel's caller learns that a paste turned out to be an image file rather than a IIIF
	 * resource: there is no Layer to hand back at that moment — the pyramid is still being cut, and
	 * `EditorSession.ingestImage` makes the Layer when it has one — so the surface closes on this the
	 * way it closes on a picked file, and the progress is on the Layer's own card.
	 */
	downloaded = $state('');

	/** The resource that was read, or `null`. Held so choosing costs no further request. */
	resource = $state<RemoteIiifResource | null>(null);
	/** Its label, rights, attribution and metadata as text. */
	described = $state<DescribedResource | null>(null);
	/** The canvas the user has picked, by its URI. `''` for a bare image service. */
	selectedCanvas = $state('');
	/** The IIIF resource URL that began this lookup, retained while opening Collection items. */
	sourceUrl = $state('');

	/** The accepted image service, once it has been read and probed. */
	service = $state<RemoteImageService | null>(null);
	/** What Allmaps had to say, or `null` before it was asked. */
	community = $state<CommunityAlignmentOffer | null>(null);
	/** Which community Alignment the user has chosen to import, by index. `-1` for none. */
	importIndex = $state(-1);

	constructor(session: () => EditorSession) {
		this.#session = session;
	}

	/** ADR-0015's one-line note, shown wherever the lookup can run. */
	readonly disclosure = COMMUNITY_ALIGNMENT_DISCLOSURE;

	/** Whether the lookup is on. Bound to the setting so the note and the request cannot disagree. */
	get lookupEnabled(): boolean {
		return communityLookup.enabled;
	}

	set lookupEnabled(next: boolean) {
		communityLookup.enabled = next;
	}

	/** The canvases the user may choose between, or `[]` for a bare image service. */
	get canvases() {
		return this.described?.canvases ?? [];
	}

	/** The items of a Collection the user may open, or `[]`. */
	get items() {
		return this.described?.items ?? [];
	}

	/**
	 * A `fetch` for a remote host.
	 *
	 * Deliberately the **ADR-0011 shim** rather than the bare `fetch`, even though nothing here is
	 * stored: the shim passes every non-placeholder host straight through unmodified, and routing
	 * remote reads through it is what keeps one answer to "how does this app fetch an image service".
	 * An offline copy then needs no second code path — the same call reaches the store.
	 *
	 * Wrapped so the Playwright suite can count what was requested, which is how "the lookup is off,
	 * so nothing is sent to annotations.allmaps.org" becomes a claim about the network.
	 */
	#fetch(): FetchFn {
		const shim = this.#session().imageServiceFetch();
		const through: FetchFn = shim ?? ((input, init) => fetch(input, init));
		return (input, init) => {
			recordRemoteRequest(
				typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
			);
			return through(input, init);
		};
	}

	/** Start again, with nothing written and nothing held. */
	reset(): void {
		this.url = '';
		this.step = 'idle';
		this.error = '';
		this.downloaded = '';
		this.resource = null;
		this.described = null;
		this.selectedCanvas = '';
		this.sourceUrl = '';
		this.service = null;
		this.community = null;
		this.importIndex = -1;
	}

	/**
	 * Read whatever the pasted URL names — a Manifest, a Collection, or a bare `info.json` — and
	 * describe it.
	 *
	 * One `@allmaps/iiif-parser` call for all three shapes (ADR-0015). A Collection is not a special
	 * case here: it arrives as a list of items to open, and opening one is another call to this same
	 * method, which is what makes "one URL from a library is enough" true.
	 */
	async read(url: string = this.url, fromCollection = false): Promise<void> {
		this.error = '';
		// Cleared here rather than in `reset`: the next lookup is the point at which what happened to
		// the *last* add stops being the news on this page.
		this.notice = '';
		this.service = null;
		this.community = null;
		this.importIndex = -1;
		this.selectedCanvas = '';
		this.step = 'reading';

		try {
			const resource = await readRemoteIiifResource(url, { fetch: this.#fetch() });
			this.url = url;
			this.sourceUrl = fromCollection && this.sourceUrl !== '' ? this.sourceUrl : resource.url;
			this.resource = resource;
			this.described = describeRemoteResource(resource.parsed, resource.document);
			this.step = 'choosing';
			// A Manifest with exactly one canvas has nothing to choose, and a bare image service has
			// nothing to choose either. Selecting for the user in those two cases is not a shortcut: it
			// is what makes pasting a bare image service URL one action rather than two.
			if (resource.kind === 'image') {
				await this.select(resource.parsed.uri);
			} else if (this.canvases.length === 1 && this.canvases[0]?.imageService) {
				await this.select(this.canvases[0].imageService);
			}
		} catch (cause) {
			this.step = 'idle';
			this.resource = null;
			this.described = null;
			// **An image file is a third thing the same box accepts**, and it is recognised by the
			// document that arrived rather than by the address: a URL ending `.jpg` may serve a Manifest,
			// and a IIIF-looking path may serve a JPEG. `readRemoteIiifResource` names it before it reads
			// the body, so nothing has been downloaded yet when this branch is taken.
			if (cause instanceof RemoteImageResponseError) {
				await this.#addImageFile(cause.url);
				return;
			}
			this.error = message(cause);
		}
	}

	/**
	 * Copy a plain image into the Workspace and cut its tiles (the third source's remote half).
	 *
	 * **A copy, and never a reference.** A IIIF image service is left where it is and drawn tile by
	 * tile; a single image file has no request that returns part of it, so there is nothing to
	 * reference — the only way to draw one is to hold its pixels. That makes this the file source with
	 * a download in front of it, and it goes through `EditorSession.ingestImage` for exactly that
	 * reason rather than growing a second ingest.
	 *
	 * The download is awaited here, with the panel saying so, because a host that 404s or refuses
	 * cross-origin reads has to be reported *in the panel the user is looking at*. Everything after it
	 * is the ingest's, whose progress is on the new Layer's card — so this returns as soon as the bytes
	 * are handed over, and the surface above closes.
	 */
	async #addImageFile(url: string): Promise<void> {
		const session = this.#session();
		// Asked before a megabyte is downloaded rather than after: `ingestImage` refuses a second file
		// while one is being prepared, and meeting that refusal at the end of a long download would
		// have spent the download for nothing.
		if (session.ingest !== null) {
			this.step = 'idle';
			this.error =
				`That address is an image file, which Ballastella copies into this Workspace and tiles ` +
				`here — and “${session.ingestLabel}” is still being prepared. One map is prepared at a ` +
				`time, so wait for that one to finish and look this address up again.`;
			return;
		}

		this.step = 'downloading';
		try {
			const file = await fetchRemoteImageFile(url, { fetch: this.#fetch() });
			this.reset();
			this.downloaded = file.name;
			// Not awaited, and not this panel's job to watch: the tiling is minutes of work on a large
			// scan, it reports on the Layer's card, and it can be cancelled from there.
			void session.ingestImage(file);
		} catch (cause) {
			this.step = 'idle';
			this.error = message(cause);
		}
	}

	/**
	 * The user has picked the canvas that is the map.
	 *
	 * `imageServiceUriCrossingBoundary` is the door in the wall (ADR-0018): a **string** crosses, and
	 * the alignment path re-parses from it independently, from its own fetch of its own `info.json`.
	 * Passing the parsed canvas below would compile and would work, right up to the point where this
	 * browsing step's reading of a document and the alignment path's are not the same — a library
	 * edits the Manifest, a canvas paints a Choice, a service is behind a redirect. Nothing is wrong
	 * anywhere and the map is misplaced.
	 *
	 * **Not a rule about two parsers.** Both sides of this boundary are `@allmaps/iiif-parser`; there
	 * is no `manifesto.js` in the editor at all (ADR-0018's amendment note). The rule outlives the
	 * two-parser reason for it; `parser-boundary.ts` carries the full statement.
	 */
	async select(selected: unknown): Promise<void> {
		this.error = '';
		this.service = null;
		this.community = null;
		this.importIndex = -1;
		this.step = 'checking';

		try {
			const uri = imageServiceUriCrossingBoundary(selected);
			this.selectedCanvas = this.canvases.find((canvas) => canvas.imageService === uri)?.uri ?? '';

			const service = await readRemoteImageService(uri, { fetch: this.#fetch() });
			// Before anything is written, and against the real host: ADR-0007's gate. Without it a host
			// that omits CORS on its tiles renders a blank map with no error anywhere.
			await probeRemoteImageService(service, {
				fetch: this.#fetch(),
				measureTile: measureTileWithImageBitmap
			});
			this.service = service;
			this.step = 'choosing';

			this.community = await findCommunityAlignments({
				enabled: this.lookupEnabled,
				image: service.pane.image,
				imageId: service.imageId,
				fetchAnnotations: (image) => this.#session().fetchCommunityAnnotations(image)
			});
			// Offer the first one, so "Import existing alignment — 3 found" is one click and not two.
			this.importIndex =
				this.community.state === 'found' && this.community.alignments.length > 0 ? 0 : -1;
		} catch (cause) {
			this.step = 'choosing';
			this.service = null;
			this.error = message(cause);
		}
	}

	/** How many community Alignments were offered. 0 when none, when off, or when unavailable. */
	get communityCount(): number {
		return this.community?.state === 'found' ? this.community.alignments.length : 0;
	}

	/** The Alignment the user has chosen to import, or `null`. */
	get chosenAlignment(): Alignment | null {
		if (this.community?.state !== 'found' || this.importIndex < 0) return null;
		return this.community.alignments[this.importIndex]?.alignment ?? null;
	}

	/**
	 * Write the Layer for a Map Image that stays on the library's server.
	 *
	 * Through `EditorSession`, because it is the app's only writer of `project.json` — the easiest
	 * rule in this application to break, and a breach of it destroys `name`, `updatedAt`, and
	 * `layers` while the indicator says "Saved".
	 *
	 * **A chosen community Alignment is a request, not a guarantee.** ADR-0023 gives a Map Image
	 * one Alignment, held in the Workspace and shared by every Project that draws it, so importing
	 * over one somebody has worked on would discard Control Points that may belong to a Project the
	 * user is not looking at. The session refuses that and says which way it went; the refusal is a
	 * {@link notice} rather than an {@link error} because the map *was* added and the Layer *is*
	 * there — but it is said, because staying quiet about a thing the user explicitly asked for and
	 * did not get is how they discover it in the wrong place a month later.
	 *
	 * @returns the Layer, or `null` when nothing was written
	 */
	async addSelected(): Promise<MapLayer | null> {
		const service = this.service;
		const described = this.described;
		if (!service || this.step === 'adding') return null;

		this.error = '';
		this.notice = '';
		this.step = 'adding';
		try {
			const canvasLabel = this.canvases.find(
				(canvas) => canvas.imageService === service.uri
			)?.label;
			const added = await this.#session().addReferencedMap({
				service,
				source: this.sourceUrl || described?.uri || service.uri,
				label: canvasLabel || described?.label || '',
				partOf: described?.kind === 'image' ? '' : (described?.uri ?? ''),
				canvas: this.selectedCanvas,
				rights: described?.rights ?? '',
				attribution: described?.attribution?.value ?? '',
				alignment: this.chosenAlignment
			});
			if (added === null) {
				this.error = this.#session().saveError || 'The Layer could not be written.';
				this.step = 'choosing';
				return null;
			}
			this.reset();
			if (added.keptExistingAlignment) this.notice = KEPT_EXISTING_ALIGNMENT;
			return added.layer;
		} catch (cause) {
			this.error = message(cause);
			this.step = 'choosing';
			return null;
		}
	}
}

/**
 * What the user is told when the community Alignment they chose was not written.
 *
 * Three things, in the order they need them: the Layer is there (so they do not add it again), the
 * import did not happen (so they do not assume it did), and *why* — which is the part that is not
 * guessable, because "one Alignment per Map Image, shared by every Project" is a property of
 * this application's storage rather than of anything on the screen (ADR-0023).
 */
const KEPT_EXISTING_ALIGNMENT =
	'The Layer was added, but the alignment you chose to import was not written. ' +
	'This Workspace already holds an Alignment for that Map Image, and a Map Image has ' +
	'one Alignment shared by every Project that draws it — importing over it would have discarded ' +
	'the Control Points already in it. The Layer draws the Alignment that was already there.';

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

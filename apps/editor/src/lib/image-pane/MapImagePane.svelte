<script lang="ts">
	// One Map Image of the Workspace, deep-zoomable — whether its tiles are in the Workspace or
	// on a Library's server.
	//
	// SPEC story 31. Ticket 03 built this pane over a committed fixture served by HTTP, which is
	// what let the synthetic projection be attacked before any storage existed; ticket 06 added the
	// other half of ADR-0011, so a Workspace-held pyramid's `info.json` and every tile come from the
	// `ProjectStore` through the injection shim and the pane works with no network at all (story 8).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHERE THE TILES COME FROM IS PASSED IN, NEVER DECIDED HERE (ticket 07)
	//
	// This component used to build `{ storedImageId: imageId }` and
	// `` `${imageServiceId(imageId)}/info.json` `` for itself, which made it the one place in the
	// application that hardcoded "the tiles are ours". A referenced map then asked the injection
	// layer for a pyramid that by definition is not in the Workspace: a blank pane, and no gesture
	// anywhere that could reach a Library's sheet.
	//
	// It takes an {@link ImagePaneSource} instead, built by `imagePaneSourceFor` — one value carrying
	// both halves, so a caller cannot hand over a Library's tile base with the store's `info.json`.
	// That combination is the failure worth designing against: the pane would draw a stranger's tiles
	// under our own pyramid's geometry, and every coordinate in the Alignment the scholar then places
	// would be wrong with nothing raising anywhere.
	//
	// **Aligning looks identical either way** (ticket 07's contract). Nothing below branches on which
	// arm `source.tiles` is — the offline notice reads `remoteHost`, which is *derived* from the value
	// rather than passed beside it, so there is no "remote mode" to get out of step with the tiles.
	//
	// The pyramid is loaded here rather than by the page, because which pyramid is on screen is a
	// question with a *load* behind it: switching Map Images replaces the pane, and a read that
	// resolves after the user has already moved on must not be allowed to draw the wrong map.

	import {
		createImagePane,
		type FetchFn,
		type ImagePane,
		type ImagePaneSource,
		type ResourcePoint
	} from '@ballastella/core';
	import { onDestroy, untrack, type Snippet } from 'svelte';

	import { useInstalledApp } from '$lib/pwa/installed-app.svelte.js';

	import type { ImageReadout } from './ImageDetails.svelte';
	import ImagePaneView, { type PaneOverlayPoint } from './ImagePane.svelte';

	let {
		imageId,
		source,
		fetchTile,
		label,
		overlayPoints = [],
		maskRing = [],
		onclickpoint,
		onpane,
		onreadout,
		frameClass = 'mt-3 h-96',
		controls
	}: {
		/**
		 * Which Map Image of the Workspace this is.
		 *
		 * Identity only: it keys the tile-protocol registration, names the map in a failure, and is
		 * what a stale read compares itself against. It is deliberately **not** where the bytes come
		 * from — that is {@link source}, and conflating the two is what this component used to do.
		 */
		imageId: string;
		/** Where this map's tiles and `info.json` are. Built by `imagePaneSourceFor`, never here. */
		source: ImagePaneSource;
		/** The ADR-0011 shim. Answers the placeholder host out of the store, passes a Library through. */
		fetchTile: FetchFn;
		/** Accessible name for the map region, from the page. */
		label: string;
		/** Control Points' image halves, and the pending half when it is on this pane (ticket 07). */
		overlayPoints?: PaneOverlayPoint[];
		/** The Alignment's Resource Mask, in image pixels. This pane only: the mask has no meaning on
		 * the Base Map, which speaks lng/lat (ticket 08's out-of-scope note). */
		maskRing?: readonly ResourcePoint[];
		/** An image pixel the user clicked, which is how a Control Point is started (ADR-0022). */
		onclickpoint?: (point: ResourcePoint) => void;
		/**
		 * The pyramid, once it has been read.
		 *
		 * Reported rather than loaded twice. Everything above this component that needs the image's
		 * pixel dimensions — the Alignment's Resource Mask, the Control Point coordinate space — needs
		 * exactly what this pane is drawing, and a second `createImagePane` on the same `info.json`
		 * would be a second answer that can disagree.
		 */
		onpane?: (pane: ImagePane) => void;
		/**
		 * The pyramid and view readout, for a screen that wants to place it (`ImageDetails.svelte`), or
		 * `null` when there is nothing on screen to describe.
		 */
		onreadout?: (readout: ImageReadout | null) => void;
		/**
		 * The classes on the box the canvas fills.
		 *
		 * **Passed in, because how tall this pane is belongs to the screen and not to the pane.** The
		 * default is the fixed 24rem that `/image-pane` and every earlier caller drew; the alignment
		 * screen hands over `lg:grow` instead, so the sheet takes whatever height is left beside the Base
		 * Map rather than a number this component guessed. A pane deciding its own height is what made
		 * `/align` a tall scrolling page with two small windows on it.
		 *
		 * Only the box: the canvas inside it is `h-full` either way, so a caller cannot hand over
		 * something that leaves the pane with no height at all without also saying so out loud.
		 */
		frameClass?: string;
		/**
		 * Extra controls for the pane's own row — the screen's, not the pane's.
		 *
		 * The alignment screen puts Crop here: it acts on the sheet in this pane, so it belongs on the
		 * pane's control row rather than on a row of its own beneath it.
		 */
		controls?: Snippet;
	} = $props();

	let pane: ImagePane | undefined = $state.raw();
	let shownImageId = $state('');
	let failure = $state('');
	let tilesLoaded = $state(false);
	let mapZoom = $state(0);
	let pointer = $state<{ x: number; y: number } | undefined>();

	/**
	 * The pyramid, zoom and pointer readout, handed to whoever is placing it (`ImageDetails.svelte`).
	 *
	 * **Reported rather than rendered here**, because where a diagnostic belongs is the screen's
	 * question: the alignment screen puts it in its sidebar with everything else that is about the work
	 * rather than about the gesture, which is height the sheet gets back. The numbers are still this
	 * pane's — they are the pyramid it read and the view it is showing — so nothing above it computes
	 * them a second time.
	 *
	 * `null` while there is nothing on screen, so a readout cannot outlive the map it describes.
	 */
	$effect(() => {
		const built = pane;
		const id = shownImageId;
		onreadout?.(built && id !== '' ? { imageId: id, pane: built, mapZoom, pointer } : null);
	});

	onDestroy(() => onreadout?.(null));

	/**
	 * The app's one online signal (ADR's "do not add a second online/offline listener"; ticket 07's
	 * out-of-scope list says so outright). `InstalledApp` owns the single pair of listeners and is
	 * provided by the root layout, which this route is under.
	 */
	const installedApp = useInstalledApp();

	/**
	 * The host serving this map's tiles, or `''` when the Workspace holds them.
	 *
	 * **Derived from {@link source} rather than passed beside it.** A `remoteHost` prop would be a
	 * second claim about the same fact, and the version of this component where the two disagreed is
	 * one that names the wrong server in a refusal a scholar is meant to act on. `source.tiles` being
	 * a string *is* "somebody else serves this" — that is what the `ImagePaneTileBase` union means.
	 */
	const remoteHost = $derived.by(() => {
		if (typeof source.tiles !== 'string') return '';
		try {
			return new URL(source.tiles).hostname;
		} catch {
			return '';
		}
	});

	/**
	 * Bumped by every load, so a read that resolves late knows it has been superseded. The same
	 * guard `EditorSession.open` needs and for the same reason: reading a pyramid is asynchronous,
	 * and the user can pick another one while it is in flight.
	 */
	let generation = 0;

	/**
	 * Bumped to ask for the pyramid again. See {@link reopenWhenTheConnectionReturns}.
	 *
	 * A separate signal rather than making the load effect depend on `installedApp.online` directly,
	 * and the difference is the whole of ticket 07's "offline, after the pane exists: keep working".
	 * An effect that read `online` would re-run the moment the connection dropped — tearing down a
	 * pane a scholar was mid-alignment on and replacing it with a refusal, which is exactly the
	 * "blocking would discard an alignment legitimately in progress" the contract forbids. Measured:
	 * the first cut of this did that, and the e2e caught it.
	 */
	let reopenAttempt = $state(0);

	$effect(() => {
		const wanted = imageId;
		const { tiles, infoUrl } = source;
		void reopenAttempt;
		// **Read untracked.** The refusal below needs to know whether there is a connection *now*;
		// it must not make losing one a reason to re-run. See {@link reopenAttempt}.
		const connected = untrack(() => installedApp.online);
		const mine = ++generation;

		// Cleared straight away: a stale pane on screen under a new map's name is a coordinate
		// claim about the wrong image, which is the one failure this pane must never have.
		pane = undefined;
		shownImageId = '';
		failure = '';
		tilesLoaded = false;

		void (async () => {
			try {
				// **Refused before the request, and only for a referenced map** (ticket 07). The
				// `info.json` is on the Library's server, so with no connection the pane cannot be
				// built at all — and `remote.json` carries width and height but *not* the tileset, so
				// synthesising a pane from it would be guesswork drawn as fact. A Workspace-held
				// pyramid is unaffected: it is read out of the store and has never needed the network.
				if (!connected && typeof tiles === 'string') {
					throw new Error(
						`this Map Image's sheet is served by ${remoteHost || 'another server'}, and ` +
							`there is no connection. Its tiles were never copied into this Workspace, and the ` +
							`record beside it says how big the image is but not how it is cut into tiles — so ` +
							`there is nothing to draw and nothing safe to guess. Reconnect and this pane opens ` +
							`by itself.`
					);
				}

				// The same `fetch` as the tiles, so there is exactly one way into a pyramid rather
				// than one for the document and one for its bytes. The shim answers the placeholder
				// host out of the store and passes a Library's host straight to the network, which is
				// what makes this one line serve both arms of `source`.
				const response = await fetchTile(infoUrl);

				if (!response.ok) {
					throw new Error(
						`its info.json could not be read from ${remoteHost || 'this Workspace'} ` +
							`(${response.status} ${response.statusText})`
					);
				}

				const built = createImagePane(await response.json(), tiles);
				if (mine !== generation) return;
				pane = built;
				shownImageId = wanted;
				onpane?.(built);
			} catch (cause) {
				if (mine !== generation) return;
				// ADR-0008: a Map Image that cannot be read is a normal state to render, not an
				// unhandled rejection. `createImagePane` refuses a pyramid whose shape would render
				// plausibly but wrongly, and that refusal explains itself — so it is shown, not
				// swallowed.
				failure = `“${wanted}” could not be opened: ${
					cause instanceof Error ? cause.message : String(cause)
				}`;
			}
		})();
	});

	/**
	 * A referenced map that could not be opened offline opens itself when the connection returns.
	 *
	 * Without this the refusal is permanent until the user finds the reload button, which is a poor
	 * answer to a state the app can see resolve. Guarded on there being no pane, so a connection
	 * flapping while somebody is aligning does not re-read a pyramid that is already on screen —
	 * which would re-frame the Base Map and discard the pairing under their hands.
	 *
	 * `pane` is read untracked for that reason as well: this effect is about the *connection*
	 * changing, and making it depend on the pane it conditionally causes would be a loop.
	 *
	 * The transition is what is watched, not the value. Acting on `online === true` alone would fire
	 * on mount — when it is ordinarily true and the pane has not been built yet — and cost every
	 * referenced map a second read of its `info.json` before the first one had returned.
	 */
	let wasOnline = true;
	$effect(() => {
		const online = installedApp.online;
		const returned = online && !wasOnline;
		wasOnline = online;
		if (!returned || remoteHost === '') return;
		if (untrack(() => pane) !== undefined) return;
		reopenAttempt += 1;
	});

	/**
	 * Whether the sheet on screen has stopped arriving because the connection went.
	 *
	 * **Only once the pane exists, and it blocks nothing** (ticket 07's contract). The pane's
	 * coordinate space is the `info.json`'s, not the tiles', so it stays valid whether or not any
	 * bytes arrive — a click at a given place is the same image pixel either way. Refusing to place
	 * Control Points here would discard an alignment legitimately in progress to protect the user
	 * from something they can see perfectly well.
	 */
	const offlineAfterOpening = $derived(
		pane !== undefined && remoteHost !== '' && !installedApp.online
	);
</script>

{#if failure}
	<div role="alert" class="alert max-w-prose alert-warning" data-testid="map-image-failure">
		<p>{failure}</p>
	</div>
{:else if pane}
	<!--
		The sheet has gone but the work has not (ticket 07). Visible text rather than a colour or a
		tooltip (SPEC story 111, ADR-0016), and it names the host — "offline" alone does not tell a
		scholar *whose* server stopped answering, which is the only part of this they can act on.

		`aria-live="polite"` and not `role="alert"`: losing the connection is a change of circumstance
		rather than a mistake the user is making, and the fold warning above already owns `alert` on
		this screen. It says outright that Control Points still work, because a pane that has gone
		blank is the moment a user assumes it does not.

		⚠ **The region is outside the `{#if}` and the notice is inside it, and that is the whole of the
		announced half.** This app has settled the point twice in writing — `ReviewBanner.svelte` and
		`UpdatePrompt.svelte` both say it — because a live region *inserted at the same moment as its
		first text* is not reliably announced: there was no region for the change to be a change to.
		The first version of this had `aria-live` on the alert itself, inside the branch, so the visible
		half worked and the announced half never fired. The empty wrapper costs a `<div>` and is the
		only thing that makes this reach a screen-reader user at all.

		`role="alert"` would have avoided the problem, since `alert` announces on insertion — which is
		exactly why the neighbouring `role="alert"` regions on this screen are correct as they stand.
		It is the wrong role here: this is a change of circumstance, not a mistake being made.
	-->
	<div aria-live="polite" data-testid="map-image-offline-region">
		{#if offlineAfterOpening}
			<div
				class="mb-3 alert max-w-prose alert-warning"
				data-testid="map-image-offline"
				data-offline-host={remoteHost}
			>
				<p>
					There is no connection, and this Map Image’s sheet is served by {remoteHost}, so no more
					of it will arrive until you are back online. You can carry on placing Control Points — the
					pane still knows where every image pixel is, so they will be in the right place.
				</p>
			</div>
		{/if}
	</div>

	<!-- One row for the screen's pane controls and whether the view has settled. -->
	<div class="flex h-10 flex-wrap items-center gap-2">
		{@render controls?.()}

		<!--
			Whether the view has settled (SPEC story 96) — **a spinner while it has not, and nothing at all
			once it has**, plus the sentence for a screen reader.

			The visible half only says the interesting thing. A mark that stayed on the row at rest read as a
			stray dot beside the buttons: a permanent glyph for a state that is true almost always carries no
			information and cannot be told from decoration. Loading is what a user needs to see, and it goes
			when it stops being true.

			The words themselves stay, in `sr-only` text inside a live region present from the first frame —
			never a `title`, which ADR-0016 keeps out of the information channel — and the spinner is
			`aria-hidden` so the two are not announced twice.
		-->
		<p
			class="text-sm"
			aria-live="polite"
			data-testid="map-image-tiles"
			data-tiles-loaded={tilesLoaded}
		>
			{#if !tilesLoaded}
				<span class="loading loading-xs loading-spinner" aria-hidden="true"></span>
			{/if}
			<span class="sr-only">
				{tilesLoaded ? 'All tiles for this view have loaded.' : 'Loading tiles…'}
			</span>
		</p>
	</div>

	<div class="{frameClass} overflow-hidden rounded-box border border-base-300">
		<!--
			Keyed on the image, so switching Map Images builds a new map rather than repointing
			the old one. The tile protocol's registry is populated in `onMount`, and MapLibre's own
			tile cache is keyed by URL under a source that would not have changed — a repointed pane
			would draw the previous pyramid's cached tiles under the new map's coordinates.
		-->
		{#key shownImageId}
			<ImagePaneView
				{pane}
				paneId={shownImageId}
				{fetchTile}
				{label}
				{overlayPoints}
				{maskRing}
				{onclickpoint}
				onview={(view) => {
					mapZoom = view.mapZoom;
					pointer = view.pointer;
					tilesLoaded = view.tilesLoaded;
				}}
			/>
		{/key}
	</div>
{:else}
	<p aria-live="polite">Opening the Map Image…</p>
{/if}

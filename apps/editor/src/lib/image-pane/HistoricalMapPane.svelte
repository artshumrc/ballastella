<script lang="ts">
	// One Historical Map of the Workspace, deep-zoomable — whether its tiles are in the Workspace or
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
	// question with a *load* behind it: switching Historical Maps replaces the pane, and a read that
	// resolves after the user has already moved on must not be allowed to draw the wrong map.

	import {
		createImagePane,
		type FetchFn,
		type ImagePane,
		type ImagePaneSource,
		type ResourcePoint
	} from '@ballastella/core';
	import { untrack } from 'svelte';

	import { useInstalledApp } from '$lib/pwa/installed-app.svelte.js';

	import ImagePaneView, { type PaneOverlayPoint } from './ImagePane.svelte';

	let {
		imageId,
		source,
		fetchTile,
		label,
		overlayPoints = [],
		maskRing = [],
		onclickpoint,
		onpane
	}: {
		/**
		 * Which Historical Map of the Workspace this is.
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
	} = $props();

	let pane: ImagePane | undefined = $state.raw();
	let shownImageId = $state('');
	let failure = $state('');
	let paneView: ReturnType<typeof ImagePaneView> | undefined = $state.raw();
	let tilesLoaded = $state(false);
	let mapZoom = $state(0);
	let pointer = $state<{ x: number; y: number } | undefined>();

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
						`this Historical Map's sheet is served by ${remoteHost || 'another server'}, and ` +
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
				// ADR-0008: a Historical Map that cannot be read is a normal state to render, not an
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

	const pixel = (point: { x: number; y: number }) =>
		`${Math.round(point.x)}, ${Math.round(point.y)}`;
</script>

{#if failure}
	<div role="alert" class="alert max-w-prose alert-warning" data-testid="historical-map-failure">
		<p>{failure}</p>
	</div>
{:else if pane}
	{@const projection = pane.projection}
	<!--
		The sheet has gone but the work has not (ticket 07). Visible text rather than a colour or a
		tooltip (SPEC story 111, ADR-0016), and it names the host — "offline" alone does not tell a
		scholar *whose* server stopped answering, which is the only part of this they can act on.

		`aria-live="polite"` and not `role="alert"`: losing the connection is a change of circumstance
		rather than a mistake the user is making, and the fold warning above already owns `alert` on
		this screen. It says outright that Control Points still work, because a pane that has gone
		blank is the moment a user assumes it does not.
	-->
	{#if offlineAfterOpening}
		<div
			class="mb-3 alert max-w-prose alert-warning"
			aria-live="polite"
			data-testid="historical-map-offline"
			data-offline-host={remoteHost}
		>
			<p>
				There is no connection, and this Historical Map’s sheet is served by {remoteHost}, so no
				more of it will arrive until you are back online. You can carry on placing Control Points —
				the pane still knows where every image pixel is, so they will be in the right place.
			</p>
		</div>
	{/if}

	<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Historical Map view">
		<button class="btn btn-sm" onclick={() => paneView?.fitImage()}>Fit whole map</button>
		<button class="btn btn-sm" onclick={() => paneView?.zoomToFullResolution()}>
			Zoom to full resolution
		</button>
		<button class="btn btn-sm" onclick={() => paneView?.zoomBy(-1)}>Zoom out one level</button>
		<button class="btn btn-sm" onclick={() => paneView?.zoomBy(1)}>Zoom in one level</button>
	</div>

	<div class="mt-3 h-96 overflow-hidden rounded border border-base-300">
		<!--
			Keyed on the image, so switching Historical Maps builds a new map rather than repointing
			the old one. The tile protocol's registry is populated in `onMount`, and MapLibre's own
			tile cache is keyed by URL under a source that would not have changed — a repointed pane
			would draw the previous pyramid's cached tiles under the new map's coordinates.
		-->
		{#key shownImageId}
			<ImagePaneView
				bind:this={paneView}
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

	<!--
		The geometry of the pyramid on screen, as text. It is genuinely useful — it is how a user
		tells two scans of the same sheet apart — and it is also the only way a test can say *which*
		pyramid is being drawn, since a pyramid read out of OPFS issues no request to observe.
	-->
	<dl
		class="mt-3 grid gap-x-4 text-sm sm:grid-cols-2"
		data-testid="historical-map-pyramid"
		data-image-id={shownImageId}
		data-width={pane.image.width}
		data-height={pane.image.height}
	>
		<dt class="font-medium">Pyramid</dt>
		<dd>
			{pane.image.width} × {pane.image.height} pixels, {pane.tileSize}-pixel tiles, scale factors
			{pane.image.tileZoomLevels.map((level) => level.scaleFactor).join(', ')}
		</dd>
		<dt class="font-medium">Zoom</dt>
		<dd>
			<span data-testid="historical-map-zoom">{mapZoom.toFixed(4)}</span>
			of {projection.fullResolutionMapZoom} at full resolution
		</dd>
		<dt class="font-medium">Pointer</dt>
		<dd data-testid="historical-map-pointer">{pointer ? pixel(pointer) : '—'}</dd>
	</dl>

	<p
		class="mt-1 text-sm"
		aria-live="polite"
		data-testid="historical-map-tiles"
		data-tiles-loaded={tilesLoaded}
	>
		{tilesLoaded ? 'All tiles for this view have loaded.' : 'Loading tiles…'}
	</p>
{:else}
	<p aria-live="polite">Opening the Historical Map…</p>
{/if}

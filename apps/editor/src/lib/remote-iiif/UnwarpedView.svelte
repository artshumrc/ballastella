<script lang="ts">
	// A Historical Map read as a document rather than as geography (SPEC story 48).
	//
	// This is triiiceratops, imported from its **`./svelte` export as an ordinary Svelte component**
	// and never as the web component (ADR-0018). The web-component export is the right choice for
	// framework-agnostic embedding, which is not the situation: Svelte 5 is a declared peer, the
	// integration wants to hand in objects rather than attributes, and web-component style isolation
	// would fight the theme (ADR-0016).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE PARSER BOUNDARY, HELD
	//
	// What crosses into this component is a `ReferencedImage` — a record of *our* Project — and what
	// crosses into triiiceratops is a URL, or a Manifest built from one. Nothing parsed by
	// `@allmaps/iiif-parser` is handed over, and nothing parsed by `manifesto.js` comes back.
	//
	// When the map was reached through a library's Manifest, that Manifest's **URL** is what
	// triiiceratops gets: it fetches and parses the library's own document itself, which is exactly
	// the arrangement ADR-0018 describes. Only a bare image service needs `unwarpedManifest`, and
	// that document is built from the service URI and the pixel dimensions and from nothing else.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// A LOCALLY INGESTED PYRAMID CANNOT BE SHOWN HERE YET, AND THAT IS UPSTREAM
	//
	// ADR-0011 and this ticket both call for a custom OpenSeadragon `TileSource` resolving through the
	// `ProjectStore`, passed in as a prop. `storedPyramidTileSource` in `@ballastella/core` is that
	// object, and it is tested — but **triiiceratops 1.0.0-rc.35 has no way to accept one.**
	// `TriiiceratopsViewer` takes `manifestId`, `manifestJson`, `canvasId`, `plugins`, `config`, and
	// `viewerState`; its `tileSources` are derived internally from the canvases by
	// `getViewerTileSources`, and the value is always a URL string or `{ type: 'image', url }`. The
	// plugin API is for panels and flyouts. `config.openSeadragonConfig` reaches OpenSeadragon's own
	// options, but the internal `$effect` on `tileSources` calls `viewer.open()` and replaces whatever
	// was constructed.
	//
	// A stored pyramid has no URL, and OpenSeadragon's default loader puts `getTileUrl`'s answer into
	// an `<img src>` — which no `fetch` shim can intercept, and which a service worker is the only
	// other answer to (ADR-0011 rejects that on File System Access permission semantics). So this is
	// an upstream prop, not a workaround: see the ticket. In the meantime a locally ingested map is
	// still readable unwarped, in the image pane from ticket 03, which draws it through the same shim.

	import type { ReferencedImage } from '@ballastella/core';
	import { TriiiceratopsViewer } from 'triiiceratops/svelte';
	import 'triiiceratops/style.css';

	import { theme } from '../theme.svelte.js';
	import { unwarpedManifest } from './unwarped-manifest.js';

	let { image, onclose }: { image: ReferencedImage; onclose?: () => void } = $props();

	/**
	 * The library's own Manifest where there is one, and a wrapper where there is not.
	 *
	 * Never both interpretations of one document: where triiiceratops can fetch and parse the
	 * library's Manifest itself, it is given the **URL** and nothing else, because handing over a
	 * `manifestJson` built from *our* reading of a document it could read itself is exactly what
	 * ADR-0018 forbids.
	 *
	 * **`manifestJson` needs `manifestId` beside it.** Measured against
	 * `triiiceratops@1.0.0-rc.35`: `TriiiceratopsViewer`'s effect is
	 * `if (manifestId && manifestJson) { setManifestData(…) }`, so `manifestJson` on its own does
	 * nothing at all — the viewer mounts its chrome over an empty area and logs at a debug level that
	 * is off by default. The id is not a second fetch; it is the key the manifest is cached under, and
	 * the document is supplied, so nothing is requested from it.
	 */
	const source = $derived(
		image.partOf === ''
			? { manifestId: `${image.service}/manifest.json`, manifestJson: unwarpedManifest(image) }
			: { manifestId: image.partOf, ...(image.canvas === '' ? {} : { canvasId: image.canvas }) }
	);

	/**
	 * What triiiceratops said went wrong, if anything did.
	 *
	 * Its `onviewererror` channel exists so a host can present a failure "without scraping the
	 * console", and taking it is not optional here: the failure mode of an embedded tile viewer is a
	 * blank rectangle, which is precisely the unactionable outcome this whole ticket's CORS gate is
	 * written against. A panel that says nothing is a support request.
	 */
	let viewerError = $state('');
</script>

<div class="mt-4" data-testid="unwarped-view">
	<div class="flex items-center justify-between gap-4">
		<h4 class="font-semibold">{image.label || image.imageId}</h4>
		{#if onclose}
			<button
				class="btn btn-ghost btn-sm"
				type="button"
				data-testid="unwarped-close"
				onclick={onclose}
			>
				Close
			</button>
		{/if}
	</div>
	<p class="mt-1 text-sm opacity-70">
		Read as a document: the sheet unwarped, so its cartouche and inscriptions are legible.
	</p>

	<!--
		A **definite** height, not `min-h`. triiiceratops' root sizes itself at `height: 100%`, and 100%
		of a parent whose `height` is `auto` resolves to auto — so with `min-h` the viewer laid out at
		zero pixels tall, OpenSeadragon never built a container, and the panel rendered its toolbar over
		nothing. Measured: `#triiiceratops-viewer` was 830 × **0**.
	-->
	<div class="mt-3 h-[32rem] overflow-hidden rounded-box border border-base-300">
		<!--
			`theme` is triiiceratops' own light/dark switch, driven from the app's one theme signal —
			ADR-0016 asks for a single source of truth rather than two toggles that happen to agree, and
			an embedded viewer with its own idea of the theme is exactly that second toggle.
		-->
		<TriiiceratopsViewer
			{...source}
			theme={theme.current}
			onviewererror={(error) => (viewerError = error.message || 'This image could not be shown.')}
		/>
	</div>

	{#if viewerError}
		<div role="alert" class="mt-3 alert max-w-prose alert-warning">
			<p data-testid="unwarped-error">
				{new URL(image.service).hostname} could not show this image: {viewerError}
			</p>
		</div>
	{/if}
</div>

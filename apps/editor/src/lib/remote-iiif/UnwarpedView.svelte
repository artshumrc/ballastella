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
	 * Deliberately one or the other and never both: handing over `manifestJson` built from our reading
	 * of a document triiiceratops could fetch itself would put our parser's interpretation inside its
	 * navigation, which is the one thing ADR-0018 forbids.
	 */
	const source = $derived(
		image.partOf === ''
			? { manifestJson: unwarpedManifest(image) }
			: { manifestId: image.partOf, ...(image.canvas === '' ? {} : { canvasId: image.canvas }) }
	);
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
		A fixed height, because OpenSeadragon measures its container and a container that sizes itself
		from its content collapses to nothing. `min-h` rather than `h` so a narrow window can grow it.
	-->
	<div class="mt-3 min-h-[28rem] overflow-hidden rounded-box border border-base-300">
		<!--
			`theme` is triiiceratops' own light/dark switch, driven from the app's one theme signal —
			ADR-0016 asks for a single source of truth rather than two toggles that happen to agree, and
			an embedded viewer with its own idea of the theme is exactly that second toggle.
		-->
		<TriiiceratopsViewer {...source} theme={theme.current} />
	</div>
</div>

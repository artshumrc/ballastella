<script lang="ts">
	// A Map Image read as a document rather than as geography.
	//
	// triiiceratops, imported from its **`./svelte` export as an ordinary Svelte component** and never as
	// the web component (ADR-0018): Svelte 5 is a declared peer, the integration hands in objects rather
	// than attributes, and web-component style isolation would fight the theme (ADR-0016).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHY THIS WORKS HERE AND COULD NOT IN THE EDITOR
	//
	// The editor's own `UnwarpedView` can only show a *referenced* image, and says so at length: ADR-0011
	// calls for a custom OpenSeadragon `TileSource` resolving through the `ProjectStore`, core has one and
	// it is tested, and **triiiceratops 1.0.0-rc.35 has no way to accept it** — `tileSources` are derived
	// internally from the canvases and are always a URL. A stored pyramid has no URL, and OpenSeadragon's
	// default loader puts `getTileUrl`'s answer into an `<img src>`, which no `fetch` shim can intercept.
	//
	// On a Published Site that limitation simply does not apply: the pyramid **is** a set of static files
	// beside `index.html`, so it has a real URL and OpenSeadragon can fetch it with nothing injected. This
	// is the one place where publishing makes a feature possible rather than merely visible, and it is why
	// reading a Map Image unwarped is a Reader's feature rather than an author's.
	//
	// What crosses into triiiceratops is a Manifest built by `$lib/unwarped-manifest` over this site's own
	// address. It is not the published `manifest.json`: every `id` in that document is the ADR-0004
	// `unset.invalid` placeholder, so read verbatim it draws nothing — see that module.

	import { TriiiceratopsViewer } from 'triiiceratops/svelte';
	import 'triiiceratops/style.css';

	import { theme } from '$lib/theme.svelte';

	let {
		label,
		manifestId,
		manifest,
		onclose
	}: {
		/** What the Reader sees this Map Image called: the Layer's name. */
		label: string;
		/**
		 * The key the Manifest is cached under.
		 *
		 * **`manifestJson` needs `manifestId` beside it.** Measured against `triiiceratops@1.0.0-rc.35`:
		 * the viewer's effect is `if (manifestId && manifestJson) { setManifestData(…) }`, so
		 * `manifestJson` alone does nothing at all — the viewer mounts its chrome over an empty area and
		 * logs at a debug level that is off by default. The id is not a second fetch; the document is
		 * supplied, so nothing is requested from it.
		 */
		manifestId: string;
		manifest: unknown;
		onclose?: () => void;
	} = $props();

	/**
	 * What triiiceratops said went wrong, if anything did.
	 *
	 * Its `onviewererror` channel exists so a host can present a failure "without scraping the console",
	 * and taking it is not optional on a Published Site: the failure mode of an embedded tile viewer is a
	 * blank rectangle, and a Reader has no console and nobody to ask.
	 */
	let viewerError = $state('');
</script>

<section class="mt-4" data-testid="unwarped-view" aria-labelledby="unwarped-heading">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 id="unwarped-heading" class="text-lg font-semibold">{label}</h2>
		{#if onclose}
			<button class="btn btn-sm" type="button" data-testid="unwarped-close" onclick={onclose}>
				Back to the map
			</button>
		{/if}
	</div>
	<p class="mt-1 max-w-prose text-sm opacity-70">
		Read as a document: the sheet unwarped, so its cartouche and inscriptions are legible.
	</p>

	<!--
		A **definite** height, not `min-h`. triiiceratops' root sizes itself at `height: 100%`, and 100% of
		a parent whose `height` is `auto` resolves to auto — so with `min-h` the viewer lays out at zero
		pixels tall, OpenSeadragon never builds a container, and the panel renders its toolbar over
		nothing. Measured in the editor: `#triiiceratops-viewer` was 830 × **0**.

		Shorter on a small screen, because 32rem of tile viewer on a 375 px phone leaves no room for the
		heading above it or the way back.
	-->
	<div class="mt-3 h-[24rem] overflow-hidden rounded-box border border-base-300 sm:h-[32rem]">
		<!--
			`theme` is triiiceratops' own light/dark switch, driven from this app's one theme signal —
			ADR-0016 asks for a single source of truth rather than two toggles that happen to agree, and an
			embedded viewer with its own idea of the theme is exactly that second toggle.
		-->
		<TriiiceratopsViewer
			{manifestId}
			manifestJson={manifest}
			theme={theme.current}
			onviewererror={(error) => (viewerError = error.message || 'This image could not be shown.')}
		/>
	</div>

	{#if viewerError}
		<div role="alert" class="mt-3 alert max-w-prose alert-warning">
			<p data-testid="unwarped-error">
				This Map Image could not be shown: {viewerError}
			</p>
		</div>
	{/if}
</section>

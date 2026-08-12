<script lang="ts">
	import MapGlyph from '@lucide/svelte/icons/map';
	import type { FetchFn, WorkspaceHistoricalMap } from '@ballastella/core';

	/**
	 * The picture of one Historical Map: its own coarsest pyramid tile, in a fixed box (ADR-0030).
	 *
	 * **Nothing is generated to make this work.** A level-0 pyramid's scale factors double until the
	 * whole sheet fits inside one tile, so its coarsest level is already a whole-sheet derivative of at
	 * most 256 × 256, and `listWorkspaceHistoricalMaps` has already worked out its URL. This component's
	 * one job is turning that URL into pixels.
	 *
	 * **Loading, absent, and failed are one visual and there is no state machine.** The glyph fills the
	 * box from the first frame and is replaced when an image decodes. Distinguishing "still arriving"
	 * from "not available" is deliberately out: for a Workspace-held map the wait is a single small read,
	 * and a list that flickered through a skeleton per card would be worse than one that does not.
	 */
	let {
		map,
		fetchTile
	}: {
		map: WorkspaceHistoricalMap;
		/**
		 * The ADR-0011 injection shim, from `session.imageServiceFetch()`.
		 *
		 * A stored tile has no URL a browser can follow — `<img src>` cannot reach OPFS or a picked
		 * folder — so the bytes come through the same extension point every other consumer of a
		 * Historical Map's pixels uses, and become an object URL here. A service worker serving the
		 * store at a virtual path is refused for the reason ADR-0011 gives.
		 */
		fetchTile: FetchFn;
	} = $props();

	/** The object URL the picture is drawn from, or `null` while there is none — which is the glyph. */
	let picture = $state<string | null>(null);

	// ⚠ **The two facts the picture depends on, read through `$derived` so that the effect below
	// re-runs on their VALUES and not on the record's identity.** `refreshHistoricalMaps` replaces the
	// whole listing with freshly built records on every refresh — creating a Project is one — so an
	// effect that read `map.thumbnail` directly re-ran for a map nothing had happened to: it revoked a
	// live object URL, blanked the picture back to the glyph, and read the tile again. These are
	// strings, so a rebuilt record carrying the same two values invalidates nothing and ADR-0030's
	// "created on mount and revoked on unmount" holds.
	const url = $derived(map.thumbnail);
	const tiles = $derived(map.tiles);

	// Re-runs when either of those values changes, which is what an Offline Copy completing looks like
	// from here: `tiles` moves to `in-workspace` and a URL appears where there was none.
	$effect(() => {
		// A referenced map's bytes are on a Library's server and are ticket 03's: its URL goes straight
		// into the element, with `loading="lazy"`, and never through the shim. Until then it shows the
		// glyph, which is the same thing a scholar sees when a picture cannot be resolved at all.
		if (url === null || tiles !== 'in-workspace') return;

		let unmounted = false;
		let created: string | null = null;

		void (async () => {
			try {
				const response = await fetchTile(url);
				// ⚠ **Before the body, not after.** A missing tile answers with a non-ok response whose
				// body is the refusal's own text, and an object URL over that decodes as nothing: an empty
				// box that is laid out, visible, and indistinguishable from a picture that has not arrived.
				if (!response.ok) return;
				const blob = await response.blob();
				if (unmounted) return;
				created = URL.createObjectURL(blob);
				picture = created;
			} catch {
				// The glyph stands in. Nothing here claims to have failed: a Workspace-held map whose tile
				// cannot be read is ADR-0028's residual, recorded there and deliberately not reported.
			}
		})();

		// ⚠ **Revoked on unmount, and never on a timer.** `save-file.ts` revokes on a `setTimeout`
		// because a download only needs the URL for an instant; here the element needs it for as long as
		// it is on screen, and revoking underneath it destroys the picture.
		return () => {
			unmounted = true;
			if (created !== null) URL.revokeObjectURL(created);
			picture = null;
		};
	});
</script>

<!--
	A leading child of the card's existing flex row, and the card stays a row: the picture joins the
	facts already beside the name rather than turning the list into a gallery.

	`shrink-0` and a fixed box, with `width` and `height` on the element itself, so a card does not
	change shape as pictures resolve at wildly different times — clicking Delete on the right map must
	not be a moving target.
-->
<div class="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden">
	{#if picture === null}
		<MapGlyph size={96} class="opacity-30" aria-hidden="true" data-testid="map-thumbnail-glyph" />
	{:else}
		<!--
			`object-contain` and never `object-cover`: a sheet's proportions are information, and a
			panoramic map reduces to a legitimate sliver rather than being cropped into something wrong.

			`max-h-full max-w-full` rather than a filled 96 px box, so nothing is ever upscaled without
			qualification. `object-contain` alone only holds that promise for a source larger than the
			box, and the coarsest level of a sheet smaller than one tile has scale factor 1 — a 60 × 40
			scan would be enlarged to fill 96 px and shown blurrier than it is.

			`alt=""` deliberately. The map's name is immediately adjacent, and there is no useful
			alternative text for a picture of a map — "Thumbnail of …" would make a screen reader say the
			name twice. Not a link, not a button, no click handler and no `tabindex`: nothing here invites
			a click that leads nowhere, and reaching Delete takes the keystrokes it took before.
		-->
		<img
			src={picture}
			alt=""
			width="96"
			height="96"
			class="max-h-full max-w-full object-contain"
			data-testid="map-thumbnail-image"
		/>
	{/if}
</div>

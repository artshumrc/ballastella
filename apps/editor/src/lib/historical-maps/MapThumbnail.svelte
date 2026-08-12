<script lang="ts">
	import MapGlyph from '@lucide/svelte/icons/map';
	import type { FetchFn, WorkspaceHistoricalMap } from '@ballastella/core';

	/**
	 * The picture of one Historical Map: its own coarsest pyramid tile, in a fixed box (ADR-0030).
	 *
	 * **Nothing is generated to make this work.** A level-0 pyramid's scale factors double until the
	 * whole sheet fits inside one tile, so its coarsest level is already a whole-sheet derivative, and
	 * `listWorkspaceHistoricalMaps` has already worked out its URL. This component's one job is turning
	 * that URL into pixels.
	 *
	 * **The derivative is bounded by the tile side, which is the *service's* and not always ours.** A
	 * Workspace-held map is on this app's 256, so its picture is at most 256 × 256. A Library declaring
	 * 512- or 1024-pixel tiles yields a correspondingly larger one — still a single request and still not
	 * the sheet, but do not read the 96-pixel box as a claim about how many bytes arrive.
	 *
	 * **Two sources and one element**, because where the bytes are is already answered by `map.tiles`. A
	 * Workspace-held map's tile is read through the ADR-0011 shim and becomes an object URL here; a
	 * referenced map's picture is a plain URL on the Library's own server, which the element fetches
	 * itself and lazily.
	 *
	 * **Loading, absent, and failed are one visual and there is no state machine.** The glyph fills the
	 * box from the first frame and is replaced when an image decodes, and a load that fails goes back to
	 * it — so a Library that has gone away looks like an absence rather than like a bug in the tool. Distinguishing "still arriving"
	 * from "not available" is deliberately out: for a Workspace-held map the wait is a single small read,
	 * and a list that flickered through a skeleton per card would be worse than one that does not.
	 */
	let {
		map,
		fetchTile,
		size = 96
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
		/**
		 * The box's side in pixels. ADR-0030's 96 by default, which is the hub card's.
		 *
		 * The picker's rows are laid out far more tightly than the hub's cards, so they ask for a smaller
		 * box. A number rather than a class because it is also the `width`/`height` attributes and the
		 * glyph's own size, all of which have to agree.
		 */
		size?: number;
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

	/**
	 * The source that failed to load, so the glyph stands in for it.
	 *
	 * A value rather than a boolean flag, and no effect to clear it: a new source is by definition one
	 * that has not failed yet, so an Offline Copy completing — or a re-render carrying a different URL —
	 * shows the picture again without anything having to remember to reset this.
	 */
	let failedSource = $state<string | null>(null);

	/**
	 * What the `<img>` is drawn from, or `null` for the glyph.
	 *
	 * ⚠ **The two tile locations reach the element by different mechanisms, and this is the whole of the
	 * difference** (ADR-0030). A referenced map's picture is a plain URL on the Library's own server: it
	 * goes straight into `src`, lazily, with no fetch and nothing to revoke. Routing it through the
	 * ADR-0011 shim *would work* — the shim passes non-placeholder hosts to the network — and would
	 * pointlessly buffer the bytes and discard the laziness.
	 */
	const source = $derived(tiles === 'referenced' ? url : picture);
	const shown = $derived(source !== null && source !== failedSource ? source : null);

	// Re-runs when either of those values changes, which is what an Offline Copy completing looks like
	// from here: `tiles` moves to `in-workspace` and a URL appears where there was none.
	$effect(() => {
		// Only a Workspace-held map's bytes come through the shim; a referenced map's URL needs no reading
		// at all, so there is nothing for this effect to do for one.
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
	`object-contain` and never `object-cover`: a sheet's proportions are information, and a panoramic map
	reduces to a legitimate sliver rather than being cropped into something wrong.

	`max-h-full max-w-full` rather than a filled box, so nothing is ever upscaled without qualification.
	`object-contain` alone only holds that promise for a source larger than the box, and the coarsest
	level of a sheet smaller than one tile has scale factor 1 — a 60 × 40 scan would be enlarged to fill
	the box and shown blurrier than it is.

	`alt=""` deliberately. The map's name is immediately adjacent, and there is no useful alternative
	text for a picture of a map — "Thumbnail of …" would make a screen reader say the name twice. Not a
	link, not a button, no click handler and no `tabindex`: nothing here invites a click that leads
	nowhere, and reaching Delete takes the keystrokes it took before.

	⚠ **`loading="lazy"` for a referenced map only, and the asymmetry is deliberate.** It keeps requests
	to the Libraries whose cards a scholar can actually see. For a Workspace-held map the bytes have
	already been read by the time an object URL exists, so deferring the element saves nothing and would
	imply a saving that does not exist.
-->
{#snippet sheet(from: string, lazy: boolean)}
	<img
		src={from}
		alt=""
		width={size}
		height={size}
		loading={lazy ? 'lazy' : undefined}
		class="max-h-full max-w-full object-contain"
		data-testid="map-thumbnail-image"
		onerror={() => (failedSource = from)}
	/>
{/snippet}

<!--
	A leading child of a row that stays a row, at both call sites: the hub's cards and the picker's
	candidate list. The picture joins the facts already beside the name rather than turning either list
	into a gallery.

	`shrink-0` and a fixed box, with `width` and `height` on the element itself, so a row does not change
	shape as pictures resolve at wildly different times — clicking Delete on the right map, or the right
	candidate in the picker, must not be a moving target.

	An inline `style` for the box because the side is a prop: Tailwind's JIT cannot consume a dynamic
	arbitrary value, and a lookup table of size classes would be worse than this.
-->
<div
	class="flex shrink-0 items-center justify-center overflow-hidden"
	style="width: {size}px; height: {size}px"
>
	{#if shown === null}
		<MapGlyph {size} class="opacity-30" aria-hidden="true" data-testid="map-thumbnail-glyph" />
	{:else}
		{@render sheet(shown, tiles === 'referenced')}
	{/if}
</div>

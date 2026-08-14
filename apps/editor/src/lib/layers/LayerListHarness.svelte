<script lang="ts">
	// A parent for `LayerList` in component tests. **Not shipped and not imported by the app.**
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// WHY A REAL COMPONENT RATHER THAN REPLACING `layers` FROM THE TEST BODY
	//
	// `LayerList` does not reorder anything. It calls `onmove` and waits for the stack to come back
	// changed — and then, one microtask later, restores the keyboard to the button that moved
	// (`moveByButton`, and story 53 gets exactly one keypress without it).
	//
	// That `await tick()` is the whole reason this file exists. In the running application the
	// parent's `$state` is updated *synchronously* inside `onmove`, so by the time the tick resolves
	// the keyed `{#each}` has already moved the node and the focus restoration finds the button in
	// its new place. A test that instead awaited the click and then assigned a new `layers` array
	// would reorder **after** that microtask had already passed, so focus restoration would run
	// against the old order — and the test would report a focus bug that the application does not
	// have, or worse, pass for a reason that has nothing to do with the behaviour.
	//
	// So the harness is the smallest honest parent: `$state` layers, reordered in place by `onmove`.
	// `moveLayer` is `core`'s own — the ordering rules are its (ADR-0002) and have their own unit
	// tests; what is under test here is what `LayerList` does about focus and announcement once a
	// parent has reordered.

	import { moveLayer, type Layer, type MapLayer } from '@ballastella/core';
	import type { DrawnOutcome } from '@ballastella/core/render';

	import LayerList from './LayerList.svelte';

	let {
		layers: initial,
		outcomes = {},
		referencedImageIds = new Set<string>(),
		openLayerId: initialOpen = null,
		onmove
	}: {
		layers: readonly Layer[];
		outcomes?: Readonly<Record<string, DrawnOutcome>>;
		referencedImageIds?: ReadonlySet<string>;
		openLayerId?: string | null;
		/** Reported as well as applied, so a test can assert what the component asked for. */
		onmove?: (id: string, toIndex: number) => void;
	} = $props();

	let layers = $state([...initial]);
	let openLayerId = $state(initialOpen);

	/** The ids in the order they are rendered, for a test to read without walking the DOM. */
	export const order = (): string[] => layers.map((layer) => layer.id);
</script>

<!--
	The three snippets the Project screen supplies, as markers that carry nothing but the Layer they
	were rendered for.

	`LayerList` decides **whether and where** each is drawn — beside a refused Layer's sentence, inside
	an open map card, inside an open Annotation card — and the screen decides what goes in them. So a
	marker is the whole of what can honestly be asserted from here: that the card asked, and for which
	Layer. What the screen puts inside is `ProjectScreen`'s, and asserting it against a snippet written
	in this file would be asserting this file. The Align link, its href and which refusals are
	actionable therefore stay in `e2e/editor-layers.e2e.ts`.
-->
{#snippet problemAction(layer: Layer)}
	<span data-testid="harness-problem-action" data-layer-id={layer.id}></span>
{/snippet}

{#snippet mapContents(layer: MapLayer)}
	<span data-testid="harness-map-contents" data-layer-id={layer.id}></span>
{/snippet}

{#snippet annotationContents()}
	<span data-testid="harness-annotation-contents"></span>
{/snippet}

<LayerList
	{problemAction}
	{mapContents}
	{annotationContents}
	{layers}
	{outcomes}
	{referencedImageIds}
	{openLayerId}
	onopen={(id) => (openLayerId = id)}
	ontypename={() => {}}
	oncommit={() => {}}
	onshow={() => {}}
	ondragopacity={() => {}}
	onmove={(id, toIndex) => {
		onmove?.(id, toIndex);
		layers = [...moveLayer(layers, id, toIndex)];
	}}
	ondelete={(id) => (layers = layers.filter((layer) => layer.id !== id))}
/>

<script lang="ts">
	// A parent for `AnnotationList` in component tests. **Not shipped and not imported by either app.**
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// WHY A REAL COMPONENT RATHER THAN REPLACING `openId` FROM THE TEST BODY
	//
	// The same argument `LayerListHarness.svelte` makes. `AnnotationList` owns none of the state its
	// own gestures change: a click on a row calls `onopen` and then waits for the answer to come back
	// down as a prop. In the running application the screen updates that `$state` synchronously inside
	// the callback, so the row has opened or closed by the time the click returns. A test that
	// assigned a new `openId` afterwards would be asserting its own assignment rather than the
	// component's behaviour, and would still pass if the component stopped reporting the gesture.
	//
	// The snippets are **markers rather than the real thing**, for the reason `LayerListHarness`
	// supplies markers for `mapContents`: whether and where the list renders a snippet is this
	// component's and is asserted here; what a consumer puts inside one is that consumer's.

	import { moveAnnotation, type Annotation } from '@ballastella/core';
	import { untrack } from 'svelte';

	import AnnotationList from './AnnotationList.svelte';

	let {
		annotations,
		openId: initialOpenId = null,
		withTools = false,
		withGuidance = false,
		withMoving = false,
		onopen
	}: {
		annotations: readonly Annotation[] | null;
		openId?: string | null;
		/** Whether this consumer has a drawing surface to offer. A published site has none. */
		withTools?: boolean;
		/** Whether this consumer has anything to say about an empty Layer. A Reader is told nothing. */
		withGuidance?: boolean;
		/**
		 * Whether this consumer can reorder. A published site cannot, so a row it renders has neither
		 * the handle nor the buttons — which is a claim of its own and needs the prop to be absent
		 * rather than passed as `undefined`.
		 */
		withMoving?: boolean;
		/** Reported as well as applied, so a test can assert what the component asked for. */
		onopen?: (id: string | null) => void;
	} = $props();

	// Seeded once, then the harness's own: after the first render the open row is whatever the last
	// gesture asked for, which is the point of the harness.
	let openId = $state(untrack(() => initialOpenId));

	/**
	 * The Annotations on screen now, seeded from the prop and then changed through {@link show}.
	 *
	 * **So that a shorter collection can arrive as a prop update rather than as a second mount.** A
	 * consumer that deletes an Annotation hands this list the survivors and nothing else happens: the
	 * component is not unmounted, and a row that had captured its number when it was first rendered
	 * would go on showing the old one. A test that mounted twice could not tell the two apart.
	 *
	 * `$state.raw` because the collection is replaced whole and never mutated in place, which is what
	 * the consumer does — and it keeps the Annotations the test passed the same objects the list is
	 * handed.
	 */
	let shown = $state.raw(untrack(() => annotations));

	/** Hand the list a different collection, the way a consumer does after a delete. */
	export const show = (next: readonly Annotation[] | null): void => {
		shown = next;
	};
</script>

{#snippet tools()}
	<div data-testid="harness-annotation-tools">Draw</div>
{/snippet}

{#snippet noAnnotationsGuidance()}
	<span data-testid="harness-annotation-guidance">Nothing in this Layer yet. Draw one.</span>
{/snippet}

<!--
	Spread rather than `tools={withTools ? tools : undefined}`, because the two are not the same prop
	set: under `exactOptionalPropertyTypes` a consumer that passes `undefined` has still passed the
	prop. What is being tested is a consumer that never mentions it.
-->
<AnnotationList
	annotations={shown}
	{openId}
	onopen={(id) => {
		onopen?.(id);
		openId = id;
	}}
	{...withTools ? { tools } : {}}
	{...withGuidance ? { noAnnotationsGuidance } : {}}
	{...withMoving
		? {
				// `moveAnnotation` is `core`'s own — the ordering rules are its and have their own unit
				// tests — so what this harness supplies is a real consumer, not a second implementation.
				onmove: (id: string, toIndex: number) => {
					shown = moveAnnotation({ annotations: shown ?? [] }, id, toIndex).annotations;
				}
			}
		: {}}
/>

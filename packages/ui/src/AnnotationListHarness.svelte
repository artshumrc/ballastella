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
	// The two snippets are **markers rather than the real contents**, for the reason
	// `LayerListHarness` supplies markers for `mapContents`: whether and where the list renders a
	// snippet is this component's and is asserted here; what a consumer puts inside one is that
	// consumer's.

	import type { Annotation } from '@ballastella/core';
	import { untrack } from 'svelte';

	import AnnotationList from './AnnotationList.svelte';

	let {
		annotations,
		openId: initialOpenId = null,
		withContents = false,
		withTools = false,
		onopen
	}: {
		annotations: readonly Annotation[];
		openId?: string | null;
		/** Whether this consumer reveals anything at all inside an open row. */
		withContents?: boolean;
		/** Whether this consumer has a drawing surface to offer. A published site has none. */
		withTools?: boolean;
		/** Reported as well as applied, so a test can assert what the component asked for. */
		onopen?: (id: string | null) => void;
	} = $props();

	// Seeded once, then the harness's own: after the first render the open row is whatever the last
	// gesture asked for, which is the point of the harness.
	let openId = $state(untrack(() => initialOpenId));
</script>

{#snippet contents(annotation: Annotation)}
	<div data-testid="harness-annotation-contents" data-annotation-id={annotation.id}>
		<button type="button" data-testid="harness-annotation-delete">Delete</button>
	</div>
{/snippet}

{#snippet tools()}
	<div data-testid="harness-annotation-tools">Draw</div>
{/snippet}

<!--
	Spread rather than `contents={withContents ? contents : undefined}`, because the two are not the
	same prop set: under `exactOptionalPropertyTypes` a consumer that passes `undefined` has still
	passed the prop. What is being tested is a consumer that never mentions it.
-->
<AnnotationList
	{annotations}
	{openId}
	onopen={(id) => {
		onopen?.(id);
		openId = id;
	}}
	{...withContents ? { contents } : {}}
	{...withTools ? { tools } : {}}
/>

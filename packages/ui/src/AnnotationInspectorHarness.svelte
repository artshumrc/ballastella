<script lang="ts">
	// A parent for `AnnotationInspector` in component tests. **Not shipped and not imported by either app.**
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// WHY A REAL COMPONENT RATHER THAN REPLACING PROPS FROM THE TEST BODY
	//
	// The same argument `AnnotationListHarness.svelte` makes. Two of this component's claims are about
	// what happens when a *new* `annotation` arrives while the panel is on screen — a different one,
	// which resets the face, and a fresh object carrying the same id, which must not. Neither is a
	// claim about mounting, so neither can be made by mounting twice: a component that read the id once
	// when it was first rendered would satisfy both and would still slam the face shut on the next
	// keystroke. {@link show} is how a test hands the panel already on the screen a different object.
	//
	// **`onclose` is reported and deliberately not acted on.** In the running application the consumer
	// clears its own selection and the panel goes; here it stays, so a test can assert that the
	// Inspector changed nothing about itself in response to a gesture whose answer belongs to somebody
	// else.
	//
	// The two snippets are **markers rather than the real faces**, for the reason
	// `AnnotationListHarness` supplies markers for `contents`: whether and where the Inspector renders
	// a snippet is this component's and is asserted here; what a consumer puts inside one is that
	// consumer's.

	import type { Annotation } from '@ballastella/core';
	import { untrack } from 'svelte';

	import AnnotationInspector from './AnnotationInspector.svelte';

	let {
		annotation,
		index,
		withStyle = false,
		onclose
	}: {
		annotation: Annotation;
		index: number;
		/** Whether this consumer has a Style face to offer. A Reader has none. */
		withStyle?: boolean;
		/** Reported so a test can assert what the Inspector asked for. */
		onclose?: () => void;
	} = $props();

	/**
	 * The Annotation on screen now, seeded from the prop and then changed through {@link show}.
	 *
	 * `$state.raw` because an Annotation is replaced whole and never mutated in place, which is what
	 * the consumer does — and it keeps the object the test passed the same object the Inspector is
	 * handed, which is the whole subject of the same-id guard's test.
	 */
	let shown = $state.raw(untrack(() => annotation));

	/** Hand the Inspector a different Annotation, the way a consumer does when the selection moves. */
	export const show = (next: Annotation): void => {
		shown = next;
	};
</script>

{#snippet text(annotation: Annotation)}
	<div data-testid="harness-inspector-text" data-annotation-id={annotation.id}>Text face</div>
{/snippet}

{#snippet style(annotation: Annotation)}
	<div data-testid="harness-inspector-style" data-annotation-id={annotation.id}>Style face</div>
{/snippet}

<!--
	Spread rather than `style={withStyle ? style : undefined}`, because the two are not the same prop
	set: under `exactOptionalPropertyTypes` a consumer that passes `undefined` has still passed the
	prop. What is being tested is a consumer that never mentions it — which is the viewer.
-->
<AnnotationInspector
	annotation={shown}
	{index}
	{text}
	onclose={() => onclose?.()}
	{...withStyle ? { style } : {}}
/>

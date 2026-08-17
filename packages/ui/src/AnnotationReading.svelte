<script lang="ts">
	// An Annotation as somebody who cannot change it reads it: its title, and its description rendered
	// (one-shell-two-apps stories 32 and 33).
	//
	// ⚠ **The title below is a Svelte interpolation, and that is the whole of what makes it safe.** A
	// title is a stranger's text as much as a description is — a Project may have arrived by zip import
	// or from a remote library — but the DOM never parses an interpolation as markup, so nothing about
	// it reaches a sanitiser and nothing about it needs to. Turning it into `{@html}` would be the
	// vulnerability. The description is safe for an entirely different reason, which is
	// `AnnotationDescription`'s to state: read that file's header before changing anything about
	// either.
	//
	// ⚠ **A surface that already names the Annotation must render `AnnotationDescription` directly
	// rather than this component**, or one Annotation is titled twice a few pixels apart in the same
	// weight, which reads as two fields (the-annotation-inspector story 4). That is why the editor's
	// Text face inside `AnnotationInspector`, whose identity header carries the name, composes the
	// description on its own.

	import type { Annotation } from '@ballastella/core';

	import AnnotationDescription from './AnnotationDescription.svelte';
	import { annotationName } from './annotation-name.js';

	let {
		annotation,
		index
	}: {
		annotation: Annotation;
		/**
		 * Where this Annotation sits in its collection, counted from zero.
		 *
		 * Read for one thing: an untitled Annotation's number. Without it this surface had wording of
		 * its own — "Untitled" under a button reading "Untitled pin 3", one Annotation named two ways a
		 * few pixels apart.
		 */
		index: number;
	} = $props();

	const properties = $derived(annotation.properties);
</script>

<div class="flex min-w-0 flex-col gap-1">
	<!--
		The same name the button above it carries, from `annotation-name.ts` rather than from wording
		invented here: one Annotation, one name.
	-->
	<p class="font-semibold" data-testid="annotation-title-text">
		{#if properties.title}
			{properties.title}
		{:else}
			<span class="font-normal opacity-60">{annotationName(annotation, index)}</span>
		{/if}
	</p>

	<AnnotationDescription {annotation} />
</div>

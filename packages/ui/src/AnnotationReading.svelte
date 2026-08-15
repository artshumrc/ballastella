<script lang="ts">
	// An Annotation as somebody who cannot change it reads it: its title, and its description rendered
	// (SPEC stories 32 and 33).
	//
	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// ⚠ THIS IS THE ONE SURFACE IN THIS PACKAGE WHERE A BUG IS A SECURITY VULNERABILITY
	//
	// A `description` is a stranger's text. A Project may have arrived by zip import or from a remote
	// library, and a Published Site runs on the author's own domain — `student.github.io`, or
	// `maps.digitalhumanities.harvard.edu` — so an unsanitised description rendered here is stored XSS
	// there (ADR-0009).
	//
	// So the two fields are safe for **two different reasons**, and neither may be swapped for the
	// other:
	//
	//   - the **title** is a Svelte interpolation. The DOM never parses it as markup, so nothing about
	//     it reaches a sanitiser and nothing about it needs to. Turning it into `{@html}` would be the
	//     vulnerability.
	//   - the **description** is `renderDescription`'s output and nothing else. That is core's one
	//     function that runs `marked` and then DOMPurify, in that order and not separately reachable.
	//     `{@html}` is correct here and only here, and only because the string has been through the
	//     sanitiser with no path into this expression that has not.
	//
	// **It lives in this package rather than in the viewer** so that a published site's own source
	// carries no `{@html}` at all: the sanitised rendering comes from shared code that both apps
	// compile, which is what makes `e2e/viewer-reader.e2e.ts`'s inertness claim a claim about the
	// thing that actually ships.

	import {
		isDescriptionRendererSupported,
		renderDescription,
		type Annotation
	} from '@ballastella/core';
	import { onMount } from 'svelte';

	let { annotation }: { annotation: Annotation } = $props();

	const properties = $derived(annotation.properties);

	/**
	 * Whether this component has mounted in a browser.
	 *
	 * Both apps prerender (ADR-0006) and DOMPurify needs a DOM, so the renderer refuses in Node rather
	 * than degrading to returning its input unsanitised — the safe direction, since a fallback would
	 * write an XSS payload into a static file.
	 *
	 * It also sidesteps a Svelte hydration rule worth knowing: **`{@html}` is not re-rendered during
	 * hydration.** Svelte adopts the nodes the server produced and never compares them against the
	 * client's value, so a `{@html}` that was `''` on the server and complete HTML on the client would
	 * render nothing at all, permanently, with no warning — and **a blank description passes every "is
	 * the payload inert?" assertion there is.** That is why every payload test in
	 * `e2e/viewer-reader.e2e.ts` asserts the prose *arrived* before asserting what did not.
	 */
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	/** The description as sanitised HTML, or `''` where there is none or it cannot be rendered. */
	const rendered = $derived(
		mounted && properties.description && isDescriptionRendererSupported()
			? renderDescription(properties.description)
			: ''
	);
</script>

<div class="min-w-0">
	<p class="font-semibold" data-testid="annotation-title-text">
		{#if properties.title}
			{properties.title}
		{:else}
			<span class="font-normal opacity-60">Untitled</span>
		{/if}
	</p>

	<div
		class="prose-sm mt-1 prose max-w-none"
		data-testid="annotation-description-text"
		aria-label="Description"
	>
		{#if rendered === ''}
			<p class="text-sm opacity-60">No description.</p>
		{:else}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html rendered}
		{/if}
	</div>
</div>

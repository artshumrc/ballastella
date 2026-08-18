<script lang="ts">
	// An Annotation's description, rendered rather than shown as Markdown source
	// (one-shell-two-apps story 33).
	//
	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// ⚠ THIS IS THE ONE SURFACE IN THIS PACKAGE WHERE A BUG IS A SECURITY VULNERABILITY
	//
	// A `description` is a stranger's text. A Project may have arrived by zip import or from a remote
	// library, and a Published Site runs on the author's own domain — `student.github.io`, or
	// `maps.digitalhumanities.harvard.edu` — so an unsanitised description rendered here is stored XSS
	// there (ADR-0009).
	//
	// The `{@html}` below is fed `renderDescription`'s output **and nothing else**. That is core's one
	// function that runs `marked` and then DOMPurify, in that order and not separately reachable.
	// `{@html}` is correct here and only here, and only because the string has been through the
	// sanitiser with no path into this expression that has not.
	//
	// ⚠ **An Annotation's title is safe for an entirely different reason, and the two may not be
	// swapped for each other.** A title is a Svelte interpolation wherever it is drawn — `AnnotationRow`
	// and `AnnotationInspector`'s identity header — so the DOM never parses it as markup, nothing about
	// it reaches a sanitiser, and nothing about it needs to. Rendering a title through this component's
	// mechanism would be the vulnerability.
	//
	// ⚠ **Both apps compose this directly, and neither draws a title beside it.** The Inspector's header
	// already names the Annotation from the rule its row draws from (ADR-0035), so a face that titled it
	// again would put one title twice a few pixels apart in the same weight
	// (the-annotation-inspector story 4).
	//
	// **It lives in this package rather than in the viewer** so that a published site's own source
	// carries no `{@html}` at all: the sanitised rendering comes from shared code that both apps
	// compile, which is what makes `e2e/viewer-reader.e2e.ts`'s inertness claim
	// (the-annotation-inspector story 52) a claim about the thing that actually ships.

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

<!--
	**A `<section>` rather than a `<div>`, because `aria-label` on a bare `<div>` names nothing.** A
	`<div>` has the implicit `generic` role, for which ARIA 1.2 prohibits `aria-label` and which
	browsers drop from the accessibility tree — so a Reader on a screen reader heard the title and then
	the description with no boundary between them, while the source read as though a name were being
	supplied. Named rather than anonymous because the prose is a stranger's Markdown and can be
	anything, including nothing.

	One of these is on screen at a time — one Annotation being read, in the Inspector's showing face —
	which is what makes a fixed name safe here, the same argument `AnnotationList` makes for its own.
-->
<section
	class="prose-sm prose max-w-none"
	data-testid="annotation-description-text"
	aria-label="Description"
>
	{#if rendered === ''}
		<p class="text-sm opacity-60">No description.</p>
	{:else}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html rendered}
	{/if}
</section>

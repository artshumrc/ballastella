<script lang="ts">
	// Still a placeholder — ticket 17 builds the read-only exploration this becomes.
	//
	// What is no longer a placeholder is the **Annotation text path**: this page renders its own copy
	// through `annotationHtml`, which forwards to the very renderer the editor uses (ADR-0009). That
	// makes the shared path live in the viewer's shipped bundle now rather than at ticket 17, so a
	// reimplementation here would have to *remove* working code rather than merely be written beside it.

	import { isDescriptionRendererSupported } from '@ballastella/core';
	import { onMount } from 'svelte';

	import { annotationHtml } from '$lib/annotation-text';

	/**
	 * The page's own copy, authored as Markdown so that the emphasis and the link below are produced by
	 * `marked` and then sanitised by DOMPurify — the same two stages, in the same order, that a
	 * scholar's `description` goes through.
	 */
	const about = {
		// No `title`: the `<h1>` below is this page's heading, and a second copy of it inside the rendered
		// block would be two headings saying the same thing to a screen reader.
		description:
			'This is the lean read-only viewer that publishing writes into a Workspace. ' +
			'A reader can *look* at the work — the aligned historical maps, the annotations, and what ' +
			'each one says — and **cannot change it**. Nothing else is built here yet; see ' +
			'[the project README](https://github.com/artshumrc/ballastella#readme).'
	};

	/**
	 * Whether the page has hydrated, which gates the render for **two** reasons.
	 *
	 * The first is a requirement: both apps prerender (ADR-0006) and DOMPurify needs a DOM, so the
	 * renderer refuses in Node rather than degrading to returning its input — which is the safe
	 * direction, since a fallback returning unsanitised HTML would write an XSS payload into a static
	 * file.
	 *
	 * The second is a Svelte hydration rule that is worth writing down because it was found the hard
	 * way. **`{@html}` is not re-rendered during hydration**: Svelte adopts whatever nodes the server
	 * produced for it and never compares them against the client's value, on the assumption that the two
	 * agree. So a `{@html}` whose expression was `''` on the server and complete HTML on the client
	 * renders *nothing at all*, permanently, with no error and no hydration warning. Gating on a flag
	 * that is false during the client's first render and true immediately after makes the value
	 * genuinely *change* after hydration, which is what makes Svelte update it.
	 *
	 * That failure deserves a test rather than only a comment, because **a blank render surface passes
	 * every "is the payload inert?" assertion.** So `e2e/viewer.e2e.ts` and
	 * `e2e/editor-annotations.e2e.ts` both assert the text **is** present as well as that the markup is
	 * not.
	 */
	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
	});

	const html = $derived(hydrated && isDescriptionRendererSupported() ? annotationHtml(about) : '');
</script>

<svelte:head><title>Ballastella Viewer</title></svelte:head>

<main class="mx-auto max-w-prose p-8">
	<h1 class="text-3xl font-bold">Ballastella Viewer</h1>

	<!--
		`{@html}`, and safe for one reason only: `html` is DOMPurify's own output. There is no path into
		this expression that has not been through the sanitiser, and there must never be one.
	-->
	<div class="mt-4 prose" data-testid="viewer-annotation-text">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html html}
	</div>
</main>

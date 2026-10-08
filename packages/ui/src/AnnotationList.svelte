<script lang="ts">
	import type { Annotation } from '@ballastella/core';
	import type { Snippet } from 'svelte';

	import { annotationName } from './annotation-name.js';
	import AnnotationRow from './AnnotationRow.svelte';

	let {
		annotations,
		openId,
		onopen,
		onmove,
		tools,
		noAnnotationsGuidance
	}: {
		annotations: readonly Annotation[] | null;
		openId: string | null;
		onopen: (id: string | null) => void;
		onmove?: (id: string, toIndex: number) => void;
		tools?: Snippet;
		noAnnotationsGuidance?: Snippet;
	} = $props();

	/** The Annotation being dragged and the row a drop would land on, both `''` for neither. */
	let dragging = $state('');
	let over = $state('');

	/** `aria-live` rather than `role="status"`, because the save indicator already owns that role on this page — the same reasoning, and the same shape, as the Layer stack's own announcement one level up. */
	let moved = $state('');

	const move = (id: string, toIndex: number): void => {
		const list = annotations ?? [];
		const from = list.findIndex((annotation) => annotation.id === id);
		const annotation = list[from];
		if (!onmove || !annotation) return;
		const to = Math.min(list.length - 1, Math.max(0, toIndex));
		onmove(id, toIndex);
		moved = `${annotationName(annotation, from)} moved to ${to + 1} of ${list.length}`;
	};
</script>

<!-- Named by `aria-label` rather than by a heading of its own. -->
<section aria-label="Annotations" class="flex flex-col gap-3">
	{@render tools?.()}

	<p class="sr-only" aria-live="polite" aria-atomic="true" data-testid="annotation-move-status">
		{moved}
	</p>

	{#if annotations?.length === 0}
		<p class="text-sm opacity-70" data-testid="annotation-list-empty">
			{#if noAnnotationsGuidance}
				{@render noAnnotationsGuidance()}
			{:else}
				This Layer has no Annotations in it.
			{/if}
		</p>
	{:else if annotations}
		<div class="overflow-hidden rounded-box border border-base-300">
			<p
				class="border-b border-base-300 bg-base-200 px-3 py-1 text-[0.65rem] font-semibold uppercase opacity-70"
				id="annotation-list-caption"
			>
				{annotations.length}
				{annotations.length === 1 ? 'Annotation' : 'Annotations'}
			</p>

			<ol
				class="menu w-full gap-0 menu-sm p-0"
				aria-labelledby="annotation-list-caption"
				data-testid="annotation-list"
			>
				{#each annotations as annotation, index (annotation.id)}
					<AnnotationRow
						{annotation}
						{index}
						open={annotation.id === openId}
						{onopen}
						bind:dragging
						bind:over
						{...onmove ? { onmove: move } : {}}
					/>
				{/each}
			</ol>
		</div>
	{/if}
</section>

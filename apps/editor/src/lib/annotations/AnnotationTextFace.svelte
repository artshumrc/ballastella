<script lang="ts">
	import { isLabel, type Annotation } from '@ballastella/core';
	import { AnnotationDescription } from '@ballastella/ui';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { tick } from 'svelte';

	let {
		annotation,
		titling = false,
		ontext,
		ontitled,
		oncommit,
		ondelete,
		index,
		count,
		moveTargets,
		onmove,
		onmovetolayer
	}: {
		annotation: Annotation;
		titling?: boolean;
		ontext: (text: { title?: string; description?: string }) => void;
		ontitled?: () => void;
		oncommit: () => void;
		ondelete: () => void;
		index: number;
		count: number;
		moveTargets: readonly { id: string; name: string }[];
		onmove: (toIndex: number) => void;
		onmovetolayer: (layerId: string) => void;
	} = $props();

	const properties = $derived(annotation.properties);
	const geometryKind = $derived(annotation.geometry?.type ?? null);
	const label = $derived(isLabel(annotation));
	const drawsNothing = $derived((properties.title ?? '').trim() === '');
	const emptyLabelId = $props.id();
	let editingText = $state(false);
	let titleField = $state<HTMLInputElement | undefined>(undefined);
	let shown = '';

	$effect(() => {
		const id = annotation.id;
		if (id === shown) return;
		shown = id;
		if (titling) void takeUpTitling();
		else editingText = false;
	});

	const editText = async (): Promise<void> => {
		if (!label) editingText = true;
		await tick();
		titleField?.focus();
		titleField?.select();
	};

	const takeUpTitling = async (): Promise<void> => {
		await editText();
		ontitled?.();
	};

	const finishText = (): void => {
		oncommit();
		editingText = false;
	};
</script>

{#snippet titleInput(caption: string, describedBy?: string)}
	<label class="floating-label">
		<span>{caption}</span>
		<input
			bind:this={titleField}
			class="input w-full input-sm"
			value={properties.title ?? ''}
			data-testid="annotation-title"
			aria-describedby={describedBy}
			oninput={(event) => ontext({ title: event.currentTarget.value })}
			onkeydown={(event) => {
				if (event.key === 'Escape') event.currentTarget.blur();
			}}
			onchange={() => oncommit()}
			onblur={() => oncommit()}
		/>
	</label>
{/snippet}

<div
	class="flex flex-col gap-3"
	data-testid="annotation-text-face"
	data-annotation-id={annotation.id}
>
	{#if label}
		{@render titleInput('Label text', drawsNothing ? emptyLabelId : undefined)}

		{#if drawsNothing}
			<p id={emptyLabelId} class="text-sm opacity-70" data-testid="annotation-label-empty">
				This Label draws nothing on the map until it has words.
			</p>
		{/if}

		{#if properties.description}
			<AnnotationDescription {annotation} />
		{/if}
	{:else if editingText}
		{@render titleInput('Title')}

		<label class="floating-label">
			<span>Description — Markdown</span>
			<textarea
				class="textarea w-full font-mono textarea-sm"
				rows="4"
				value={properties.description ?? ''}
				placeholder="*emphasis*, **strong**, and [links](https://example.org/)"
				data-testid="annotation-description"
				oninput={(event) => ontext({ description: event.currentTarget.value })}
				onchange={() => oncommit()}
				onblur={() => oncommit()}></textarea>
		</label>
	{:else}
		<AnnotationDescription {annotation} />

		{#if geometryKind === null || geometryKind === 'foreign'}
			<p class="text-sm text-warning" data-testid="annotation-not-drawable">
				This Annotation's shape is one this version cannot draw, so it has no style controls. Its
				title and description are still yours to edit, and the shape is written back untouched.
			</p>
		{/if}
	{/if}

	{#if count > 1 || moveTargets.length > 0}
		<div class="flex flex-wrap items-center gap-2">
			{#if count > 1}
				<button
					type="button"
					class="btn btn-sm"
					disabled={index === 0}
					data-testid="annotation-move-up"
					onclick={() => onmove(index - 1)}
				>
					<ArrowUp size={14} aria-hidden="true" />
					Move up<span class="sr-only"> — this Annotation, within its Layer</span>
				</button>
				<button
					type="button"
					class="btn btn-sm"
					disabled={index === count - 1}
					data-testid="annotation-move-down"
					onclick={() => onmove(index + 1)}
				>
					<ArrowDown size={14} aria-hidden="true" />
					Move down<span class="sr-only"> — this Annotation, within its Layer</span>
				</button>
			{/if}

			{#if moveTargets.length > 0}
				<label class="sr-only" for="annotation-move-to-layer">
					Move this Annotation to another Annotation Layer
				</label>
				<select
					id="annotation-move-to-layer"
					class="select w-auto select-sm"
					data-testid="annotation-move-to-layer"
					value=""
					onchange={(event) => {
						const layerId = event.currentTarget.value;
						event.currentTarget.value = '';
						if (layerId) onmovetolayer(layerId);
					}}
				>
					<option value="">Move to Layer…</option>
					{#each moveTargets as target (target.id)}
						<option value={target.id}>{target.name || 'Untitled Layer'}</option>
					{/each}
				</select>
			{/if}
		</div>
	{/if}

	<div class="flex items-center gap-2">
		{#if editingText}
			<button
				type="button"
				class="btn btn-sm"
				data-testid="annotation-text-done"
				onclick={() => finishText()}
			>
				Done
			</button>
		{:else if !label}
			<button
				type="button"
				class="btn btn-sm"
				data-testid="annotation-edit-text"
				onclick={() => void editText()}
			>
				<Pencil size={14} aria-hidden="true" />
				Edit text<span class="sr-only"> — title and description</span>
			</button>
		{/if}

		<button
			type="button"
			class="btn btn-outline btn-error btn-sm"
			data-testid="annotation-delete"
			onclick={() => ondelete()}
		>
			<Trash2 size={14} aria-hidden="true" />
			Delete<span class="sr-only"> this Annotation</span>
		</button>
	</div>
</div>

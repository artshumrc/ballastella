<script lang="ts">
	import { KIND_STYLE, TOOL_ICONS } from '@ballastella/ui';
	import Plus from '@lucide/svelte/icons/plus';

	import { toolName, type AnnotationTool } from './drawing.svelte';

	let {
		tool,
		picking,
		status,
		drawing,
		canFinish,
		onnew,
		onchoose,
		onfinish,
		oncancel,
		onundovertex
	}: {
		tool: AnnotationTool;
		picking: boolean;
		status: string;
		drawing: boolean;
		canFinish: boolean;
		onnew: () => void;
		onchoose: (tool: AnnotationTool) => void;
		onfinish: () => void;
		oncancel: () => void;
		onundovertex: () => void;
	} = $props();

	const SHAPES: AnnotationTool[] = ['point', 'line', 'polygon', 'circle', 'text'];

	const stopDrawing = (): void => {
		if (drawing) oncancel();
		onchoose('select');
	};

	const announcement = $derived(status === '' ? '' : `${toolName(tool)} tool. ${status}`);
</script>

<div class="flex flex-col gap-2">
	{#if !picking}
		<div>
			<button
				type="button"
				class="btn gap-1 btn-xs {KIND_STYLE.annotation.btn}"
				data-testid="annotation-new"
				onclick={() => onnew()}
			>
				<Plus class="size-4" aria-hidden="true" />
				New Annotation
			</button>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			<div role="toolbar" aria-label="Annotation tools" class="join" data-testid="annotation-tools">
				{#each SHAPES as entry (entry)}
					{@const Icon = TOOL_ICONS[entry]}
					<button
						type="button"
						class={['btn join-item gap-1 btn-xs', tool === entry && KIND_STYLE.annotation.btn]}
						aria-pressed={tool === entry}
						data-testid="annotation-tool-{entry}"
						onclick={() => onchoose(entry)}
					>
						<Icon class="size-4" aria-hidden="true" />
						{toolName(entry)}
					</button>
				{/each}
			</div>

			{#if drawing}
				<button
					type="button"
					class="btn btn-primary btn-xs"
					disabled={!canFinish}
					data-testid="annotation-done"
					onclick={() => onfinish()}
				>
					Done
				</button>
				<button
					type="button"
					class="btn btn-xs"
					data-testid="annotation-undo-vertex"
					onclick={() => onundovertex()}
				>
					Undo last point
				</button>
			{/if}
			<button
				type="button"
				class="btn btn-neutral btn-xs"
				data-testid="annotation-cancel"
				onclick={() => stopDrawing()}
			>
				Cancel
			</button>
		</div>
	{/if}

	<p
		class={announcement === '' ? 'sr-only' : 'text-sm opacity-80'}
		aria-live="polite"
		aria-atomic="true"
		data-testid="annotation-status"
		data-tool={tool}
		data-drawing={drawing ? 'true' : 'false'}
	>
		{announcement}
	</p>
</div>

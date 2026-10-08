<script lang="ts">
	import type { SaveState } from '@ballastella/core';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	let {
		saveState,
		github = '',
		determination = '',
		agreeing = false,
		popoverTarget,
		expanded = false,
		onToggle
	}: {
		saveState: SaveState;
		github?: string;
		determination?: string;
		agreeing?: boolean;
		popoverTarget?: string;
		expanded?: boolean;
		onToggle?: () => void;
	} = $props();

	const MINIMUM_SAVING_MS = 400;

	const LABELS: Record<SaveState, string> = {
		saved: 'Saved here',
		saving: 'Saving…',
		unsaved: 'Unsaved changes'
	};

	let shown = $state<SaveState>('saved');
	let savingSince = 0;

	$effect(() => {
		const next = saveState;
		if (next === 'saving') {
			savingSince = Date.now();
			shown = 'saving';
			return;
		}
		const remaining = MINIMUM_SAVING_MS - (Date.now() - savingSince);
		if (remaining <= 0) {
			shown = next;
			return;
		}
		const timer = setTimeout(() => {
			shown = next;
		}, remaining);
		return () => clearTimeout(timer);
	});

	const settled = $derived(shown === 'saved' && (github === '' || agreeing));
	const toggle = $derived(popoverTarget !== undefined);
</script>

<div role="status" aria-atomic="true">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<svelte:element
		this={toggle ? 'button' : 'p'}
		type={toggle ? 'button' : undefined}
		popovertarget={popoverTarget}
		aria-controls={popoverTarget}
		aria-expanded={toggle ? expanded : undefined}
		data-save-state={shown}
		data-remote-status={github === '' ? undefined : determination}
		data-testid="where-your-work-is"
		class="badge h-8 gap-1.5 font-medium whitespace-nowrap shadow-sm"
		class:badge-success={settled}
		class:badge-warning={!settled}
		style={toggle ? `anchor-name: --${popoverTarget}` : undefined}
		onclick={onToggle}
	>
		{#if shown === 'saving'}
			<span class="loading loading-xs loading-spinner" aria-hidden="true"></span>
		{:else if settled}
			<span class="saved-mark" aria-hidden="true">
				<CircleCheck class="size-3.5" />
			</span>
		{:else}
			<TriangleAlert class="size-3.5" aria-hidden="true" />
		{/if}
		{LABELS[shown]}{#if github !== ''}&nbsp;· {github}{/if}
	</svelte:element>
</div>

<style>
	.saved-mark {
		animation: saved-confirmation 300ms ease-out;
	}

	@keyframes saved-confirmation {
		0% {
			transform: scale(0.6);
		}
		60% {
			transform: scale(1.2);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.saved-mark {
			animation: none;
		}
	}
</style>

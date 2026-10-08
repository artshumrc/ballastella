<script lang="ts">
	import type { EditHistory, Step } from '@ballastella/core';
	import Redo2 from '@lucide/svelte/icons/redo-2';

	import Toast from '$lib/toasts/Toast.svelte';

	let { history }: { history: EditHistory } = $props();

	let undoable = $state.raw<Step | null>(null);
	let redoable = $state.raw<Step | null>(null);

	$effect(() =>
		history.subscribe((state) => {
			undoable = state.undoable;
			redoable = state.redoable;
		})
	);

	const undoLabel = $derived(undoable?.label ?? '');
	const redoLabel = $derived(redoable === null ? '' : redoable.label.replace(/^Undo /, 'Redo '));
	let announced = $state('');

	const walk = async (direction: 'undo' | 'redo'): Promise<void> => {
		const step = direction === 'undo' ? undoable : redoable;
		if (step === null) return;
		const said = step.label.replace(/^Undo /, direction === 'undo' ? 'Undone: ' : 'Redone: ');
		if (await (direction === 'undo' ? history.undo() : history.redo())) announced = `${said}.`;
	};

	const typing = (target: EventTarget | null): boolean => {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable) return true;
		const tag = target.tagName;
		return tag === 'TEXTAREA' || (tag === 'INPUT' && TEXT_INPUTS.has(inputType(target)));
	};

	const TEXT_INPUTS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);

	const inputType = (element: HTMLElement): string =>
		(element as HTMLInputElement).type?.toLowerCase() ?? '';

	const shortcut = (event: KeyboardEvent): 'undo' | 'redo' | null => {
		if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
		const key = event.key.toLowerCase();
		if (key === 'y') return event.shiftKey ? null : 'redo';
		if (key !== 'z') return null;
		return event.shiftKey ? 'redo' : 'undo';
	};
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.defaultPrevented) return;
		const asked = shortcut(event);
		if (asked === null) return;
		if (typing(event.target)) return;
		if ((asked === 'undo' ? undoable : redoable) === null) return;
		event.preventDefault();
		void walk(asked);
	}}
/>

<div class="flex items-center gap-2">
	{#if undoable !== null}
		<button
			type="button"
			class="btn btn-sm btn-warning"
			data-testid="edit-history-undo"
			onclick={() => void walk('undo')}
		>
			{undoLabel}
		</button>
	{/if}

	{#if redoable !== null}
		<button
			type="button"
			class="btn btn-sm"
			data-testid="edit-history-redo"
			aria-label={redoLabel}
			title={redoLabel}
			onclick={() => void walk('redo')}
		>
			<Redo2 class="size-4" aria-hidden="true" />
			Redo
		</button>
	{/if}
</div>

<Toast text={announced} testid="edit-history-outcome" tone="info" />

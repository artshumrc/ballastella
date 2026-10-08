<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		title,
		wide = false,
		children,
		actions,
		restoreFocusTo,
		dismissable = true
	}: {
		open?: boolean;
		title: string;
		wide?: boolean;
		children: Snippet;
		actions: Snippet;
		restoreFocusTo?: () => HTMLElement | null | undefined;
		dismissable?: boolean;
	} = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let trigger: HTMLElement | null = null;
	let restored = true;
	const titleId = $props.id();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			trigger = document.activeElement as HTMLElement | null;
			restored = false;
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
			restoreFocus();
		}
	});

	function restoreFocus(): void {
		if (restored) return;
		restored = true;
		const usable =
			trigger !== null &&
			trigger !== document.body &&
			trigger.isConnected &&
			trigger.closest('dialog:not([open])') === null;
		if (usable && trigger) {
			trigger.focus();
			return;
		}
		const focused = document.activeElement;
		const stranded =
			focused === null ||
			focused === document.body ||
			focused === trigger ||
			(dialog?.contains(focused) ?? false);
		if (stranded) restoreFocusTo?.()?.focus();
	}

	const onclose = () => {
		open = false;
		restoreFocus();
	};

	const oncancel = (event: Event) => {
		if (!dismissable) event.preventDefault();
	};
</script>

<dialog bind:this={dialog} {onclose} {oncancel} class="modal" aria-labelledby={titleId}>
	<div class="modal-box" class:max-w-3xl={wide}>
		<h2 id={titleId} class="text-lg font-bold">{title}</h2>
		<div class="py-4">{@render children()}</div>
		<div class="modal-action">{@render actions()}</div>
	</div>
</dialog>

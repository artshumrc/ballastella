<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The one modal in the app.
	 *
	 * `<dialog>` + `showModal()` / `close()` is mandated, not merely available (ADR-0016):
	 * daisyUI still documents a checkbox-hack modal and an anchor/hash modal, neither of which
	 * handles Escape, and an implementer copying whichever snippet they land on produces a
	 * different accessibility outcome each time. Native `showModal()` brings the focus trap,
	 * Escape, and focus restoration with it. This component exists so that decision is made
	 * once and every later slice inherits it.
	 */
	let {
		open = $bindable(false),
		title,
		wide = false,
		children,
		actions
	}: {
		open?: boolean;
		title: string;
		/**
		 * Room for a dialog that holds a real interface rather than a field and a question.
		 *
		 * daisyUI's `.modal-box` is 32rem, which is right for "rename this Project" and too narrow for
		 * the three sources a Historical Map can come from — a URL form, a rights statement and a
		 * scrolling list of canvases in a 32rem column is the same cramping the sidebar was rejected
		 * for. A boolean rather than a class prop: two widths is a decision this component can hold, and
		 * an arbitrary class from outside is how one modal ends up looking like nothing else in the app.
		 */
		wide?: boolean;
		children: Snippet;
		actions: Snippet;
	} = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let trigger: HTMLElement | null = null;
	// A stable id across server render and hydration, so `aria-labelledby` never dangles.
	const titleId = $props.id();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			trigger = document.activeElement as HTMLElement | null;
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});

	// Fires for Escape and for the backdrop as well as for our own close, so this is the one
	// place that has to put focus back — the browser restores it too, but only for the element
	// it saw focused, and being explicit is what the browser test asserts.
	const onclose = () => {
		open = false;
		trigger?.focus();
	};
</script>

<dialog bind:this={dialog} {onclose} class="modal" aria-labelledby={titleId}>
	<div class="modal-box" class:max-w-3xl={wide}>
		<h2 id={titleId} class="text-lg font-bold">{title}</h2>
		<div class="py-4">{@render children()}</div>
		<div class="modal-action">{@render actions()}</div>
	</div>
</dialog>

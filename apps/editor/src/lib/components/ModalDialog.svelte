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
		children,
		actions,
		restoreFocusTo
	}: {
		open?: boolean;
		title: string;
		children: Snippet;
		actions: Snippet;
		/**
		 * Where focus goes when the element that opened this dialog is **no longer in the document**.
		 *
		 * ⚠ **A dialog can outlive its own trigger, and `focus()` on a detached node is a no-op with no
		 * complaint.** Opening a Project bundle is the case: the button that opened this is inside
		 * `{#if review === null}`, and succeeding puts the user inside a review copy — so by the time
		 * the dialog closes the trigger has been unmounted, focus falls to `<body>`, and a keyboard user
		 * tabs in from the top of the page to find out what just happened (WCAG 2.4.3,
		 * workspace-and-layers SPEC story 95). Consulted only when the trigger has gone, so nothing about the ordinary
		 * Escape-and-cancel path changes.
		 */
		restoreFocusTo?: () => HTMLElement | null | undefined;
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
			// ⚠ **Here, synchronously, and not in `onclose` — the timing is the whole of it.** `close()`
			// leaves the top layer at once but *queues* the `close` event, so restoring from the handler
			// leaves a window in which focus is on a button inside a dialog that is no longer shown. A
			// keystroke arriving in that window is answered by the dead element, and a restore performed
			// afterwards yanks focus back out of wherever the user had just put it. Measured, twice, as a
			// browser test that focused the review banner's exit and had it taken away a frame later.
			restoreFocus();
		}
	});

	/**
	 * Put focus back where the user can use it.
	 *
	 * The browser restores it too, but only for the element it saw focused, and being explicit is what
	 * the browser test asserts.
	 */
	function restoreFocus(): void {
		// `isConnected` rather than a `try`: a detached element accepts `focus()` and does nothing, so
		// there is no failure to catch — which is exactly why this went unnoticed.
		if (trigger?.isConnected) {
			trigger.focus();
			return;
		}
		// **Only when focus has nowhere to be**, which is `<body>`, nothing at all, or still inside the
		// dialog that has just closed. Anywhere else is somewhere the user chose, and taking it off them
		// would be a worse failure than the `<body>` this exists to avoid.
		const focused = document.activeElement;
		const stranded =
			focused === null || focused === document.body || (dialog?.contains(focused) ?? false);
		if (stranded) restoreFocusTo?.()?.focus();
	}

	// Escape and the backdrop close the dialog without going through the effect above, so this is
	// their path to the same restoration. Our own close has already done it, and `restoreFocus` is
	// idempotent — by then focus is outside the dialog and on something real.
	const onclose = () => {
		open = false;
		restoreFocus();
	};
</script>

<dialog bind:this={dialog} {onclose} class="modal" aria-labelledby={titleId}>
	<div class="modal-box">
		<h2 id={titleId} class="text-lg font-bold">{title}</h2>
		<div class="py-4">{@render children()}</div>
		<div class="modal-action">{@render actions()}</div>
	</div>
</dialog>

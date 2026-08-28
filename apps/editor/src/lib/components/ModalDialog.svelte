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
		actions,
		restoreFocusTo,
		dismissable = true
	}: {
		open?: boolean;
		title: string;
		/**
		 * Room for a dialog that holds a real interface rather than a field and a question.
		 *
		 * daisyUI's `.modal-box` is 32rem, which is right for "rename this Project" and too narrow for
		 * the three sources a Map Image can come from — a URL form, a rights statement and a
		 * scrolling list of canvases in a 32rem column is the same cramping the sidebar was rejected
		 * for. A boolean rather than a class prop: two widths is a decision this component can hold, and
		 * an arbitrary class from outside is how one modal ends up looking like nothing else in the app.
		 */
		wide?: boolean;
		children: Snippet;
		actions: Snippet;
		/**
		 * Where focus goes when the element that opened this dialog **can no longer take it** — because
		 * it has been unmounted, or because it is inside a dialog that has since closed.
		 *
		 * ⚠ **A dialog can outlive its own trigger, and `focus()` on a detached node is a no-op with no
		 * complaint.** Opening a Project bundle is the case: the button that opened this is inside `{#if
		 * review === null}`, and succeeding puts the user inside a review copy — so by the time the
		 * dialog closes the trigger has been unmounted, focus falls to `<body>`, and a keyboard user tabs
		 * in from the top of the page to find out what just happened (WCAG 2.4.3). Consulted only when
		 * the trigger has gone, so nothing about the ordinary Escape-and-cancel path changes.
		 *
		 * ⚠ **The node it answers with may be created by the very update that closes this dialog, and
		 * this is the ordering that makes that work.** `ProjectHub` hands back a `bind:this` on the
		 * notice line that only exists once the bundle has opened. Svelte flushes render effects — which
		 * is where `bind:this` is written — before user effects, and the close above is a user effect, so
		 * by the time this getter is called the binding is set. It is called, not passed a node, for
		 * exactly that reason: a node read at render time would have been `undefined` for ever. If this
		 * answers nothing the restoration stops rather than guessing, which is the safe end of it —
		 * focus is on `<body>`, where it already was, and nothing has been taken off the user.
		 */
		restoreFocusTo?: () => HTMLElement | null | undefined;
		/**
		 * Whether Escape may close this dialog, which it must not while the dialog cannot be cancelled.
		 *
		 * ⚠ **Native Escape closes a `<dialog>` whatever the owner thinks**, and that is a real defect
		 * rather than a theoretical one: a caller whose cancel handler declines to act — because a
		 * download is running and there is nothing to stop — is left with the dialog gone from the
		 * screen and its own `open` still `true`, so the progress line and any refusal that arrives are
		 * rendered into a dialog nobody can see. Refusing the `cancel` event keeps the screen and the
		 * state agreeing; the owner is then responsible for saying *why* it will not close, which is
		 * what a visibly disabled Cancel button is for.
		 */
		dismissable?: boolean;
	} = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let trigger: HTMLElement | null = null;
	/**
	 * Whether focus has already been put back for the close that is happening now.
	 *
	 * ⚠ **This is what makes {@link restoreFocus} idempotent, which the two call sites both assume and
	 * only one of them used to get.** Our own close restores synchronously and the queued `close` event
	 * then restored a second time, and the second run took focus back to the trigger *unconditionally*
	 * — so anything that moved focus in between, one task wide, had it stolen. That is the same class
	 * of theft this restoration was written to stop, and being narrow is not being absent. Idempotent
	 * for the trigger branch as well as the "focus is stranded" one, so both closes below can call it.
	 */
	let restored = true;
	// A stable id across server render and hydration, so `aria-labelledby` never dangles.
	const titleId = $props.id();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			trigger = document.activeElement as HTMLElement | null;
			restored = false;
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
		// Once per close, whichever of the two paths below gets here first. See {@link restored}.
		if (restored) return;
		restored = true;
		// `isConnected` rather than a `try`: a detached element accepts `focus()` and does nothing, so
		// there is no failure to catch — which is exactly why this went unnoticed.
		//
		// ⚠ **And in the document is not the same as reachable.** A dialog opened from inside another
		// dialog that has since closed — the Publish dialog, opened from the door, which closes on the
		// press — has a trigger that is still connected and inside a `<dialog>` nobody can see. Worse
		// than a no-op: daisyUI's `.modal` keeps a closed dialog laid out, so `focus()` on that button
		// *succeeds* and a keyboard user is left on a control that is not on the screen. Asking whether
		// the focus landed cannot tell the two apart; asking where the trigger lives can.
		const usable =
			(trigger?.isConnected ?? false) && trigger?.closest('dialog:not([open])') === null;
		if (usable && trigger) {
			trigger.focus();
			return;
		}
		// **Only when focus has nowhere to be**, which is `<body>`, nothing at all, still inside the
		// dialog that has just closed, or on the trigger this has just refused. Anywhere else is
		// somewhere the user chose, and taking it off them would be a worse failure than the `<body>`
		// this exists to avoid.
		const focused = document.activeElement;
		const stranded =
			focused === null ||
			focused === document.body ||
			focused === trigger ||
			(dialog?.contains(focused) ?? false);
		if (stranded) restoreFocusTo?.()?.focus();
	}

	// Escape and the backdrop close the dialog without going through the effect above, so this is
	// their path to the same restoration. After our own close it is a no-op, because `restoreFocus`
	// is idempotent per close — see {@link restored} for why that had to be made true rather than
	// asserted.
	const onclose = () => {
		open = false;
		restoreFocus();
	};

	// Escape's own event, which is cancelable — see {@link dismissable}. The backdrop is not a form
	// here, so this is the only way in.
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

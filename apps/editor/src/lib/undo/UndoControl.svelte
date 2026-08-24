<script lang="ts">
	// The undo affordance: one button that names what it will reverse, and the standard shortcut
	// (SPEC story 38, ADR-0014, ADR-0016).
	//
	// **It names the action, and that is the requirement rather than a nicety.** A bare "Undo" button
	// after an accidental delete does not answer the question the user actually has — "have I just lost
	// the thing I think I have lost?" — so the label is "Undo delete of Control Point 7", built by
	// `describeUndo` in core so that the wording is one fact with one definition.
	//
	// **Absent rather than disabled when there is nothing to undo**, which is how "a second undo does
	// nothing *and is not offered*" becomes one piece of state instead of two that can disagree. A
	// disabled button would also be the wrong signal: this is not a control that is temporarily
	// unavailable, it is a thing that only exists after a destructive action.
	//
	// Mounted on both panes that can produce a destructive action, over the one session-wide slot: the
	// four covered actions happen in two places, and two slots would be two things each claiming to be
	// "the last destructive action".

	import { describeUndo } from '@ballastella/core';

	import Toast from '$lib/toasts/Toast.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';

	let { session }: { session: EditorSession } = $props();

	const record = $derived(session.undoable);
	const label = $derived(record === null ? '' : describeUndo(record));

	/**
	 * What the last undo put back, announced.
	 *
	 * The button *disappears* when it is pressed — the slot is empty — so without this a keyboard or
	 * screen-reader user gets no confirmation at all, and the thing undo has to convey above everything
	 * else is reassurance. A toast rather than a line beneath the bar: that is this app's pattern for a
	 * transient outcome (ADR-0016), and the stack owns the announcement.
	 */
	let announced = $state('');

	const undo = async (): Promise<void> => {
		const undoing = label;
		if (undoing === '') return;
		await session.undo();
		// Past tense and the same words as the button, so the two are obviously the same event.
		announced = `${undoing.replace(/^Undo /, 'Undone: ')}.`;
	};

	/**
	 * Whether the keypress happened somewhere with its own undo.
	 *
	 * A text field's native undo must keep working: editing a title or a Project name is deliberately
	 * *not* one of the four actions ADR-0014 covers, so stealing the shortcut there would take away the
	 * only undo that field has and put back a Control Point the user was not thinking about.
	 */
	const typing = (target: EventTarget | null): boolean => {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable) return true;
		const tag = target.tagName;
		// A range and a checkbox are `<input>`s with no text to undo, and the Layer list puts both of
		// them a Tab away from the delete button — so narrowing to the ones that hold text is what keeps
		// the shortcut usable where the user has just deleted something.
		return tag === 'TEXTAREA' || (tag === 'INPUT' && TEXT_INPUTS.has(inputType(target)));
	};

	const TEXT_INPUTS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);

	const inputType = (element: HTMLElement): string =>
		(element as HTMLInputElement).type?.toLowerCase() ?? '';
</script>

<!--
	The standard shortcut, on the window: the user's hands are wherever the mis-aimed gesture left them
	— on a canvas, on a handle, on the Layer list — and "Ctrl+Z only works if you have not moved the
	focus" is not an undo affordance. `Ctrl+Shift+Z` is not handled here: redo belongs to the screen's
	Edit History, and `EditHistoryControls` is where the three shortcuts now are.

	`defaultPrevented` stands this down for a keypress those controls have already taken. Both are on
	the window while `UndoSlot` still exists, and one keypress must move one history — though nothing
	offers the slot a record any more, so this control is never drawn. Ticket 7 removes it.
-->
<svelte:window
	onkeydown={(event) => {
		if (event.defaultPrevented) return;
		if (event.key !== 'z' && event.key !== 'Z') return;
		if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
		if (typing(event.target)) return;
		if (session.undoable === null) return;
		event.preventDefault();
		void undo();
	}}
/>

{#if record !== null}
	<button
		type="button"
		class="btn btn-sm btn-warning"
		data-testid="undo"
		data-undo-kind={record.kind}
		onclick={() => void undo()}
	>
		{label}
	</button>
{/if}

<Toast text={announced} testid="undo-outcome" tone="info" />

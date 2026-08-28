<script lang="ts">
	// The two controls of one screen's Edit History (ADR-0039).
	//
	// **Undo carries the Step's whole sentence, and that is the requirement rather than a nicety.** A
	// bare "Undo" after an accidental delete does not answer the question a scholar actually has —
	// "have I just lost the thing I think I have lost?" — so the label is "Undo delete of the Layer
	// 'Rhineland 1580'", built where the gesture is and held on the Step.
	//
	// **Redo is a word and a glyph.** Two sentence-long buttons would take over the navigation bar, so
	// the same sentence with one word swapped becomes redo's accessible name and its `title` instead of
	// its visible text — compact for a scholar reading the bar, and named for one who cannot see it.
	//
	// **Each is absent rather than disabled** when its end of the history is empty, which is how "there
	// is nothing to redo *and it is not offered*" stays one piece of state instead of two that can
	// disagree. A disabled button would also be the wrong signal: this is not a control that is
	// temporarily unavailable, it is one that only exists once there is something at that end.

	import type { EditHistory, Step } from '@ballastella/core';
	import Redo2 from '@lucide/svelte/icons/redo-2';

	import Toast from '$lib/toasts/Toast.svelte';

	let { history }: { history: EditHistory } = $props();

	let undoable = $state.raw<Step | null>(null);
	let redoable = $state.raw<Step | null>(null);

	// The history publishes; this projects it into reactive state, the same shape the save indicator
	// gets from `Autosave`. `subscribe` calls back once immediately and returns its own unsubscribe,
	// which is this effect's teardown — so swapping histories cannot leave the bar reading the old one.
	$effect(() =>
		history.subscribe((state) => {
			undoable = state.undoable;
			redoable = state.redoable;
		})
	);

	const undoLabel = $derived(undoable?.label ?? '');
	/** The same sentence with one word swapped, so the two controls are obviously one pair. */
	const redoLabel = $derived(redoable === null ? '' : redoable.label.replace(/^Undo /, 'Redo '));

	/**
	 * What the last undo or redo did, in words.
	 *
	 * A toast rather than a line under the bar (ADR-0016): the control *disappears* when it is pressed
	 * — that end of the history may now be empty — so without this a keyboard or screen-reader user
	 * gets no confirmation at all, and reassurance is the thing undo exists to give.
	 */
	let announced = $state('');

	const walk = async (direction: 'undo' | 'redo'): Promise<void> => {
		const step = direction === 'undo' ? undoable : redoable;
		if (step === null) return;
		const said = step.label.replace(/^Undo /, direction === 'undo' ? 'Undone: ' : 'Redone: ');
		// A failure leaves both controls where they are and says nothing here: the write did not land,
		// and the save-error toast is what reports that.
		if (await (direction === 'undo' ? history.undo() : history.redo())) announced = `${said}.`;
	};

	/**
	 * Whether the keypress happened somewhere with its own undo.
	 *
	 * A text field's native undo must keep working: typed text is not a Step and is never reverted by
	 * one (ADR-0039), so stealing the shortcut there would take away the only undo that field has and
	 * put back an edit the scholar had stopped thinking about.
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

	/** Which of the two a keypress asks for, or `null` for a keypress that is not one of ours. */
	const shortcut = (event: KeyboardEvent): 'undo' | 'redo' | null => {
		if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
		const key = event.key.toLowerCase();
		if (key === 'y') return event.shiftKey ? null : 'redo';
		if (key !== 'z') return null;
		return event.shiftKey ? 'redo' : 'undo';
	};
</script>

<!--
	The shortcuts, on the window: the scholar's hands are wherever the mis-aimed gesture left them — on
	a canvas, on a handle, on the Layer list — and "Ctrl+Z only works if you have not moved the focus"
	is not an undo affordance.

	All three are handled here rather than only `Ctrl+Z`: a shortcut this window swallows without acting
	on looks implemented and is not, so a key is claimed only where there is a Step at that end of the
	history to reach.

	`defaultPrevented` stands this down for a keypress something nearer the gesture has already taken:
	one press must move one history, and a control on the window is the last thing to see it.
-->
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
			<!-- `aria-hidden`, beside a word: the icon naming itself as well would be the same thing
			     twice for a screen reader, and would displace the sentence this button is named by. -->
			<Redo2 class="size-4" aria-hidden="true" />
			Redo
		</button>
	{/if}
</div>

<Toast text={announced} testid="edit-history-outcome" tone="info" />

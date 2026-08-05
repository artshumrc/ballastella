<script lang="ts">
	import type { SaveState } from '@ballastella/core';

	/**
	 * The save state, shown (ADR-0017 rule 5).
	 *
	 * There is no Save button, so this is the user's only signal that the tool has their work,
	 * and scholars working on material they care about will not trust a tool that offers none.
	 * An `aria-live` region rather than a tooltip, because a daisyUI tooltip renders through CSS
	 * `::before` and is never announced (ADR-0016).
	 */
	// Not named `state`: a local binding by that name turns every `$state` in this file into a
	// store subscription.
	let { saveState }: { saveState: SaveState } = $props();

	/**
	 * "Saving" is often over in a few milliseconds, especially in OPFS. Shown for less than this
	 * it is a strobe rather than information — and an indicator that flickers is worse than one
	 * that lingers, since the thing it has to convey is reassurance.
	 */
	const MINIMUM_SAVING_MS = 400;

	const LABELS: Record<SaveState, string> = {
		saved: 'Saved',
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
</script>

<!-- The dot is decorative and comes from CSS, so the region's text is exactly the state: a
     screen reader announces "Saving…", not "bullet Saving…". -->
<p
	role="status"
	data-save-state={shown}
	class="text-sm before:mr-1.5 before:content-['●']"
	class:text-success={shown === 'saved'}
	class:text-warning={shown !== 'saved'}
>
	{LABELS[shown]}
</p>

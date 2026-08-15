<script lang="ts">
	// A parent for `MapNotice` in component tests. **Not shipped and not imported by either app.**
	//
	// It exists for one claim that two separate mounts cannot make: that a notice which is always
	// present is the **same element** before and after its text arrives. That is the whole difference
	// between the two mechanisms — a live region is announced when its text changes, and an element
	// inserted with its text already in it is announced by `role="alert"` or not at all — so a test
	// that mounted twice would be asserting two documents rather than one element surviving a change.

	import MapNotice from './MapNotice.svelte';

	// Everything is defaulted rather than optional-and-undefined: `exactOptionalPropertyTypes` is on,
	// so a prop passed through as `undefined` is not the same as one not passed at all. An empty
	// heading is no heading, which is what `MapNotice` already does with one.
	let {
		shape,
		text: initial = '',
		heading = '',
		variant = 'warning',
		testid
	}: {
		shape: 'comes-and-goes' | 'always-present';
		text?: string;
		heading?: string;
		variant?: 'warning' | 'info' | 'plain';
		testid: string;
	} = $props();

	let text = $state(initial);

	/** Give the notice something to say, or `''` to take it back. */
	export const say = (words: string): void => {
		text = words;
	};
</script>

<MapNotice {shape} {text} {heading} {variant} {testid} />

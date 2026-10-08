<script lang="ts">
	import MapNotice from './MapNotice.svelte';

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

	export const say = (words: string): void => {
		text = words;
	};
</script>

<MapNotice {shape} {text} {heading} {variant} {testid} />

<script lang="ts">
	import type { HTMLAnchorAttributes } from 'svelte/elements';

	let { children, ...rest }: HTMLAnchorAttributes = $props();
</script>

<a {...rest} target="_blank" rel="noreferrer noopener">{@render children?.()}</a>

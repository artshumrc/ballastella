<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';

	let {
		busy,
		onclick,
		class: className,
		children,
		...rest
	}: Omit<HTMLButtonAttributes, 'onclick'> & { busy: boolean; onclick: () => unknown } = $props();
</script>

<button
	{...rest}
	class={[className, busy && 'btn-disabled']}
	aria-disabled={busy}
	onclick={() => {
		if (!busy) void onclick();
	}}
>
	{@render children?.()}
</button>

<script lang="ts">
	import { DEFAULT_BASE_MAP_BORDER_STYLE, type BaseMapBorderStyle } from '@ballastella/core';
	import { untrack } from 'svelte';

	import BorderStyleFields from './BorderStyleFields.svelte';

	let {
		borders = 'all',
		style: initialStyle = DEFAULT_BASE_MAP_BORDER_STYLE,
		automatic = { color: '#5f5f5f', lineStyle: 'dashed', width: 1.4 },
		illegibleIn = [],
		onchange,
		oncommit
	}: {
		borders?: 'none' | 'national' | 'all';
		style?: BaseMapBorderStyle;
		automatic?: BaseMapBorderStyle;
		illegibleIn?: readonly ('light' | 'dark')[];
		onchange?: (patch: Partial<BaseMapBorderStyle>, options?: { debounce?: boolean }) => void;
		oncommit?: () => void;
	} = $props();

	let style = $state<BaseMapBorderStyle>(untrack(() => ({ ...initialStyle })));
</script>

<BorderStyleFields
	{borders}
	{style}
	{automatic}
	{illegibleIn}
	onchange={(patch, options) => {
		onchange?.(patch, options);
		style = { ...style, ...patch };
	}}
	oncommit={() => oncommit?.()}
/>

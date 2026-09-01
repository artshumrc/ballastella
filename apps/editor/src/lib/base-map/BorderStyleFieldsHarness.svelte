<script lang="ts">
	// A parent for `BorderStyleFields` in component tests. **Not shipped and not imported by the app.**
	//
	// The round trip is the point, for the reason `AnnotationStyleFaceHarness` records: every control
	// here reports a change and waits for the answer to come back down as a new `style`. A test that
	// asserted against a prop it had set itself would pass against a section that never reported the
	// gesture at all — and the Automatic/Custom switch is exactly that kind of control, since what
	// makes it Custom is the file holding a value rather than the radio being pressed.

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
		/** Reported as well as applied, so a test can assert what the section asked for. */
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

<script lang="ts">
	import type { Annotation, AnnotationGeometry } from '@ballastella/core';
	import { untrack } from 'svelte';

	import AnnotationStyleFace from './AnnotationStyleFace.svelte';

	let {
		id = 'a-1',
		geometry,
		properties: initialProperties = {},
		onstyle,
		oncommit,
		onapplytoall
	}: {
		id?: string;
		geometry: AnnotationGeometry;
		properties?: Record<string, unknown>;
		onstyle?: (style: Record<string, unknown>, options?: { debounce?: boolean }) => void;
		oncommit?: () => void;
		onapplytoall?: () => void;
	} = $props();

	let properties = $state<Record<string, unknown>>(untrack(() => ({ ...initialProperties })));
	const annotation = $derived({ id, geometry, properties: { ...properties } } as Annotation);
</script>

<AnnotationStyleFace
	{annotation}
	onstyle={(style, options) => {
		onstyle?.(style, options);
		properties = { ...properties, ...style };
	}}
	onlinestyle={() => {}}
	oncommit={() => oncommit?.()}
	onapplytoall={() => onapplytoall?.()}
/>

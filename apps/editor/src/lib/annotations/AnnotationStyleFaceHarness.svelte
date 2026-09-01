<script lang="ts">
	// A parent for `AnnotationStyleFace` in component tests. **Not shipped and not imported by the app.**
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// WHY A REAL COMPONENT RATHER THAN REPLACING PROPS FROM THE TEST BODY
	//
	// Every control here reports a change and then waits for the answer to come back down as a new
	// `annotation`: choosing a swatch does not mark itself chosen, the write does. In the running
	// application `ProjectScreen` writes the property and re-reads the collection, so what a control
	// shows is always the file's answer — and a test that asserted against a prop it had set itself
	// would pass against a face that never reported the gesture at all.
	//
	// So the harness reproduces the round trip: `onstyle` merges the property and rebuilds `properties`
	// and the Annotation itself, exactly as re-reading the file does.

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
		/** Reported as well as applied, so a test can assert what the face asked for. */
		onstyle?: (style: Record<string, unknown>, options?: { debounce?: boolean }) => void;
		oncommit?: () => void;
		onapplytoall?: () => void;
	} = $props();

	// Seeded once, then the harness's own: after the first render the properties are whatever the
	// writes have made them, which is what the round trip is for.
	let properties = $state<Record<string, unknown>>(untrack(() => ({ ...initialProperties })));

	/** Rebuilt from scratch on every write, which is what re-reading the file produces. */
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

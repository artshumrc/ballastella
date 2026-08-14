<script lang="ts">
	// A parent for `AnnotationEditor` in component tests. **Not shipped and not imported by the app.**
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// WHY THIS EXISTS: THE PANEL IS HANDED A *FRESH OBJECT* AFTER EVERY KEYSTROKE
	//
	// This is not a convenience over assigning props from the test body — it is the whole subject of
	// one of the claims below. `ProjectScreen` writes each keystroke and then re-reads the collection,
	// so `annotation` is a **different object with the same id** on every character typed.
	// `AnnotationEditor` closes its fields whenever "a different Annotation arrives", and the guard
	// that decides that compares ids rather than identity; written as an effect that merely *read*
	// `annotation.id`, it fired on every one of those fresh objects and shut the fields after one
	// letter.
	//
	// So the harness reproduces the round trip rather than the shortcut: `ontext` merges the typed
	// text and rebuilds `properties` and the Annotation itself, exactly as re-reading the file does. A
	// test that instead mutated a single object in place would never construct the state the bug
	// needed and would pass against the broken component.

	import type { Annotation, AnnotationGeometry } from '@ballastella/core';
	import { untrack } from 'svelte';

	import AnnotationEditor from './AnnotationEditor.svelte';

	let {
		id = 'a-1',
		geometry,
		properties: initialProperties = {},
		onstyle,
		oncommit
	}: {
		id?: string;
		geometry: AnnotationGeometry;
		properties?: Record<string, unknown>;
		onstyle?: (style: Record<string, unknown>, options?: { debounce?: boolean }) => void;
		oncommit?: () => void;
	} = $props();

	// Seeded once, then the harness's own: after the first render the properties are whatever the
	// writes have made them, which is what the round trip below is for.
	let properties = $state<Record<string, unknown>>(untrack(() => ({ ...initialProperties })));

	/** Rebuilt from scratch on every write, which is what re-reading the file produces. */
	const annotation = $derived({ id, geometry, properties: { ...properties } } as Annotation);
</script>

<AnnotationEditor
	{annotation}
	ontext={(text) => (properties = { ...properties, ...text })}
	oncommit={() => oncommit?.()}
	onstyle={(style, options) => {
		onstyle?.(style, options);
		properties = { ...properties, ...style };
	}}
	onlinestyle={() => {}}
	ondelete={() => {}}
/>

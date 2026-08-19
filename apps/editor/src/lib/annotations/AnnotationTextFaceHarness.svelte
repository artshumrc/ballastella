<script lang="ts">
	// A parent for `AnnotationTextFace` in component tests. **Not shipped and not imported by the app.**
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// WHY THIS EXISTS: THE FACE IS HANDED A *FRESH OBJECT* AFTER EVERY KEYSTROKE
	//
	// This is not a convenience over assigning props from the test body — it is the whole subject of one
	// of the claims below. `ProjectScreen` writes each keystroke and then re-reads the collection, so
	// `annotation` is a **different object with the same id** on every character typed. The face closes
	// its fields whenever "a different Annotation arrives", and the guard that decides that compares ids
	// rather than identity; written as an effect that merely *read* `annotation.id`, it fired on every
	// one of those fresh objects and shut the fields after one letter.
	//
	// So the harness reproduces the round trip rather than the shortcut: `ontext` merges the typed text
	// and rebuilds `properties` and the Annotation itself, exactly as re-reading the file does. A test
	// that instead mutated a single object in place would never construct the state the bug needed and
	// would pass against the broken component.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// AND WHY THE FACE IS MOUNTED INSIDE A REAL `AnnotationInspector`
	//
	// **Because "the Annotation is named once" is a claim about the composition and cannot fail below
	// it** (the-annotation-inspector story 4). The header draws the name and the face draws the words,
	// so a face mounted on its own could draw a second title and every count taken in it would still
	// read one. The Inspector is the shared component the application renders and the snippet it is
	// handed is the real face, so what is on the screen here is what an author looks at.
	//
	// No `style` snippet: what a tab strip does is `packages/ui/src/annotation-inspector.dom.test.ts`'s,
	// and a strip here would only add controls to press past.

	import type { Annotation, AnnotationGeometry } from '@ballastella/core';
	import { AnnotationInspector } from '@ballastella/ui';
	import { untrack } from 'svelte';

	import AnnotationTextFace from './AnnotationTextFace.svelte';

	let {
		id = 'a-1',
		index = 0,
		geometry,
		properties: initialProperties = {},
		titling = false,
		ontext,
		ontitled,
		oncommit,
		ondelete
	}: {
		id?: string;
		index?: number;
		geometry: AnnotationGeometry;
		properties?: Record<string, unknown>;
		/** Whether this Annotation has just been drawn, so its title is a field already. */
		titling?: boolean;
		/**
		 * What the face reported was typed, *before* the harness merges it.
		 *
		 * The merge below is the round trip and cannot see the difference between "cleared" and "never
		 * set" — a title of `''` merged in is a title of `''` — while what `setText` is handed is exactly
		 * what decides whether the property is removed (write-on-the-map story 17). So a test that cares
		 * about the report reads it here; the file's own answer is `annotation.test.ts`'s.
		 */
		ontext?: (typed: { title?: string; description?: string }) => void;
		/** The face reports that the title field has the keyboard, so the offer is spent. */
		ontitled?: () => void;
		oncommit?: () => void;
		ondelete?: () => void;
	} = $props();

	// Seeded once, then the harness's own: after the first render the properties are whatever the writes
	// have made them, which is what the round trip above is for.
	let properties = $state<Record<string, unknown>>(untrack(() => ({ ...initialProperties })));

	/** Rebuilt from scratch on every write, which is what re-reading the file produces. */
	const annotation = $derived({ id, geometry, properties: { ...properties } } as Annotation);
</script>

{#snippet text(shown: Annotation)}
	<AnnotationTextFace
		annotation={shown}
		{titling}
		ontext={(typed) => {
			ontext?.(typed);
			properties = { ...properties, ...typed };
		}}
		ontitled={() => ontitled?.()}
		oncommit={() => oncommit?.()}
		ondelete={() => ondelete?.()}
	/>
{/snippet}

<AnnotationInspector {annotation} {index} {text} onclose={() => {}} />

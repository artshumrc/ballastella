<script lang="ts">
	// A parent for `AnnotationLayerContents` in component tests. **Not shipped and not imported by
	// the app.**
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// WHY A REAL COMPONENT RATHER THAN REPLACING `selectedId` FROM THE TEST BODY
	//
	// The same argument `LayerListHarness.svelte` makes. `AnnotationLayerContents` owns none of the
	// state its own gestures change: a click on a row calls `onselect`, "New Annotation" calls
	// `onselect(null)`, and both then wait for the selection to come back down as a prop. In the
	// running application `ProjectScreen` updates that `$state` synchronously inside the callback, so
	// the row is marked or unmarked by the time the click returns. A test that assigned a new
	// `selectedId` afterwards would be asserting its own assignment rather than the component's
	// behaviour, and would still pass if the component stopped reporting the gesture at all.
	//
	// The drawing state is here for the same reason: whether the shapes or the resting button are on
	// screen is `picking`, which the real `AnnotationDrawing` owns — the component reports "New
	// Annotation" and waits for the answer to come back down.

	import type { AnnotationCollection } from '@ballastella/core';
	import { untrack } from 'svelte';

	import { provideInstalledApp } from '$lib/pwa/installed-app.svelte';

	import AnnotationLayerContents from './AnnotationLayerContents.svelte';
	import { AnnotationDrawing, type AnnotationTool } from './drawing.svelte';

	let {
		collection,
		selectedId: initialSelectedId = null,
		tool: initialTool = 'select',
		status = '',
		canFinish = false,
		onselect
	}: {
		collection: AnnotationCollection | null;
		selectedId?: string | null;
		/**
		 * The tool in hand at mount, for the state the page is in mid-gesture. Seeded like `selectedId`,
		 * and the harness's own afterwards.
		 */
		tool?: AnnotationTool;
		status?: string;
		canFinish?: boolean;
		/** Reported as well as applied, so a test can assert what the component asked for. */
		onselect?: (id: string | null) => void;
	} = $props();

	// Seeded once, then the harness's own: after the first render the selection is whatever the last
	// gesture asked for, which is the point of the harness.
	let selectedId = $state(untrack(() => initialSelectedId));

	// **The real state machine, not a boolean of the harness's own.** Which tool is in hand and whether
	// the shapes are on offer are one object's answer, and the rules that matter here — "New
	// Annotation" offers the shapes, finishing or cancelling puts them away — are its rules.
	const drawing = new AnnotationDrawing();
	if (untrack(() => initialTool) !== 'select') drawing.choose(untrack(() => initialTool));

	// The place-search control three levels down reads the one `InstalledApp` from context, which the
	// root layout provides and there is no root layout here. This is the real one rather than a fake:
	// constructing it registers nothing — `start()` is what adds the online/offline listeners, and
	// nothing here calls it — so the component gets the object it expects and this file gets no
	// second pair of listeners.
	provideInstalledApp();
</script>

<AnnotationLayerContents
	{collection}
	{selectedId}
	tool={drawing.tool}
	picking={drawing.picking}
	{status}
	drawing={drawing.drawing}
	{canFinish}
	onnew={() => drawing.offerShapes()}
	onchoosetool={(chosen) => drawing.choose(chosen)}
	onplace={() => {}}
	onfinish={() => drawing.finish()}
	oncancel={() => drawing.cancel()}
	onundovertex={() => drawing.undoVertex()}
	onselect={(id) => {
		onselect?.(id);
		selectedId = id;
	}}
	onmove={() => {}}
/>

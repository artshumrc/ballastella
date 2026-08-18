// Where a Map Image is served from, derived so that an unrelated Workspace change is not a
// reason to rebuild a live pane (ticket 07).
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ THE POINT OF THIS MODULE IS THAT THE TWO-STEP DERIVE IS TESTABLE.                         │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// Both of these lived inline — one in `AlignmentWorkspace.svelte`, one in `BaseMapPane.svelte` —
// each with a paragraph explaining that collapsing it back into a single object-valued `$derived`
// reintroduces a rebuild storm. Both explanations were correct and **neither was defended by
// anything**: collapse either one and the whole suite stays green, because what goes wrong is a
// warped layer being torn off and rebuilt underneath a scholar mid-alignment, which shows up as a
// browser test that flaps rather than as one that fails.
//
// The mechanism is Svelte's, and it is not subtle once stated. A `$derived` holding an **object**
// takes a new identity whenever it recomputes, and identity is what decides whether a dependent
// effect re-runs. `EditorSession.mapImageSource` builds a fresh object on every call and reads
// two `$state` arrays behind it, so a derived holding its result changed identity whenever anything
// in those arrays changed — a Map Image added in another Project's dialog, a Workspace refresh,
// a map copied offline elsewhere. Deriving the **service string** first fixes it at the root: a
// string compares by value, so the object below is rebuilt only when the address or the image really
// changed, which is exactly when both panes should be rebuilt and never otherwise.
//
// Measured before this module existed: `editor-alignment-refinement.e2e.ts:314` went red once and
// passed on retry on the first full run with the collapsed form in it, which is what a rebuild
// racing a reload looks like from the outside.
//
// Out here, the same guards are ordinary functions over signals, and `map-source.svelte.test.ts`
// counts how many times a dependent effect runs. That test is red for the collapsed form of either.

import type { MapImageSource } from '@ballastella/core';

/** A read of a signal, passed as a thunk so the caller's `$state` or prop stays the source. */
type Read<T> = () => T;

/**
 * Where one Map Image's tiles are, as the alignment surface hands it to both panes.
 *
 * Resolved once and handed down, because the component that reads this is also the one that writes
 * the Alignment, and the two answers have to be the same one: `session.mapImageSource` is what
 * `#alignmentAddressFor` reads, so the sheet in the pane and the `resource.id` in the file cannot
 * name different servers. A pane that resolved this for itself would be a second lookup, and the two
 * drifting is a Library map drawn correctly and written unresolvable.
 *
 * A live derivation rather than a value read once: `remoteOrigins` changes when a map is copied
 * offline, and from that moment the pane should read the Workspace's own pyramid rather than the
 * Library's.
 *
 * @param lookUp the session's `mapImageSource`, as a function, so this module needs nothing of
 *   `EditorSession` but the one question — and a test needs no session at all.
 */
export function mapImageSourceOf(
	lookUp: (imageId: string) => MapImageSource,
	imageId: Read<string>
): { readonly current: MapImageSource } {
	// ⚠ **A primitive first, and that is the whole guard.** See the module header.
	const service = $derived.by(() => {
		const found = lookUp(imageId());
		return found.imageMode === 'referenced' ? found.service : '';
	});

	// Stable for the same reason: a `$derived` recomputes only when *its* dependencies change, and
	// these are a string and an id.
	const current = $derived<MapImageSource>(
		service === ''
			? { imageMode: 'offline-copy', imageId: imageId() }
			: { imageMode: 'referenced', imageId: imageId(), service }
	);

	return {
		get current() {
			return current;
		}
	};
}

/**
 * The same address as the warped renderer needs it: whether it is referenced, and which service.
 *
 * **Two primitives rather than one object, and the difference is a rebuild storm.** These are
 * dependencies of the effect that adds the warped layer, deliberately — the address is baked into
 * the renderer's document at `addGeoreferencedMap`, so unlike the Alignment's content it cannot be
 * applied in place, and making an offline copy of a map open here has to rebuild the layer for the
 * change to take effect. That makes them the *most* expensive derives in the application to get
 * wrong: an object here would tear the warped layer off the map and build another whenever anything
 * upstream of the source changed, however unrelated.
 *
 * @param source the alignment's `MapImageSource`, or `null` while there is nothing to draw.
 */
export function warpedAddressOf(source: Read<MapImageSource | null | undefined>): {
	readonly referenced: boolean;
	readonly service: string;
} {
	const referenced = $derived(source()?.imageMode === 'referenced');
	const service = $derived.by(() => {
		const found = source();
		return found?.imageMode === 'referenced' ? found.service : '';
	});

	return {
		get referenced() {
			return referenced;
		},
		get service() {
			return service;
		}
	};
}

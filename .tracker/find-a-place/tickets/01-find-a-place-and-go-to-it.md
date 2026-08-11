# Find a Place and go to it

## What to build

A scholar types a place name into the Base Map pane, presses Enter, sees the candidate Places, picks one, and the map frames on it. A city fills the pane; a house address frames tight.

Because the Base Map pane is shared, this lands on the **Project screen and the alignment screen at once**.

**This slice designs the search surface, and it is the only one that will.** Slices 2, 3 and 4 all build on what you make here. Build the field and the candidate list as one component with the Annotation Layer's later reuse in mind, but do not build that reuse.

Read [`SPEC.md`](../SPEC.md) and [ADR-0029](../../../docs/adr/0029-place-lookup-is-a-warned-service-that-leaves-nothing-behind.md) first. The ADR is the answer to every "why is it like that" below, and every alternative you might think of has already been argued and declined there.

## Where to start

**The configuration module to copy:**

- `packages/core/src/base-map/catalog.ts` — read the header box. It states the property you must reproduce: *change this file, and nothing else*. `base-map/entry.ts` shows how the typed shape is kept apart from the values.
- `scripts/check-base-map-catalog.mjs` — the containment scan that enforces it. **Slice 4 writes the equivalent for this module. You do not.**

**The framing seam, which already exists:**

- `packages/core/src/project/opening-view.ts` — `GeoBounds`, `openingViewFit`, `FittableMap`, `applyOpeningFit`, and the constants `OPENING_VIEW_PADDING` and `OPENING_VIEW_MAX_ZOOM`. Read the comment at `applyOpeningFit` explaining why **object identity** is the guard and not a value comparison; a fit that re-runs will fight the scholar's own panning.

**How core already talks to the network:**

- `packages/core/src/remote-iiif/cors-probe.ts` and `remote-iiif/remote-resource.ts` — the existing example of "the request failed, and here is what to tell a human" rather than letting an exception escape.
- `packages/core/src/index.ts` — core's single export surface.

**The surface:**

- `apps/editor/src/lib/base-map/BaseMapPane.svelte` — the pane and its MapLibre instance. **It is shared**: `apps/editor/src/lib/project/ProjectScreen.svelte` and `apps/editor/src/lib/alignment/AlignmentWorkspace.svelte` both render it, so a prop added here appears at two call sites.
- `apps/editor/src/lib/base-map/BaseMapSwitcher.svelte` — an existing small control on this pane; how one is placed and styled under ADR-0016.
- `apps/editor/src/lib/annotations/AnnotationTools.svelte` — **the accessibility idiom to copy.** Native elements, `aria-live` with `aria-atomic` (not `role="status"`, which the save indicator already owns on the Project screen), an announcement naming the state rather than only drawing it, and the `sr-only` treatment for a region with nothing to say. Read its note about the `min-h-6` reserve it paid for on every screen that was not mid-gesture.
- `apps/editor/src/lib/pwa/installed-app.svelte.ts` — `useInstalledApp().online`, the editor's connection signal.

**The tests:**

- `e2e/editor-base-map.e2e.ts` — how this pane is driven, including routing a host to a committed fixture.
- `e2e/support/network-fence.ts` — the default-deny fence. Read it before writing any spec; `test` must be imported from there, and `scripts/check-e2e-network-fence.mjs` fails `pnpm lint` if it is not.
- `packages/core/src/base-map/resolve.ts` — `baseMapUnavailableNotice` and its tests, the model for outcome sentences.

## Contract

**The service and its attribution live together in one editable module** in the domain package, modelled on the Base Map catalog. Repointing one without the other is a real bug: a fork serving its own tiles while keeping the default lookup would show the wrong credit and leave the lookup's data uncredited.

**The lookup returns outcomes as values, never exceptions.** This slice produces three of the four:

```ts
export interface Place {
	/** The service's display name — for the candidate list only. Never a Pin's title. */
	readonly name: string;
	/** Where a Pin would go. */
	readonly point: GeoPoint;
	/** Where the camera goes. Never written to any file. */
	readonly bounds: GeoBounds;
}

export type LookupOutcome =
	| { readonly kind: 'places'; readonly places: readonly Place[] }
	| { readonly kind: 'none' }
	| { readonly kind: 'unanswered' };
```

> Slice 2 adds a fourth member and refines `unanswered`'s wording. **Do not add a member this slice does not produce** — `overlay-points.ts` records what that costs: ticket 10 declared a kind, styled it, emitted none, and left the code promising an affordance the app did not have.

**`none` and `unanswered` must be impossible to confuse.** They are the same shape to a careless consumer — neither has candidates — and telling a scholar there is no such place when the request never left the building is the inversion `nothing-fails-silently` story 10 forbids.

**Submit-only. Typing issues no request.** Not debounced, not throttled-with-a-short-delay: nothing leaves until the query is submitted. The default service's policy prohibits client-side autocomplete outright. **State in a comment that this is contingent** — it is what this service requires, not a claim that as-you-type is wrong; other services exist precisely for it, and a future maintainer swapping one in must be able to see the fence was a consequence rather than a judgement.

**Candidates are shown; the top hit is never taken silently.** `CONTEXT.md` defines a Place as a candidate. Choosing one on the scholar's behalf contradicts the glossary, and a Pin in the wrong Springfield is indistinguishable from one in the right Springfield.

**Framing goes through the existing opening-view fit and its constants.** Do not re-derive padding or a maximum zoom. If those names read wrongly for a Place, add a sibling calling the same helper — never a second copy of the numbers. **No zoom heuristic may exist anywhere in this feature.**

**Navigation drops no marker.** The framing is the answer. A marker at the found point would be a thing on screen with no meaning, indistinguishable at a glance from an Annotation the scholar made.

**Attribution shows on the candidate list**, from the configuration module — not from the Base Map catalog, and not as permanent chrome. Visible exactly while that data is on screen, and gone when the list is.

**Keyboard-operable and announced.** SPEC stories 20 and 21. A list of results is precisely the control that ships mouse-only.

**Visible text, never a tooltip.** CONTRIBUTING is explicit that a tooltip is not an information channel.

**No layout is held open when nobody is searching.**

**One captured real response is committed under `e2e/fixtures/`**, for a query with several candidates — so disambiguation is exercised against real data rather than two hand-written entries that are always unambiguous. Slices 2 and 3 route this same fixture.

## Out of scope

- **Placing any Annotation.** Slice 3. Nothing in this slice writes to a Project.
- **The rate limiter, the *too fast* outcome, the connection-signal suppression, and the no-overclaim test.** Slice 2. Your `unanswered` sentence may be plain; slice 2 refines it.
- **The lint containment scan, the deployment warning, the hand-run probe, and hosting documentation.** Slice 4. Do not add anything to `package.json`'s `lint` or `check:deployment`.
- **The published viewer.** `apps/viewer` is not touched. `ReaderMapPane.svelte` is "the same picture with authoring attached" and will look like it is missing this. ADR-0029 fences it deliberately.
- **Autocomplete, recent searches, reverse lookup, caching, bulk import.** All declined in ADR-0029, not deferred.
- **Changing `applyOpeningFit`, the opening-view constants, or `catalog.ts`.** Call them; leave them alone.

## Acceptance criteria

- [ ] On the Project screen, submitting a place name shows candidates from the committed fixture, and choosing one frames the map on that candidate's bounds.
- [ ] The same works on the alignment screen, **asserted there** rather than assumed from the shared component.
- [ ] **Typing without submitting issues zero requests**, asserted by **counting requests made while typing** — not by asserting the candidate list is empty. **Mutate this specifically:** wire the field to fire on input, confirm the test goes red, and restore. A test that only checks for an empty list passes against a debounced implementation, which is the violation.
- [ ] A query matching nothing and a service that does not answer produce **different visible text**, asserted by comparing the two strings — not by asserting either list is empty. **Mutate this specifically:** make both render the same sentence and confirm red.
- [ ] Every candidate is reachable and choosable by keyboard alone, asserted without a pointer.
- [ ] The outcome is announced, with the mechanism chosen deliberately and the reason stated in code.
- [ ] The service's attribution is visible while candidates are shown, and absent when they are not.
- [ ] No marker is drawn at the found point.
- [ ] The pane holds no extra layout open when no search is in progress.
- [ ] A fixture holding a real multi-candidate response is committed under `e2e/fixtures/`.
- [ ] No source file outside the new configuration module names the service host. (Not yet enforced by a script — slice 4 does that. Check it by hand and say you did.)
- [ ] The mutation check is recorded per criterion. **Report any surviving mutation as green, with its reason.**

```sh
pnpm --filter @ballastella/core exec vitest run src/places
pnpm exec playwright test e2e/editor-base-map.e2e.ts
pnpm lint && pnpm check && pnpm -r build && pnpm -r test
pnpm test:e2e
```

All four exit 0. **Read exit codes directly.** Never pass `--reporter=` — it replaces the reporter list and silently disables the retry budget. Do not pipe gate output through `grep`. No test may reach the network: drive every lookup by routing to the committed fixture.

## Blocked by

None — can start immediately.

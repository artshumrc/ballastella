# Add a Historical Map from the sidebar, from any of three sources

## What to build

One button in the Layer sidebar — "Add a Historical Map" — offering three sources with equal visibility: a file on this computer, a remote IIIF address, or a Historical Map already in the Workspace. Whichever is chosen, a Layer appears in the stack and progress is reported on that Layer's own card.

Demonstrable end to end: add a map from a file and watch tile progress on the new Layer's card; add one from a IIIF Manifest and pick which image is the map; add one you already have and see it appear instantly with its existing Alignment already in place.

## Where to start

- The Layer sidebar from ticket 05 — this adds one affordance to it.
- `apps/editor/src/lib/components/ProjectView.svelte` as ticket 04 left it — the file input, the ingest progress region with its `aria-live` and cancel button, and the `session.ingestImage(file)` call. **The progress region's comment explains why it is `aria-live` rather than `role="status"`** (the save indicator already owns that role on the page); the same reasoning applies wherever it lands.
- `apps/editor/src/lib/remote-iiif/AddRemoteMap.svelte` (299 lines) and `add-remote-map.svelte.ts` — the existing remote flow: paste a URL, resolve a Manifest, Collection, or bare image service, pick a canvas from a list of real `<button>`s, probe, and add. This is reused, not rewritten.
- `apps/editor/src/lib/remote-iiif/lookup-setting.svelte.ts` and `packages/core/src/remote-iiif/community-alignments.ts` — the ADR-0015 community Alignment lookup. It stays.
- `apps/editor/src/lib/editor-session.svelte.ts` — `ingestImage`, `addReferencedMap`, `cancelIngest`, `ingest`, `ingestLabel`, `ingestError`, and `images` (the Workspace's Historical Maps after ticket 01).
- `packages/core/src/tiler/ingest.ts` — `ingestImageFile`, its `signal`, and `streamingTilerUnavailableReason`.

## Contract

**Three sources, equally visible, in one place.** Not a file input with the other two hidden behind links. A user who has a map on their laptop, a map at a library, and a map they prepared last week should see all three answers at once.

**"Already in the Workspace" excludes maps already in this Project.** Offering something that would do nothing is worse than not offering it. The list shows each map's label and size.

**Adding a map already in the Workspace copies nothing.** It creates a Layer referencing that `imageId`. Its Alignment is already there and applies immediately — that is the whole point of ADR-0023, and if the map is aligned the Layer draws on the Base Map straight away with no further action.

**Progress belongs to the Layer.** A Layer appears first, then reports its own preparation on its card: the phase, the tile count, and a cancel button. The announcement carries the same numbers as the bar — a screen-reader user is told the tile count, not that something is "loading". Keep `aria-live="polite"` with `aria-atomic="true"` rather than `role="status"`, and keep the reason: the save indicator owns `status` on this page, and two of them make the role ambiguous for a test and for a screen reader alike.

**Cancelling leaves the Project and the Workspace exactly as they were.** `ingestImageFile` already takes an `AbortSignal` and cleans up after itself. Cancelling must also remove the Layer that was created for the cancelled map — a Layer pointing at a pyramid that was never written is the dangling-reference trap ticket 02 closed, arriving by another door.

**An over-threshold image is refused with the reason it cannot be tiled**, asked *before* the tiler module is imported, as `ingestImage` already does via `streamingTilerUnavailableReason`. Do not change that message's substance; it is the honest account of a real limit.

**The file input clears itself after a pick**, so choosing the same file twice runs twice. `change` does not fire for an unchanged value, and "nothing happened" is indistinguishable from a silent failure.

**Adding the same remote resource twice produces one Layer.** `generateId(uri)` is deterministic, so the second add lands on the same image id. That is a feature — a whole class adding the same map produces one map each, and a colleague's Project agrees.

**Empty states name the next action.** A Project with no Layers says what to do, in one sentence, and the thing it names is the button that is there.

**And one of them has to say more than that — a state ticket 04 left without a persistent explanation.** A Historical Map whose starter Alignment could not be written arrives with its pyramid and *without* its Layer (ADR-0023 writes the Alignment first on purpose). While the failure is on screen `session.ingestError` says so; `EditorSession.open()` clears it (`editor-session.svelte.ts`), so after a reload the sidebar says "This Project has no Historical Maps yet" while a pyramid the scholar watched land sits in the Workspace, with nothing connecting the two. `ProjectView`'s `align-unavailable` alert used to cover this because it derived from `session.images` and therefore survived a reload; ticket 04 deleted it with the section it lived in, which is licensed — a Workspace map this Project does not draw is not a fact about this Project — but this half of it was real and is now unsaid. The Workspace-side answer is ticket 08's hub list; what belongs here is that the "already in the Workspace" source offers that orphaned pyramid, so the one useful next action is available rather than merely described.

## Out of scope

- **Do not change how a remote address is resolved, how canvases are listed, or how the community Alignment lookup works.** Reuse `AddRemoteMap`'s machinery. It handles Manifests, Collections, and bare image services, and its canvas picker is already keyboard-operable.
- **Do not change the ingest pipeline, the tiler, or the pyramid format.**
- **Do not add the remote-alignment probe.** Ticket 07 adds it to this flow — which is exactly why that ticket is blocked by this one.
- **Do not build the Workspace-wide Historical Maps list with sizes and used-by.** Ticket 08. The picker here needs labels and sizes; it does not need used-by or delete.
- **Do not add bulk adding** — no multi-select file input, no "add all canvases".
- **Do not touch `MirrorMap`** beyond keeping it reachable. Ticket 11.

## Acceptance criteria

- [ ] One "Add a Historical Map" affordance in the sidebar offers all three sources without any of them being behind an extra step.
- [ ] Adding from a file creates a Layer immediately and reports tile progress on that Layer's card.
- [ ] The progress announcement contains the tile numbers, and `getByRole('status')` on the Project screen is unambiguous.
- [ ] Cancelling a preparation removes its Layer and leaves no bytes in `images/` and no Alignment.
- [ ] Picking the same file twice in a row starts two preparations.
- [ ] An image above the tiling threshold is refused with a message about tiling, and the tiler module is never fetched — assert by watching the network, not by reading a flag.
- [ ] Adding from a IIIF Manifest with several images lets the user pick which image is the map, by keyboard.
- [ ] Adding the same remote address twice leaves one Layer.
- [ ] The "already in the Workspace" list shows labels and sizes and omits maps already in this Project.
- [ ] Adding an already-aligned Workspace map produces a Layer that draws on the Base Map with no further action and copies no bytes — assert the pyramid's file count in the Workspace is unchanged.
- [ ] A Project with no Layers shows a sentence naming the next action.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm exec playwright test e2e/editor-image-ingest.e2e.ts e2e/editor-remote-iiif.e2e.ts e2e/editor-layers.e2e.ts
pnpm test:e2e
```

All green. `e2e/editor-image-ingest.e2e.ts` already asserts tiler laziness by watching the network — that is the prior art for the threshold criterion, and it is the right shape because a flag can be set while the module is still fetched.

The cancel criterion is the one most likely to pass vacuously: assert on the Workspace's file list and on `project.json`, not on the absence of an error.

## Blocked by

- Ticket 02
- Ticket 05

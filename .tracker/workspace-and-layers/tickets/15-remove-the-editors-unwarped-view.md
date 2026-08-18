# Remove the editor's unwarped view, and triiiceratops with it

## What to build

The editor's "View unwarped" affordance goes, and `triiiceratops` comes out of the editor's dependencies. The **published viewer keeps** its unwarped view — that is a reader feature and stays exactly as it is.

Demonstrable end to end: no "View unwarped" control anywhere in the editor; the editor's built bundle contains no OpenSeadragon; a published site still opens a Map Image as a document.

## Why this is a reduction and not a loss

The affordance works for **referenced remote maps only**, and the code says why: `triiiceratops` 1.0.0-rc.35 offers no way to accept a custom OpenSeadragon `TileSource`, so a locally ingested pyramid — which has no URL — cannot be shown. `storedPyramidTileSource` exists in core and is tested, and there is nowhere to pass it.

So a user with two Map Images, one from a file and one from a library, sees "View unwarped" on one and not the other **for reasons they cannot possibly infer**. That is the opposite of an interface that documents itself.

And since ticket 07, the alignment view deep-zooms **any** Map Image, local or remote, in the same pane. "Look closely at this sheet" is now answered uniformly. That is why this ticket is blocked by ticket 07 rather than standing alone.

## Where to start

- `apps/editor/src/lib/remote-iiif/UnwarpedView.svelte` — deleted. **Read its header comment first**: it documents the parser boundary it holds and the upstream limitation above, and both facts belong in the commit message that removes it.
- `apps/editor/src/lib/remote-iiif/unwarped-manifest.ts` — the synthesised Manifest for a bare image service. Deleted if the editor is its only consumer; the viewer has its own copy at `apps/viewer/src/lib/unwarped-manifest.ts`.
- `apps/editor/src/lib/components/ProjectView.svelte` as tickets 04 and 05 left it, and wherever the `view-unwarped` control ended up — the button, `unwarpedImageId`, and the `unwarped` derived value.
- `apps/editor/package.json` — the `triiiceratops` dependency, and `pnpm-workspace.yaml`'s catalog pin.
- `packages/core/src/…` — `storedPyramidTileSource`. **Decide and record**: it is tested and unused once this lands. Either keep it with a comment naming the upstream gap it is waiting on, or delete it. Do not leave it silently orphaned.
- `scripts/check-viewer-deps.mjs` — the dependency fence. Check whether it needs to say anything new.
- `THIRD-PARTY-NOTICES.md` — `triiiceratops` and OpenSeadragon entries, if the editor was the reason for them.
- `docs/adr/0018-triiiceratops-embedded-as-a-svelte-component.md` — needs an amendment note saying it now applies to the viewer alone.
- `e2e/editor-remote-iiif.e2e.ts` — its unwarped assertions go. `e2e/viewer-reader.e2e.ts`'s must stay green untouched.

## Contract

**The viewer keeps its unwarped view, unchanged.** SPEC story 101 is rescoped to the viewer, not dropped. If `apps/viewer` shares anything with the editor's deleted copy, the viewer's must keep working — duplicate rather than break it.

**`triiiceratops` leaves `apps/editor`'s manifest.** If the viewer needs it, it declares it itself.

**ADR-0018 gains an amendment note** saying the decision now applies to the published viewer only, and why the editor no longer needs it: alignment shows any sheet deep-zoomably, and the editor-side viewer could never show a locally ingested pyramid.

**The licence notices stay honest.** If `triiiceratops` and OpenSeadragon still ship in the viewer, their entries stay; if the editor's removal changes what is redistributed, `THIRD-PARTY-NOTICES.md` changes with it.

**The editor's bundle gets measurably smaller.** Record the before-and-after size in the commit message — it is the one number that shows this was worth doing.

## Out of scope

- **Do not touch the published viewer's unwarped view.** Not to refactor it, not to share code with it, not to "improve" it while you are there.
- **Do not remove annotation-on-the-unwarped-image from the roadmap.** ADR-0014 still names it as the most likely next feature; this removes an editor affordance, not a future.
- **Do not attempt to make `triiiceratops` accept a stored pyramid.** That is upstream work and is not this ticket.
- **Do not remove the alignment view's own zoom controls** — "Fit whole map", "Zoom to full resolution", and the two step-zoom buttons are how a sheet is now examined closely.
- **Do not delete `apps/editor/src/lib/image-pane/`.** That is the pane that survives.

## Acceptance criteria

- [ ] No "View unwarped" control exists anywhere in the editor.
- [ ] `triiiceratops` appears in no `dependencies` block under `apps/editor` and in no editor source file.
- [ ] The editor's built output contains no OpenSeadragon.
- [ ] A published site still opens a Map Image as a document, and `e2e/viewer-reader.e2e.ts` passes with no change to its assertions.
- [ ] `storedPyramidTileSource` is either deleted or carries a comment naming the upstream gap it waits on — not silently orphaned.
- [ ] ADR-0018 carries an amendment note scoping it to the viewer.
- [ ] `THIRD-PARTY-NOTICES.md` matches what is actually redistributed.
- [ ] The editor's bundle is smaller, with the before-and-after figures recorded.
- [ ] The alignment view still deep-zooms both a Workspace-held and a referenced Map Image.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
grep -rn "triiiceratops\|Triiiceratops\|openseadragon\|OpenSeadragon" apps/editor/src apps/editor/package.json
grep -rilE "openseadragon" apps/editor/build | head
pnpm exec playwright test e2e/viewer-reader.e2e.ts e2e/editor-remote-iiif.e2e.ts
pnpm test:e2e
```

Both greps must find nothing under `apps/editor`. The viewer spec must pass **without its assertions being edited** — if you find yourself changing what it asserts, you have removed the wrong thing.

Record bundle size with:

```sh
du -sh apps/editor/build/_app/immutable
```

before and after.

## Blocked by

- Ticket 07

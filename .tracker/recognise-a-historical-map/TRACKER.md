# Tracker for recognise-a-historical-map

## Purpose

A scholar can recognise each of their Historical Maps by looking at it, on the Workspace hub and in the
picker for a map they already have. The picture is **the coarsest single tile of the pyramid the map
already has** — so nothing is generated, no file is written, no ingest step is added, and every map
already in a Workspace gains a picture with no action from its owner.

Scope, user stories, and the testing approach are in [SPEC.md](./SPEC.md). The decisions are in
[ADR-0030](../../docs/adr/0030-a-historical-maps-thumbnail-is-its-coarsest-pyramid-tile.md), written
before any ticket, and it is the reference for every "why is it like that" question below.

## Current status

Overall status: `Not Started`

Current ticket: none.

Last updated: 2026-08-12.

## What is already decided — do not re-derive it

Twelve decisions came out of a design interview on 2026-08-12 and are recorded in ADR-0030. The ones most
likely to be re-opened by an implementer acting reasonably:

- **Nothing is generated and nothing is marked.** A level-0 pyramid's coarsest level is already a
  whole-sheet derivative of at most 256 × 256, and `wholeImageDerivative` already computes its URL. A
  dedicated `thumbnail.jpg` was argued for and declined: it costs an ingest change, duplicate bytes
  against ADR-0008's ~1 GB cliff, and a second whole-image derivative beside the one the Manifest
  already names. Whether a picture exists is **observed**, never stored — the same rule that deleted
  `imageMode` in ADR-0023.
- **One derivation for both tile locations.** Reading the URL out of the stored `manifest.json` is free
  and was declined, because a referenced map has no `manifest.json` of ours and so it could never be made
  uniform.
- **`/full/!256,256/` is not used for referenced maps.** It is sharper and it 404s on a level-0 service,
  which this app accepts whenever the declared pyramid is already deep enough.
- **The size varies between roughly 129 and 256 px** on the dominant axis and that is inherent — a
  1200 × 851 sheet yields 150 × 107. The 96 px box sits under the worst case so nothing is upscaled.
  `object-contain`, never `object-cover`: a sheet's proportions are information.
- **The hub touching the network for referenced maps is accepted and is not warned about.** ADR-0007's
  concern is copying a Library's bytes into the Workspace, not displaying what the Library publishes to
  be displayed. `loading="lazy"` keeps it to what is on screen.
- **One silent glyph covers loading, absent, and failed.** A scholar cannot tell "still coming" from "not
  available", accepted knowingly. Do not add a spinner, a skeleton, or a message.
- **`CONTEXT.md` stays unchanged.** A thumbnail has no user-facing word — it is a silent picture with an
  empty `alt` — so the glossary has nothing to protect, and it is a role rather than a new artifact.
- **The published viewer gets nothing.** Its hub lists Projects and never Historical Maps. This will look
  like an oversight. It is not.

## Standing constraints

Carried from `find-a-place`, `nothing-fails-silently`, and `workspace-and-layers`, where each was paid
for.

- **The mutation check is mandatory.** Break the behaviour, confirm the test goes red, restore, record
  what you broke. Two-axis review found real defects after a green report in sixteen of sixteen tickets
  in `workspace-and-layers`, and in four of four in `find-a-place`.
- **No test may reach the network.** Enforced by `e2e/support/network-fence.ts` with
  `scripts/check-e2e-network-fence.mjs`, and by the domain package's `refuse-network.ts`. Drive every
  Library from the committed `library.test` fixture, never a stubbed global.
- **Never pass a reporter override on the command line.** It silently disables the retry budget. Read
  exit codes directly; do not pipe gate output through `grep`.
- **The failure mode is claims outrunning code.** If something is left open, say so plainly rather than
  describing it as closed.
- **No module may build an `images/…` path outside the injection layer.**
  `scripts/check-workspace-rooted-paths.mjs` refuses it, and its header explains why the failure it
  guards is invisible rather than loud.
- **No service worker serving the store.** `store-image-fetch.ts`'s header refuses it by name and ends
  *"Do not reintroduce it as the cleaner approach."* Every implementer on this epic will hit the wall
  that prompts it.

## The assertions that pass vacuously

Three, and each has a precedent in this tracker. They are called out again in the tickets that own them.

1. **`expect(img).toBeVisible()` passes for a broken image** — a 404'd `<img>` is visible and laid out at
   its attribute dimensions with no pixels in it. `naturalWidth` is the only assertion that can go red,
   and **there is no precedent for it in this suite**, so it will not be copied from a neighbour.
2. **Asserting `src` against a string the test just computed compares the computation with itself**, and
   passes however wrong the arithmetic is. This is the shape that made `find-a-place` ticket 03's
   byte-identity claim compare a file with itself.
3. **Ticket 04's visible outcome is identical before and after the change it tests.** An assertion that
   does not name `blob:` or count requests to the Library is testing nothing.

A fourth is a flake rather than a vacuum: **`loading="lazy"` hangs an assertion whose card is below the
fold**, because the request never fires. The card being in the viewport must be deliberate, not
incidental to the default window size.

## Seams

No new seam is to be introduced. The two that exist, plus the pre-existing script suite:

- the **domain package's node project**, against an in-memory store, for the resolver — string building
  with no fetch, so the network question does not arise;
- the **browser suite** for every claim about a picture actually appearing, which is the only honest home
  for "it decoded".

Explicitly **no component-test runner** for `MapThumbnail`, even though the domain package has a browser
project for the tiler. `CONTRIBUTING.md` says exactly two seams and no others.

## Ordering

**01 is the tracer bullet and gates everything.** It establishes the geometry reader, the resolver, the
`thumbnail` field, the component, the hub wiring, and both test seams, and it is demoable on its own: add
a map from a file, see its picture on the hub. Referenced maps show the glyph after it, which is correct
rather than unfinished.

**02 and 03 are parallel** once 01 lands. Neither needs anything from the other. 02 is deliberately small
— one component in a second place — and 03 is the larger of the two because it changes what `remote.json`
records.

**04 is last and is tests only.** It proves the Offline Copy flip, whose expected code change is zero.

01 is the largest by a distance. Building 03 first would mean designing the resolver and the component
around the referenced case and then retrofitting the Workspace-held one, which is the majority case and
the one with no network in it.

## Ledger

| Number | Filename | Status | Depends On |
| --- | --- | --- | --- |
| 01 | [01-a-workspace-held-historical-map-shows-its-picture.md](./tickets/01-a-workspace-held-historical-map-shows-its-picture.md) | Not Started | — |
| 02 | [02-the-picker-shows-the-same-pictures.md](./tickets/02-the-picker-shows-the-same-pictures.md) | Not Started | 01 |
| 03 | [03-a-referenced-historical-map-shows-a-picture-from-its-library.md](./tickets/03-a-referenced-historical-map-shows-a-picture-from-its-library.md) | Not Started | 01 |
| 04 | [04-an-offline-copy-moves-the-picture-into-the-workspace.md](./tickets/04-an-offline-copy-moves-the-picture-into-the-workspace.md) | Not Started | 03 |

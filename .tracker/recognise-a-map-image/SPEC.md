# Recognise a Map Image

## Problem Statement

A scholar's Workspace hub lists its Map Images as text: a label, a size, where the tiles are, and
which Projects use each one. When the label is missing it lists a random identifier instead. A scholar
who has brought in a dozen sheets from the same atlas — or the same city in three different decades —
cannot tell which entry is which without opening a Project and drawing it.

The same is true at the moment it matters most. The picker that offers "a Map Image you already
have" is the same text list, so choosing which of eleven scans to add to a new Project means
recognising a map by its filename.

Two further consequences follow from the same gap. Local image ids are random rather than content
hashes, so the same file added twice is two Map Images (ADR-0023) — and a text list gives a
scholar no way to notice they have done it. And a Map Image is the one thing in a Workspace that
is expensive: a scholar deciding what to delete to stay under a hosting budget is deciding from a
size in megabytes and a folder name.

## Solution

Every Map Image in the Workspace hub, and in the picker for a map already in the Workspace,
shows a small picture of the map itself beside its name.

Nothing is generated to make this work. A Map Image whose tiles are in the Workspace already
contains a whole-sheet derivative — the single tile at the coarsest level of its pyramid, which is
what a level-0 pyramid ends in by construction. That tile is the picture. A Map Image that is
referenced from a Library has the equivalent single tile on the Library's own server, and this app
already establishes at add time that the Library will serve it. So a scholar sees pictures for every
map they already have, with no re-ingest, no download, and no bytes added to their Workspace.

A map whose picture cannot be resolved or fetched — a scholar working offline, a Library that has
gone away, a record that will not parse — shows a neutral glyph in the same box, so the list keeps its
shape and nothing claims to have failed.

## User Stories

1. As a scholar, I want to see a picture of each Map Image on my Workspace hub, so that I can
   tell my maps apart without opening a Project.
2. As a scholar, I want to recognise a Map Image whose label is missing by its picture, so that a
   random folder name is not the only thing identifying it.
3. As a scholar, I want to see a picture of each Map Image in the picker for maps I already have,
   so that adding the right sheet to a new Project does not depend on remembering a filename.
4. As a scholar, I want the picture to keep the sheet's proportions, so that I can recognise a tall
   folio or a wide panoramic sheet by its shape.
5. As a scholar, I never want the picture cropped to fill its box, so that a map's outline remains the
   thing I am recognising.
6. As a scholar, I want the picture never enlarged beyond the detail it actually has, so that no map
   looks blurred or degraded.
7. As a scholar, I want the cards to stay put while pictures arrive, so that clicking Delete on the
   right map does not become a moving target.
8. As a scholar, I want a Map Image with no available picture to keep a card of the same shape, so
   that the list stays a list rather than becoming ragged.
9. As a scholar, I want a Map Image referenced from a Library to show a picture drawn from that
   Library, so that referencing a map costs me nothing in storage and still shows me what it is.
10. As a scholar, I want a referenced Map Image's picture to cost one small request rather than a
    download of the whole sheet, so that browsing my own Workspace does not pull megabytes.
11. As a scholar working offline, I want my Workspace's own maps to still show pictures, so that the
    maps whose tiles I hold do not become anonymous when I have no network.
12. As a scholar working offline, I want referenced maps to show a neutral glyph rather than an error,
    so that being on a train is a normal state rather than a fault.
13. As a scholar, I want a Map Image I have made an Offline Copy of to show a picture from my own
    Workspace, so that the copy really has removed my dependence on the Library.
14. As a scholar, I want that switch to happen by itself when the copy completes, so that I do not have
    to do anything to make it take effect.
15. As a scholar, I want a Map Image I add from a file on my computer to have a picture as soon as
    it appears, so that adding a map involves no second wait.
16. As a scholar, I want no extra files written into my Workspace for this, so that the ~1 GB
    published-site budget is spent on maps rather than on pictures of maps.
17. As a scholar, I want the maps already in my Workspace to gain pictures with no action from me, so
    that I am not asked to re-add work I have already done.
18. As a scholar with many Map Images, I want the hub to open as promptly as it does now, so that
    the pictures are an addition rather than a cost.
19. As a scholar, I want requests to a Library limited to the maps I can actually see, so that opening
    my Workspace does not fire a request for every referenced map at once.
20. As a scholar, I want to notice that I have added the same sheet twice, so that I can delete the
    duplicate before I build Projects on both.
21. As a scholar deciding what to delete to save space, I want to see what each expensive Map
    Image actually is, so that the decision is about content rather than about megabytes.
22. As a scholar, I want the existing size, tile location, and "used by" facts to remain exactly as they
    are, so that the picture adds information without displacing any.
23. As a scholar, I want Delete to go on working unchanged, including its refusal when a map is in use,
    so that a visual change has not altered what the buttons do.
24. As a scholar whose `remote.json` will not parse, I want the map still listed with a neutral glyph,
    so that a damaged record leaves me able to see and delete the map.
25. As a scholar, I want a Map Image with an incomplete pyramid to stay invisible as it is today,
    so that a half-finished ingest does not start appearing as a broken picture.
26. As a scholar reviewing a Project someone sent me, I want its Map Images to show pictures in
    the Review Workspace, so that I can see what I have been sent before reading it.
27. As a scholar using a screen reader, I do not want to hear each map's name read twice, so that the
    picture adds nothing to announce beyond the label already beside it.
28. As a scholar using a keyboard, I do not want to tab through a picture per map, so that reaching
    Delete or the picker's action takes the same number of keystrokes as before.
29. As a scholar, I do not want the picture to be clickable, so that nothing invites a click that leads
    nowhere.
30. As a scholar, I want the glyph shown while a picture is still arriving to be the same glyph shown
    when there is none, so that the list does not flicker through a loading state for a read that takes
    milliseconds.
31. As a scholar whose Library has gone away, I want a neutral glyph rather than a broken-image icon, so
    that link rot looks like an absence rather than like a bug in the tool.
32. As a scholar who has stamped a canonical URL onto my Workspace for citation, I want the hub to keep
    showing pictures from my own files, so that preparing to publish has not made my editor depend on
    the published site being live.
33. As a scholar, I want the picture to come from the map I am looking at, so that I can trust the list
    absolutely — a plausible picture of the wrong map would be worse than no picture.
34. As a reader of a Published Site, I want nothing about it to change, so that publishing continues to
    produce exactly what it produced before.

## Implementation Decisions

Recorded in full, with the reasoning, in
`docs/adr/0030-a-map-images-thumbnail-is-its-coarsest-pyramid-tile.md`. The decisions that bind
implementation:

**The thumbnail is the coarsest single tile of the pyramid, and nothing is generated.** A level-0
pyramid's scale factors double until the whole image fits inside one tile, so its coarsest level is
always a whole-sheet derivative of at most 256 × 256. The function that computes that tile's URL
already exists, because it is what a Presentation Manifest's painting body points at. No
`thumbnail.jpg` is written, no ingest step is added, and there is no before-and-after population of
maps.

**One derivation covers both tile locations.** The URL is computed from the map's pixel dimensions and
its square tile side, for a Workspace-held map and a referenced one alike. The alternative — reading
the URL out of the stored Manifest for local maps — was rejected because a referenced map has no
Manifest of ours, so it could never be made uniform.

**`remote.json` gains the service's tile side**, which is the one input a referenced map lacked. It is
available at add time on the accepted remote image service and was previously discarded.

```
ReferencedImage gains:
  readonly tileSize: number    // the service's declared square tile side; 0 when unrecorded
```

It is read with the same tolerant helper as `width` and `height`, so a malformed value becomes 0
rather than a refusal. Losing it costs a picture; only a bad service URI costs the map.

**Every accepted referenced map is guaranteed to have a servable whole-image tile.** The image-pane
constructor requires the coarsest level to reduce the sheet to one tile, a service that declares no
such level has one synthesised, and the add-time probe fetches that exact tile before the resource is
accepted. So this leans on an invariant already established rather than on a compliance-level
assumption.

**Resolution happens in the domain layer**, inside the function that lists the Workspace's Map
Images, and the URL is carried on the listing type beside `label`, `bytes`, `tiles`, and `usedBy`. This
costs one additional small read per Workspace-held map, in a scan that already reads one per map. IIIF
knowledge stays out of the view layer, and the resolver stays testable with no browser.

```
WorkspaceMapImage gains:
  readonly thumbnail: string | null    // null when the geometry needed is unavailable
```

**A bare URL and not a discriminated union.** How the URL must be delivered is decided by the existing
`tiles: TileLocation` field on the same record — a second discriminator would be a second record of one
fact.

**The URL's base for a Workspace-held map is always the placeholder image service id, never the `id`
field of the stored `info.json`.** After an opt-in canonical stamp that field holds the *published*
address, so building on it would send the editor to the internet for pictures of files it is holding —
working or broken according to whether the site happens to be live. Only geometry is taken from the
document.

**Delivery differs by tile location, and one component owns the difference.** A Workspace-held map's
bytes are reached through the existing injection shim — the response's `ok` is checked before an object
URL is created, because a missing tile answers with a non-ok response whose body would otherwise become
a broken object URL. The object URL is created on mount and revoked on unmount. A referenced map's URL
goes straight into the element with `loading="lazy"`.

**Laziness applies to referenced maps only, and that asymmetry is deliberate.** For a Workspace-held
map the bytes are already read by the time an object URL exists, so deferring the element buys nothing;
real laziness would mean an intersection observer around the store read, which is machinery for a
Workspace size nobody has. For a referenced map the attribute is free and keeps requests to what is on
screen.

**A map with both an `info.json` of ours and a `remote.json` uses the Workspace-held tile.** The
thumbnail follows `tileLocation`, so completing an Offline Copy switches the source with no code that
knows it happened, and the citation the record exists to protect is untouched.

**Missing geometry yields no URL, never a guessed one.** Defaulting the tile side to the local
pyramid's 256 would be right often enough to be dangerous: a service on 512-pixel tiles would produce a
URL at the wrong scale factor and a broken box rather than an honest blank.

**Presentation.** A leading fixed box of about 96 pixels in the existing card row, `object-contain`
against the card background, explicit width and height attributes so cards do not shift as pictures
resolve at wildly different times. Empty `alt`: the map's name is immediately adjacent and no useful
alternative text exists for a picture of a map. A Lucide map glyph occupies the box from the first
frame and is replaced when an image decodes, so loading, absent, and failed are one visual with no
state machine. The picture is not interactive.

**One component, used by the hub and by the picker.** The picker already filters the same listing
records, so it needs no new data.

**No service worker.** Serving the store at a virtual path would make `<img src>` work directly and is
refused by ADR-0011 over File System Access permission semantics in a worker. This is the wall an
implementer hits first and the wrong way through it.

**No second path resolver.** Nothing outside the injection layer builds a store path for a tile.

**No migration and no format version bump.** The application has never been deployed. A referenced map
recorded before `tileSize` existed shows the glyph; re-adding it is the whole remedy and no affordance
is built for it.

## Testing Decisions

**A good test here asserts a decoded picture, not a present element.** This feature's failure modes are
all silent and all plausible: a wrong scale factor renders as "no picture", a mis-rooted path renders as
*somebody else's map* at a believable size. An `<img>` that 404s is visible and laid out at its
attribute dimensions, so a visibility assertion passes over an empty box. `naturalWidth` is the
assertion that can go red, and there is no precedent for it in the suite — it will not be copied from a
neighbouring spec.

**No test may reach the network.** Already enforced mechanically on both sides: the domain package's
setup refuses fetch, XHR, WebSocket, EventSource, `sendBeacon`, and Node's HTTP modules; end-to-end
specs must take their `test` from the composed network fence, which a lint check verifies. The remedy
for anything wanting the network is a committed fixture, never a stubbed global.

**Two seams, both existing, and no third.** The resolver in the domain package's Node project; the
rendering in the browser suite. No component-test runner is introduced for the thumbnail component,
even though the domain package has a browser project for the tiler.

**The domain package, against an in-memory store** — the resolver's four outcomes: a Workspace-held
pyramid yields its coarsest tile URL on the placeholder host; a referenced record with a tile side
yields the Library URL; absent geometry yields nothing; **both files present yields the Workspace-held
URL**. This is string building with no fetch, so the network question does not arise.

**The browser suite** — that a picture actually decodes for a map ingested from a file; that it decodes
for a referenced map served by the fixture Library; that the glyph stands in where no picture resolves;
and that completing an Offline Copy moves the source from the Library to the Workspace.

**The fixture needs no extension.** The fixture Library already parses the full
`{region}/{size}/0/default.jpg` form — four numbers then two — and answers it with a generated gradient
image at exactly the requested size, which is real decodable bytes. It was built to be exact because
the CORS probe refuses a tile whose decoded dimensions are not what was asked for.

**Three ways these assertions go vacuous, each with precedent in this tracker:**

- A visibility assertion passes for a broken image. Only `naturalWidth` distinguishes them.
- Asserting the `src` attribute equals a computed string compares the computation with itself — the
  shape that made an earlier epic's byte-identity claim compare a file with itself.
- `loading="lazy"` will hang a referenced-map assertion whose card sits below the fold: the request
  never fires, so the test waits on an image the browser has declined to fetch. The card being in the
  viewport must be deliberate rather than incidental to the window size.

**Mutation record, mandatory.** Break the scale-factor arithmetic and confirm the browser test goes red
— it will only do so if `naturalWidth` is asserted, which is what makes this the mutation worth naming.
Stop writing the tile side into `remote.json` and confirm the referenced picture becomes the glyph
rather than a broken box.

**Two existing tests change because their subjects change**: the one asserting `remote.json`'s exact
serialised text, and the one asserting the exact set of paths the Workspace scan reads. **Assumed, and
open to correction**: both are *extended* to cover the new field and the new read rather than merely
repaired, because loosening an exactness assertion to make it pass would silently discard the coverage
it was written for.

**Prior art.** The whole-image derivative's arithmetic and its agreement with what the pyramid contains
are already asserted in the tiler's pyramid tests. The Workspace listing is already tested against an
in-memory store, including an assertion on exactly which paths it reads. Referenced-map flows are
already driven end-to-end against the fixture Library hosts. Waiting for an ingest to finish before
asserting on a pyramid already has a helper that polls for a completed one.

## Out of Scope

- **The Published Site.** Its hub lists Projects and never Map Images, so there is no surface to
  put pictures on. Nothing published changes.
- **The Layer sidebar inside a Project.** It lists Layers, and whether a Layer wants a picture is a
  different question about a different concept.
- **Closing ADR-0028's residual.** The hub becomes the one surface that could cheaply detect a damaged
  Workspace-held pyramid, because the coarsest tile is a cell the tiler is known to have written, unlike
  the grid cells a healthy pyramid 404s on every load. It deliberately does not report it; the
  observation is recorded in ADR-0030 for whoever closes that gap.
- **Distinguishing "still loading" from "not available".** One glyph covers both, accepted knowingly.
- **A dedicated thumbnail file, at any size.**
- **Redesigning the hub's map list into a gallery grid.** The picture joins the existing card row.
- **Backfilling a tile side onto referenced records that predate it.** Greenfield; re-adding is the
  remedy.
- **The observation that a canonical stamp rewrites `info.json` only, leaving a published
  `manifest.json` advertising a painting body on the placeholder host.** Found while grilling this
  feature, unrelated to it, and left alone.
- **Content-addressing local images so duplicates deduplicate.** Story 20 makes duplication *visible*;
  preventing it is ADR-0023's separately deferred decision.

## Further Notes

**The picture's size varies, by roughly a factor of two, and that is inherent.** The coarsest level is
the first power-of-two reduction that fits in a tile, so the derivative lands anywhere between about
129 and 256 pixels on its dominant axis: a 1200 × 851 sheet yields 150 × 107. The 96-pixel box is chosen
to sit under the worst case so nothing is ever upscaled. Extreme aspect ratios stay honest rather than
becoming wrong — a 20000 × 1000 panoramic sheet reduces to a legitimate sliver, letterboxed.

**`CONTEXT.md` is deliberately unchanged.** A thumbnail has no user-facing word: it is a silent picture
with an empty `alt`, and nothing in the product ever says "thumbnail" to a scholar. The glossary earns
its keep by policing words that appear in both the code and the product's language — which is why
"Offline Copy" exists — and there is no such divergence to prevent here. It is also a role rather than a
new artifact: the bytes already exist and already have a name.

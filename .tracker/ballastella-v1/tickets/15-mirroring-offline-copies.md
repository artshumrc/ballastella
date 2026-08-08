# 15 — Mirroring: "make an offline copy"

## What to build

A per-image action that copies a referenced remote Historical Map into the Project as local tiles, so the work survives the host reorganising or disappearing, works offline, and can be published as a genuinely self-contained site.

The user sees the source's rights statement at the moment they choose to copy, and is warned when copying will be expensive for the host.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 27 and 28. With ticket 16: 15 — the warning lands here, where a workspace actually grows, and again at publish. Sets `imageMode: 'mirrored'`, which is what stories 29, 88, and 90 read. Mirroring is also what makes story 8 (fully offline) true for a Project sourced remotely.

## Where to start

[ADR-0007](../../../docs/adr/0007-remote-iiif-is-referenced-by-default-copied-on-request.md) (the whole slice), [ADR-0003](../../../docs/adr/0003-every-image-is-tiled-client-side.md) (the tiler this reuses), [ADR-0002](../../../docs/adr/0002-display-state-separate-from-portable-documents.md) (`imageMode` on the Layer).

The tiler is ticket 05, remote ingest is ticket 14, the injection shim is ticket 06.

## Contract

**Mirroring reuses ticket 05's contract exactly: `ImageSource → level-0 pyramid in the ProjectStore`.** The output must be indistinguishable from a locally ingested image, so nothing downstream needs to know how a pyramid arrived. This is why the ticket is cheap.

**Cost depends on the source's compliance level, and the two paths are genuinely different:**

| Source | Path |
|---|---|
| **level 2** | Request `/full/max/0/default.jpg` — **one** request — then feed the existing tiler. The local-image path reused exactly. |
| **level 0** | Only pre-cut tiles exist, so mirroring means pulling its **entire pyramid**: potentially thousands of requests against someone else's server. |

**Warn explicitly on the level-0 case**, naming that it means many requests to the host. This is a politeness obligation, not a performance note.

Note the interaction with ticket 05's decode ceiling: a level-2 `full/max` response may exceed it, in which case the streaming tiler applies as normal. ~~*(As built, and since [ADR-0027](../../../docs/adr/0027-no-streaming-tiler-in-v1.md): there is no streaming tiler, and a source above the cap is refused before anything is fetched — see the criterion below.)*~~ Also respect `maxWidth`, `maxHeight`, and `maxArea` from the parsed profile — `full/max` may be capped by the server, and requesting beyond the cap yields an error rather than a bigger image.

**Surface the manifest's `rights` and `requiredStatement` at the moment the user chooses to copy** (ADR-0007). Copying someone else's images is per-collection acceptable, not universally so, and the decision must not be made implicitly by a button labelled only "Download."

**State the size the copy will add, against the workspace's current size, before it starts.** Mirroring is the only action in the app that grows a workspace by hundreds of megabytes in one gesture, so it is where the ~1 GB static-hosting cliff (ADR-0008) is actually approached — ticket 16's publish-time warning arrives after the fact. Use ticket 02's `ProjectStore#size`; the copy's size is estimable from the parsed profile's dimensions. If the copy would take the workspace past the cliff, say so plainly and let the user proceed anyway — this is information, not a gate.

**Update `imageMode` from `'referenced'` to `'mirrored'`** on the Layer (ticket 09's union). This is not bookkeeping — it changes what publishing means (ticket 16), and a referenced image makes a Published Site network-dependent.

The mirrored pyramid gets the placeholder `id` — `https://unset.invalid/<image-id>` — exactly as a local image does (ADR-0004), so the injection shim from ticket 06 resolves it with no special case. **The `image-id` does not change**: it remains `generateId(uri)` from ticket 14, so the link to the canonical source and the Allmaps community lookup survive mirroring.

Record the source URI in the Project so a mirrored image can still be cited and traced back. Mirroring must not orphan the copy.

Mirroring is a long job with progress and must be **cancellable**, leaving no half-written pyramid behind — a partial pyramid renders with holes, which looks like corruption.

Reversing is out of scope, but the Layer must not be left inconsistent if mirroring fails: on failure it stays `'referenced'` and keeps working.

## Out of scope

- **Mirroring by default.** Referencing is the default and this is opt-in per image (ADR-0007).
- **Un-mirroring** — dropping local tiles to go back to referencing. Plausible later.
- **Bulk mirroring** of every image in a Project or Collection. One image at a time — partly to keep the host-load decision explicit.
- **Publishing behaviour** — ticket 16 reads `imageMode`; this ticket only sets it.
- **Rights enforcement.** Show the statement; the scholar decides. Do not block based on parsed rights.
- **A `sharp` CLI for oversized sources.** Prose in the docs (ADR-0003).

## Acceptance criteria

- [x] "Make an offline copy" is available per image on a referenced Layer
- [x] Mirroring a **level 2** source issues a single `full/max` request and then tiles locally
- [x] Mirroring a **level 0** source fetches its existing tiles and warns beforehand that this means many requests to the host
- [x] `rights` and `requiredStatement` from the manifest are shown before the copy begins
- [x] The estimated size of the copy and the workspace's current size are both shown before the copy begins, and a copy that would cross ~1 GB warns explicitly while still allowing the user to proceed
- [x] The workspace size is obtained via `ProjectStore#size` and **not** by reading tile bytes — asserted with a spy on `read`
- [x] The resulting pyramid is structurally identical to a locally ingested one: same paths, same tile geometry, same square tiles, `id` set to the `unset.invalid` placeholder
- [x] The `image-id` is unchanged by mirroring, and remains `generateId(uri)`
- [x] The source URI is recorded and still visible after mirroring
- [x] The Layer's `imageMode` becomes `'mirrored'`
- [x] The mirrored image renders through the injection shim with **no** network requests to the original host
- [x] A source whose `full/max` exceeds the decode ceiling is **refused before anything is fetched**, and the dialog says so — asserted in `mirror.test.ts` on both paths against an injected cap, and end to end in `editor-mirroring.e2e.ts` with the Copy button disabled and zero tile requests made. **Was `[~]`, and closed by [workspace-and-layers ticket 19](../../workspace-and-layers/tickets/19-drop-libvips-for-v1.md) on 2026-08-07.** It read: *routes to the streaming tiler … not asserted end to end, because on a static host that tiler cannot run at all*. There is no streaming tiler to route to now ([ADR-0027](../../../docs/adr/0027-no-streaming-tiler-in-v1.md)), and the honest behaviour turned out to be the one the `[~]` was hedging about: a copy has to exist as one full-resolution image before it can be re-cut, on either path, so both inherit the cap and neither had anywhere to escape to. Refusing in the plan rather than in the tiler is what keeps thousands of requests off somebody else's server.
- [x] A capped `maxWidth`/`maxArea` profile is respected rather than producing a failed oversized request
- [x] Cancelling mid-mirror leaves no partial pyramid, and the Layer remains `'referenced'` and functional
- [x] A failed mirror leaves the Layer `'referenced'` and still rendering
- [x] Progress is reported and announced to assistive technology

```bash
pnpm --filter @ballastella/core test    # level-2 vs level-0 path selection, profile caps, id stability
pnpm test:e2e                    # rights shown, level-0 warning, cancel cleanliness, offline render
pnpm -r build && pnpm lint && pnpm check

# after mirroring: zero requests to the original host (assert via request interception)
```

Success: all exit 0, and the post-mirror test asserts by request interception that **no** request reaches the original host — that is the entire point of mirroring and the only proof that the copy is actually being used.

## Blocked by

- Ticket 05
- Ticket 14

## What was built, and the decisions that were not in the ticket

**Mirroring is a funnel into `ingestImageFile`, not a second tiler.** Both paths end with one
full-resolution image handed to ticket 05's job, which is why the output is not merely shaped like a
locally ingested pyramid: `mirror.browser.test.ts` asserts it is **byte-identical**, tile for tile, to
what `ingestImageFile` writes for the same source, in Chromium and Firefox. `ingest.ts` gained one
optional field, `imageId`, supplied by exactly one caller — mirroring, where the id must not change.

**`ImageMode` did not need a third member.** Ticket 09 already declares it as
`'mirrored' | 'referenced'` with `LOCAL_COPY = 'mirrored'`, so mirroring moves an image between two
values that already exist and ticket 14's deliberate compile error (`_everyImageModeHasASource`) never
fired. The transition is asserted in three places: `referenced-image.test.ts` (`tileBaseFor` stops
being a URL and becomes `{ storedImageId }`), `mirror.test.ts` (the pyramid lands under
`generateId(uri)` with the `unset.invalid` id), and `editor-mirroring.e2e.ts` (`project.json` reads
`imageMode: 'mirrored'`, and the copy draws with nothing reaching the library).

**The path is not chosen on compliance level, and measurement is why.** All fourteen services in ticket
14's captured corpus report `supportsAnyRegionAndSize`, so "is this level 0" would send every real
service down the one-request path — including **two that cannot serve it**: Cambridge Digital Library
declares `maxWidth`/`maxHeight` 2000 over a 4880×6174 image, and Micrio (Rijksmuseum) declares
`maxArea` 17 550 000 over 27.7 megapixels. The condition is therefore "will this service serve the whole
image in one request", which is `supportsAnyRegionAndSize` **and** the declared caps. The corpus also
has **no genuinely level-0 member**, so the level-0 fixtures are this app's own generated `info.json` —
which is exactly what a level-0 service in the wild is.

**The stored Alignment is rewritten, and this was not in the ticket.** A referenced image's Alignment
names the remote service as its `resource.id` (ticket 14), which is what made it resolvable by Allmaps
and what made the warped Layer render. Left alone after a copy it keeps sending `@allmaps/maplibre` to
the library for tiles that are now in the folder — so the copy would work, the map would draw, and
mirroring would have bought nothing. It is rewritten to the ADR-0004 placeholder through
`serialiseAlignment`, and the Control Points are asserted to survive.

**`remote.json` is deliberately kept**, so a copy can still be cited (ADR-0007). That makes
`listIngestedImages` and `listReferencedImages` no longer disjoint, which ticket 14's comment claimed
they were; `partitionByLocalCopy` is the one place that answers "referenced or copied?" and it answers
it from **whether the pyramid is there**, not from what a Layer claims — so a copy whose pyramid landed
and whose document write did not repairs itself on the next attempt rather than fetching from a library
forever.

**The hosting total reads no file contents.** `workspaceSize` is `list` + `size`, with a spy on `read`
asserting it, and it sweeps abandoned writes first: ticket 12's review found that `list` hides anything
matching the reserved suffix — including Chromium's `.crswap` — so a total built from `list` alone would
silently under-report what is on disk, which is the worst possible property for the one number a user
reads before a copy that may cross the cliff. `ESTIMATED_MIRROR_BYTES_PER_PIXEL` is 0.7, measured at
0.563 on the committed 1200×851 pyramid and set deliberately above it: an estimate that came in under
the truth is the one that lets someone walk off the cliff unwarned.

## Follow-ups and defects found

1. **Two defects in the Layers pane, neither caused by this ticket, both found by trying to measure the
   same thing twice.** Recorded in `drawTheStack`'s comment in `e2e/editor-mirroring.e2e.ts`.
   - A **client-side navigation** to `/layers` leaves the stack undrawn — `window.ballastellaLayerStack`
     is never set at all — whenever the Project page had a local Historical Map on it. Reproduced with a
     plain ingested PNG and no remote IIIF anywhere. Every existing test of that pane uses `page.goto`,
     which is why it has not been seen.
   - A **fresh page load** of `/layers` draws a `'referenced'` Layer with `service: ''`: the stack is
     built before `remote.json` has been read, so the Layer asks the injection shim for a pyramid the
     Project does not contain and renders blank, and the redraw when the record arrives does not happen.
     `editor-remote-iiif.e2e.ts` asserts that render through the *link* route, so it passes.

   Together these mean the mirroring e2e must use the link route for the referenced control and the load
   route for the copied claim. Both belong to whoever owns the layers pane.

2. **Upstream, `@allmaps/iiif-parser@1.0.0-beta.48`: `Image#getImageUrl` cannot express "the whole
   image".** `getImageUrl({})` emits `full/full` regardless of `majorVersion`, and `size=full` was
   **removed** in Image API 3 — so for a version 3 service it builds a URL a strict server answers 400
   to. Passing the string forms produces
   `undefined,undefined,undefined,undefined/NaN,NaN/0/default.jpg`. `wholeImageUrl` in `mirror.ts`
   builds it directly and branches on `majorVersion`. (Its cap validation is right, though: it throws
   `Width of requested image is too large: 4880 > 2000` for Cambridge rather than building the URL.)

3. **Ticket 05's per-row profile statistic does not transfer to a large level, and this is worth knowing
   before it is reused.** Asserting exact-resize by comparing each output row's mean brightness against
   the source band it would be drawn from prefers the **wrong** hypothesis for a scale-factor-4 tile of
   the 1200-wide fixture (measured: 39.0 for IIIF against 30.4 for resize-and-pad). Over 213 output rows
   each engine's constant sub-pixel sampling offset — ticket 05 measures −0.12 output pixels in Chromium
   — is larger than the 0-to-1 source row the two hypotheses differ by. The **extent** statistic is an
   integral and cannot be biased that way, so `mirror.browser.test.ts` uses that one. Ticket 05's own use
   of the profile statistic is against a different pair of images and passes; the point is that it is
   offset-sensitive and should not be copied to a new case without checking.

4. **The `assembled` path holds the whole source in one image, so it inherits the decode ceiling rather
   than escaping it** — the streaming tiler is no help, because there is no file to stream from until the
   pieces are stitched. Refused up front above 2²⁸ pixels with a message naming the number. *(Since
   [ADR-0027](../../../docs/adr/0027-no-streaming-tiler-in-v1.md): the number is 528,006,700, the
   refusal covers `full-max` as well, and there is no streaming tiler for it to be no help.)* ADR-0003 also
   records that WebKit's *canvas area* limit can be as low as 5 242 880 pixels, which the decode-and-crop
   tiler avoids by never making a canvas larger than one tile and which this path cannot avoid: a large
   level-0 copy may therefore fail on Safari well below the stated bound. Unmeasured, like WebKit's
   decode ceiling.

5. **Un-mirroring and bulk mirroring remain out of scope**, as the ticket says. Worth noting that
   un-mirroring is now cheap to add: `remote.json` is still there, so it is "delete the pyramid, flip
   `imageMode`, rewrite the Alignment with the service".

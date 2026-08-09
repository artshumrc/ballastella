# What a refused Historical Map tile reports, and what it deliberately does not

A Historical Map's tiles can stop being fetchable while somebody is looking at the map. The injection
layer (`createStoreImageFetch`, [ADR-0011](./0011-store-backed-tiles-through-documented-extension-points.md))
catches that refusal and hands the application a sentence to render. This ADR records which refusals
it reports, which it stays quiet about, when the sentence is withdrawn, and the residual that policy
leaves open — because the last of those is a hole in a product whose stated promise is that nothing
fails silently.

Everything below was measured in `e2e/viewer-reader.e2e.ts` and
`packages/core/src/injection/store-image-fetch.test.ts`. Where a claim rests on a number, the number
is here rather than in a commit message.

## A missing `info.json` is reported. A missing tile cell is not.

`@allmaps/iiif-parser` derives its own tile grid from the `info.json` and asks for cells the tiler
never planned, so **a complete, healthy pyramid answers 404 to some of the requests made against it
on every single load**. The suite has always known this from the other side: the "no 404 for anything
the page asked for" assertion in `viewer-reader.e2e.ts` has to exclude `/default.jpg`.

Reporting those would put a permanent "this map stopped drawing" over a map that is drawing
perfectly, which is the one thing a warning cannot survive. So a 404 for a tile cell reports nothing.

A 404 for the pyramid's own `info.json` **is** reported: without it there is no map at all, and that
is a site published incomplete rather than a ragged edge.

## ⚠ The residual this leaves, stated plainly

**A Published Site that carries its `info.json` but is missing some of its tile files draws a map
with holes in it and says nothing.** The `file-missing` sentence is reachable only when the whole
`info.json` is absent.

This is a real gap in "nothing fails silently" and it is not closed here. It is recorded rather than
solved because the two failures are genuinely indistinguishable at this seam — a cell the tiler never
wrote and a cell that failed to upload are the same 404 for the same URL — and telling them apart
needs something the pyramid does not currently carry, such as a manifest of the cells that were
actually written. That is a change to what publishing emits, not to what the reader reports.

Anyone picking this up should start there, and should not "fix" it by reporting tile 404s: that was
the first design, and it is wrong for the reason in the section above.

## The notice is up exactly while some URL that was refused has not come back

A refusal is reported the moment it happens. An arrival is reported when the **last URL that was
refused** has come back — not when some other URL succeeds.

An earlier rule counted concurrent requests and withdrew the notice when a burst completed with no
refusal in it. That is sound while requests overlap and nonsense when they do not: requests issued
one at a time each formed their own burst, so three serial refusals interleaved with three serial
successes produced three withdrawals. `@allmaps/render` mostly fetches concurrently, but the tail of
a burst and a re-fetched `info.json` are serial, so the hole was reachable.

**That is measured by the suite** — `keeps a partial outage's notice up, concurrently and serially
alike`, driven against the old rule, reports `serial: expected [{ok:true},{ok:true},{ok:true}] to
deeply equal []`. ⚠ It was not, at first: the test built both promises in one array literal and chose
only when to *collect* them, so its "serial" pass drove the concurrent shape twice and passed against
the very rule it named. Three places said "Measured" about a measurement nothing performed. The test
issues the second request after the first has settled now.

Naming the URLs removes the question rather than answering it better. There is no burst and no
difference between the serial and concurrent cases, and a *partial* outage keeps its notice because
the cells it refuses stay outstanding however many others succeed.

**Two requests for the same URL are the one place order could still have decided it, and they are
handled explicitly.** `WarpedMap.loadImage` fills `imagesById` only after its fetch resolves, so two
Layers on one `imageId` — legal under [ADR-0023](./0023-historical-maps-and-alignments-live-in-the-workspace.md),
and supported by the viewer — both fetch that `info.json` at once. Mid-outage one can fail while the
other succeeds, and with the failure settling last a set keyed on URL alone recorded a refusal for
bytes the page was already holding: a notice that never came down over a map with nothing wrong with
it. A refusal is therefore dropped when a request for the same URL, issued before it settled, has
already come back.

**The consequence, which is the part worth knowing:** a refused URL that is never asked for again
keeps the notice up. That is deliberate — those bytes really are missing from the map — and it is why
the sentence has to name the gesture that fetches them.

## The two failures do not recover alike, and the sentence says so

Measured, both shapes, mid-session:

| what was refused | recovers with no gesture | after a zoom | after hiding and showing the Layer |
| --- | --- | --- | --- |
| the map's `info.json` | **yes** | — | — |
| a tile cell | no | **no** | **yes** |

`WebGL2Renderer.render` calls `loadMissingImagesInViewport()` on every frame, so a refused
`info.json` is re-asked for until it arrives and the map heals with the Reader doing nothing. A
refused tile cell is never re-asked: it is already in the renderer's tile cache as a failure, and a
zoom does not shift it. Only a rebuilt layer re-requests it.

The sentence therefore says *"When it is answering again the map picks up what it can by itself;
anything still missing comes back if you hide this Layer and show it again, or reload the page."*

⚠ It previously said *"The map finishes drawing on its own once the tiles start arriving again, so it
is worth checking your connection and waiting rather than reloading."* That was false for the
tile-cell half: a Reader who followed it waited in front of a warning that would never go, over a map
that would never finish. Both end-to-end tests drove recovery through a Layer redraw, which rebuilds
the renderer with an empty cache and makes **both** shapes recover — so the test passed either way
and the asymmetry was invisible to it. The two shapes now have a test each, and the one that heals
unattended asserts that no gesture happens.

## The sentence lives in the domain layer

One function, `historicalMapTilesUnavailableNotice`, rendered by the published viewer and by the
editor. The two deployments must be incapable of describing one outage two ways at the same person,
which is the same argument [ADR-0020](./0020-base-map-catalog-author-default-and-reader-switching.md)
made for the Base Map's unreachable-archive notice. It carries the same three things in the same
order, for the same reason — it is not you; your work is safe; here is what would fix it.

## This is not sufficient on its own

`@allmaps/stdlib`'s `fetchUrl` throws for any non-ok `Response`, so a refusal answered politely still
becomes an upstream `Error` raised after the injection layer has returned — and `WebGL2Renderer`
dropped the promises `loadMissingImagesInViewport()` returns, where upstream's three other renderers
all wrap the same call in `Promise.allSettled`. Catching at the boundary without that second fix
leaves the uncaught page error exactly where it was.

Both halves are in `patches/@allmaps__render@1.0.0-beta.83.patch`, and
`scripts/check-allmaps-patch.mjs` fails the build if either stops applying.

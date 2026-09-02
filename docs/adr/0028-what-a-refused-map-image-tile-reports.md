# What a refused Map Image tile reports, and what it deliberately does not

A Map Image's tiles can stop being fetchable while somebody is looking at the map. The injection
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
actually written. That is a change to what the site is built from, not to what the reader reports.

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
Layers on one `imageId` — legal under [ADR-0023](./0023-map-images-and-alignments-live-in-the-workspace.md),
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

### "On every frame" is a promise about frames, and a settled map paints none

The first row of that table was true only of a map that happened to still be moving. MapLibre paints
when something changes, and nothing here changed anything: no repaint was triggered when a refusal
was recorded, and nothing retried the refused record on a timer. So a Reader sitting still in front
of a settled map — the ordinary case, and precisely the one the sentence is addressed to — got no
frames, no re-request, and a notice that stayed up for ever. Recovery worked only when an unrelated
straggler repaint, the tail of the Base Map's tiles, happened to land after the bytes became
fetchable. Measured on the end-to-end test that asserts it: six runs took 6.1s, 15.5s, 15.6s, 16.2s,
27.5s and 41.7s against a 45-second budget, which is a coin toss written down — and the test was
reported failing outright, retry included, on 20 to 40 percent of runs.

`keepAskingForMissingTiles` (`packages/core/src/injection/tile-failure.ts`) supplies the frames:
while the notice is up, `ReaderMapPane` calls `triggerRepaint()` on a doubling schedule — a quarter
of a second, then a half, out to thirty — and then **stops**, eleven re-asks and 151,750ms (2m 32s)
in. Both figures are pinned in `tile-failure.test.ts`, straddled a millisecond either side of every
step, so neither this paragraph nor the schedule can drift without a red test.

It is a bounded retry rather than an animation loop on purpose: every frame is another request to
a server already known to be failing, and a Reader who leaves a broken site open in a tab must not go
on paying for it. Past the budget, the gesture the sentence already names is the remedy — and it is
the remedy for the tile-cell half in any case.

**The budget is eleven delivered frames, not 151,750ms of wall clock**, and the difference is a
Reader switching tabs during an outage — ordinary behaviour, and enough to defeat the whole fix if
the schedule ran on time alone. `triggerRepaint()` schedules through `requestAnimationFrame` and is
a no-op while a request is already outstanding, so in a hidden tab the timers would keep firing,
the first repaint would arm a frame that never runs, and the remaining ten would collapse into it:
one re-ask on return where this promises eleven, and if the server is still refusing at that instant
the notice can never come down without a gesture. So `keepAskingForMissingTiles` hands its caller a
`delivered` callback and arms the next wait only from that; `ReaderMapPane` reports it from
MapLibre's `render` event. A step that paints no frame parks with nothing pending — no polling, no
loop — and resumes when the tab does.

It is armed by *whether* something is missing, never by each refusal, because each of these frames
provokes a refusal of its own: re-arming on those would build the unbounded loop the budget exists to
avoid. The bound is asserted at Seam 1, in `tile-failure.test.ts`, since an end-to-end test cannot
tell a schedule that ends from one that does not.

⚠ It previously said *"The map finishes drawing on its own once the tiles start arriving again, so it
is worth checking your connection and waiting rather than reloading."* That was false for the
tile-cell half: a Reader who followed it waited in front of a warning that would never go, over a map
that would never finish. Both end-to-end tests drove recovery through a Layer redraw, which rebuilds
the renderer with an empty cache and makes **both** shapes recover — so the test passed either way
and the asymmetry was invisible to it. The two shapes now have a test each, and the one that heals
unattended asserts that no gesture happens.

## The sentence lives in the domain layer

One function, `mapImageTilesUnavailableNotice`, rendered by the published viewer and by the
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

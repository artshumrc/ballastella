# A Reader is told when the Base Map is missing

## What to build

The published viewer says so when the Base Map's archive answers nothing, instead of showing a blank rectangle. The editor already does this; the viewer does not, and the viewer is the one with no console anyone is watching.

Demonstrable end to end: a published site whose Base Map archive refuses answers a Reader with visible text saying it is not their fault, their work is safe, and what would fix it — and the Annotations and Map Images still draw over the empty geography.

## Why this is not a nice-to-have

`demo-bucket.protomaps.com` has refused the archive every entry in this deployment's catalog reads **since 2026-08-07**. ADR-0025 predicted exactly this ("no published rate limit, no uptime promise, and no terms of use"). So this is not a hypothetical failure mode — it is the current behaviour of every published site.

The application's whole response is a pane with nothing in it. A Reader cannot tell that from a broken tool, and there is a third possibility they also cannot rule out: that the author's work failed to draw.

`ReaderMapPane.svelte:29` already makes this argument against itself, about a different hazard:

> This pane matters more, not less: a Reader navigating between the Project view and a Map Image read unwarped crosses exactly that boundary, and **a Published Site has no console anyone is watching.**

## What already exists — use it, do not re-derive it

- **`baseMapUnavailableNotice(entry, host)`** in `packages/core/src/base-map/resolve.ts` writes the sentence. Read its header comment: the message carries three things in the order the questions arrive — **it is not you**, **your work is safe**, **here is what would fix it** — and `needsNetwork` decides the remedy, because a deployment-relative archive that does not answer is a broken deployment the Reader can do nothing about, while a remote one may be a host having a bad day. It is already tested.
- **`baseMapArchiveHost(entry)`** gives the host, or `null` for this deployment's own file. The notice takes a host rather than a URL deliberately.
- **The editor's markup**, `apps/editor/src/lib/project/ProjectScreen.svelte:1108`. Copy the decision, and copy the reasoning with it: `role="alert"` **not** `aria-live`, because the element is *inserted* when its text first exists and a live region is announced on a text change rather than on insertion — so a live region here is a notice a screen-reader user never hears.
- **The trigger** is MapLibre's source error. The editor's `BaseMapPane` listens for it; that listener is what ticket 20 added after an outage rendered as a grey rectangle.

## Where to start

- `apps/viewer/src/lib/ReaderMapPane.svelte` — the source-error listener and the notice.
- Wherever the viewer composes the pane, for where the notice belongs in the reading order.
- `e2e/viewer-reader.e2e.ts` — the new assertions. It already routes the archive to a fixture, so refusing it is a routing change, not a network dependency.

## Contract

**The same sentence in both deployments.** The wording is `baseMapUnavailableNotice`'s to decide, not the template's, so the editor and the viewer cannot drift into saying different things about the same failure. If you find yourself writing a second sentence, put it in core instead.

**The Reader's content still draws.** Annotations and Map Images must keep rendering over the missing geography — the notice explains an absence, it does not replace the map. Assert this, because a fix that blanks the pane on error would pass a naive "the notice appears" test.

**It is not the offline notice.** The connection is fine. Telling somebody with working wifi that they have none is a worse answer than saying nothing.

**Visible text, never a tooltip** (SPEC story 111, ADR-0016), and announced (story 112).

## Out of scope

- **Do not change the Base Map catalog or what it points at.** That is a product decision about hosting and terms, and it is not this ticket. This ticket makes the failure honest; it does not choose a different archive.
- **Do not touch open lead 2** (the viewer's `forceRedraw` teardown error). Different defect.
- **Do not add a retry or a fallback archive.** Saying what happened is the whole job here.

## Acceptance criteria

- [ ] A published site whose Base Map archive refuses shows the notice, in visible text, with the three things in `baseMapUnavailableNotice`'s stated order.
- [ ] The notice is announced to a screen reader — and the mechanism is the one the editor reasoned out (`role="alert"`, not a live region that is never heard because it was inserted with its text).
- [ ] Annotations and Map Images still draw while the notice is up. Asserted.
- [ ] The offline notice is not shown when the connection is fine.
- [ ] The editor and the viewer produce the **same sentence** for the same failure, from the same function. Asserted rather than eyeballed.
- [ ] No test depends on the network — the refusal is produced by routing, like every other archive assertion in this suite.
- [ ] The mutation check is recorded per criterion: break the behaviour, watch the test go red, restore, and say what you broke.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm exec playwright test e2e/viewer-reader.e2e.ts
pnpm test:e2e
```

Never pass `--reporter=` on the command line; do not pipe gate output through `grep`; read exit codes.

## Blocked by

Nothing. This is viewer-only and independent of 07, 15 and 21.

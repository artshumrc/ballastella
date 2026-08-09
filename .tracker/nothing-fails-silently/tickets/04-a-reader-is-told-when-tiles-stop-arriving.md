# A Reader is told when a Historical Map's tiles stop arriving

## What to build

Stop the render seam throwing an uncaught error when a Historical Map's tiles cannot be fetched, and tell the Reader instead. A published site is the deployment with no console anyone is watching, so an error that only reaches the console reaches nobody.

## What is already known — do not re-derive it

**Measured 3 failures in 8 runs (37%), and 3 in 8 at the commit before the work that found it** — so it is pre-existing and it is not machine contention.

The mechanism: `@allmaps/render`'s `loadImage` asks for the Historical Map's `info.json` when tiles are needed, and the store's `SiteFileUnreachableError` **escapes it uncaught**, arriving as a `pageerror`. Nothing a Reader sees changes today, which is why it went unnoticed — the viewer's own "no uncaught page error on any navigation" assertion is what surfaced it.

`e2e/viewer-reader.e2e.ts` currently carries a **deliberate, narrow exception** for exactly this one message in one test, with the measurement written beside it. **Removing that exception is part of this ticket's proof**: once the error is caught, the exception is no longer needed, and the test that asserts nothing is thrown should pass without it.

## Where to start

- `packages/core/src/injection/store-image-fetch.ts` — `createStoreImageFetch` returns the `FetchFn` the render layer is handed. This is the boundary that owns the failure: the module that supplies the fetch is the module that decides what a refusal becomes.
- `packages/core/src/store/http-project-store.ts` — `SiteFileUnreachableError`, which already carries the host and the status. **It has two message forms** — one for `status === 0` (no answer) and one naming a status — and the remedies differ. Branch on the facts, not on which app is asking.
- `packages/core/src/render/warped-map-layer.ts` and `render/stack-layers.ts` — where the `FetchFn` reaches `WarpedMapLayer`. Read `warped-map-layer.ts`'s header comments first: they document a real patched behaviour in `@allmaps/render` and an ADR-0011 shim, and they are load-bearing.
- **The sentence goes beside `baseMapUnavailableNotice` in `packages/core/src/base-map/resolve.ts`** — or in a sibling module if that file is the wrong home for a Historical Map's failure. Read that function's header: three things in the order the questions arrive, and unit tests that drive every row plus one asserting no row overclaims.
- `apps/viewer/src/routes/+page.svelte` and `apps/viewer/src/lib/ReaderMapPane.svelte` — the viewer's notice regions and the `role="alert"` pattern already used there.
- `e2e/viewer-reader.e2e.ts` — the fixture idiom: an archive routed to a committed file and then refused, including one that answers a header and then stops. That is how a mid-session failure is driven without a network.

## Contract

**The refusal is caught at the injection boundary.** It does not escape into third-party code that will not catch it. The app decides what to say; the render layer is not asked to.

**The sentence lives in the domain layer and is shared.** Ticket 05 renders the same sentence in the editor. The two deployments must be incapable of saying different things about the same failure — that is why it is one function and not two templates.

**Three remedies, told apart:** the connection is gone; the site is missing a file; a Library's server is failing. The Reader is told which, because reconnecting helps in one case and not the others.

**Partial success keeps what arrived.** Tiles already drawn stay drawn. The failure is additive information, not a reset. **Assert this** — a fix that blanks the map on error would pass a naive "the notice appears" test.

**It withdraws itself.** When tiles start arriving again the message goes. Note the shape found in the previous epic: a one-way flag leaves an alert sitting over a working map. Note also, from the same work, that a *header* refusal is cached page-wide by `pmtiles` while tile **data** ranges are not — so what recovers and what does not is not uniform, and any claim about it should be measured rather than reasoned.

**Visible text, never a tooltip.** Announced — using the mechanism the repo has settled on (`role="alert"` for text inserted when it first exists; a permanently-mounted live region for text that changes).

**The uncaught-error assertion stays and gets stronger.** It is the mechanism that found this. Any surviving exception must be narrow, measured, and stated.

## Out of scope

- **The `forceRedraw` teardown defect.** Root-caused, and recorded as a note in `triiiceratops`' own repository — it is a first-party upstream fix plus a version bump here. Do not patch it, do not chase it, and **do not read its absence from a run as evidence about it**.
- **The Base Map's unreachable-archive notice.** Already delivered in both deployments. This is Historical Map tiles — a different failure with a different remedy. Do not merge the two sentences.
- **Changing the Base Map catalog.** Settled: the demo tiles stay. Do not raise it.
- **Making Historical Map tiles available offline.** Telling the Reader is this ticket; changing what is fetchable is not.
- **The editor.** Ticket 05.
- **The write path.** Tickets 01–03.

## Acceptance criteria

- [ ] With a Historical Map's tiles refused mid-session, the published viewer shows a sentence in visible text saying it is not the Reader's doing, that the Annotations and the author's work are unaffected, and what would help.
- [ ] **No uncaught `pageerror` occurs** on that path — and the deliberate exception currently in `e2e/viewer-reader.e2e.ts` for this message is **removed**, with the test passing without it.
- [ ] The sentence comes from the domain function; a wording change there turns the viewer test red.
- [ ] The domain function is unit-tested across every row (connection gone / site missing a file / Library failing), including one test asserting **no** row overclaims.
- [ ] Tiles that already arrived are still drawn while the message is up — asserted on rendered tiles, not on a count the page reports about itself.
- [ ] The message withdraws itself when tiles start arriving again — asserted by driving error → recovery, with the notice asserted **visible first** so the test cannot pass by never raising it.
- [ ] The message is announced, with the mechanism chosen deliberately and the reason stated in code.
- [ ] The mutation check is recorded per criterion. **Report any surviving mutation as green with its reason.**

```sh
pnpm --filter @ballastella/core exec vitest run src/base-map/resolve.test.ts src/injection/store-image-fetch.test.ts
pnpm exec playwright test e2e/viewer-reader.e2e.ts
pnpm lint && pnpm check && pnpm -r build && pnpm -r test
pnpm test:e2e
```

All exit 0. Read exit codes directly; never pass `--reporter=`; do not pipe gate output through `grep`. No test may reach the network — drive the refusal by routing to a committed fixture.

## Blocked by

None — can start immediately.

# A failed lookup says which failure it was

## What to build

A lookup that does not return Places says **which** kind of nothing it hit — and never a kind it cannot know.

Slice 1 shipped two of those answers: nothing matched, and the service did not answer. This slice adds the fourth outcome, the rate limiter that produces it, and the rule that stops the app diagnosing a connection it cannot see.

Demoable on its own: cut the service and get a specific sentence; search twice in a second and be told to wait rather than told the service is broken.

Read [`SPEC.md`](../SPEC.md) and [ADR-0029](../../../docs/adr/0029-place-lookup-is-a-warned-service-that-leaves-nothing-behind.md) first.

## Where to start

- **The lookup module slice 1 added**, in the domain package. Its `LookupOutcome` union has three members; you add the fourth and refine what `unanswered` says.
- **The search component slice 1 added.** It already renders three outcomes as visible text. You add one and change one.
- `packages/core/src/base-map/resolve.ts` — `baseMapUnavailableNotice`, and its test file. **This is the pattern to follow**: rows in the order the questions arrive, a unit test driving every row, plus one test asserting that **no row overclaims**. Read the function's header before writing yours.
- `packages/core/src/injection/tile-failure.ts` — the existing application of the connection-signal rule in core.
- `apps/viewer/src/lib/online.svelte.ts` — read the header. It states the rule this slice turns on: **`navigator.onLine` is fine for suppressing a claim and would not be fine for making one.** It is a link, not reachability, and false-positive in both directions.
- `apps/editor/src/lib/pwa/installed-app.svelte.ts` — `useInstalledApp().online`, the editor's copy of that signal, which reaches the lookup as a parameter.
- `e2e/editor-base-map.e2e.ts` — the specs slice 1 wrote, and the idiom for routing a host to a refusal rather than to a fixture.

## Contract

**The fourth outcome is added to the union:**

```ts
| { readonly kind: 'too-fast' }
```

**The rate limiter lives in the domain module, and refuses a second request inside one second** — returning `too-fast` **without issuing a request**. It is what makes search-as-you-type visibly not work on the implementer's own machine, which is the point of it.

**A client-side refusal and a server's `429` produce the same outcome and the same sentence.** One code path, one message. Do not give them separate wording; the scholar's remedy is identical.

**A malformed response folds into `unanswered`.** A fork pointed at something that is not a geocoder is the instance operator's problem, and a sentence about response schemas reaches the wrong person.

**The connection signal is a parameter. The domain package does not read `navigator`.**

**When the signal says the connection is down, `unanswered` drops its it-is-probably-the-service clause — and gains no "you are offline" claim.** Telling somebody whose wifi is off that a server in another country is having a bad afternoon is worse than saying nothing; asserting they are offline on the strength of that signal is making a claim it cannot support. Suppress, never assert.

**The search field is never disabled when offline.** Disabling a control *is* making a claim about the connection. The field stays live and a failed lookup explains itself.

**Every outcome reaches the screen as visible text and is announced**, through the mechanism slice 1 chose. Nothing new here is a tooltip.

## Out of scope

- **Placing an Annotation.** Slice 3.
- **The lint containment scan, the deployment warning, the hand-run probe, hosting documentation.** Slice 4.
- **Redesigning the search surface.** Slice 1 owns its shape. You are adding an outcome, not revisiting the component.
- **A retry, a backoff, or a queue.** The scholar's remedy is to wait a moment and press Enter again. Automatic retry against a rate-limited shared service is the opposite of what the policy asks for.
- **Caching results to reduce request volume.** Declined in ADR-0029 — the policy's caching advice is written about bulk use, and there is no bulk use here.
- **A per-origin or cross-tab limiter.** The limiter is per-tab and ADR-0029 accepts that hole explicitly: a scholar with two tabs is not the abuse case the policy is written against. Do not build coordination to close it.
- **The published viewer.**

## Acceptance criteria

- [ ] A `429` from the routed fixture host and a second submission inside one second both produce the **same** visible text, distinct from the other three outcomes.
- [ ] A second lookup within one second **issues no request**, asserted by counting calls to the stubbed `fetch` in the domain package — not by inspecting the returned value.
- [ ] A response the module cannot read produces `unanswered`, not a thrown error and not a fourth kind of message.
- [ ] With the connection signal false, the `unanswered` text carries **no claim about whose fault it is**, and contains no assertion that the scholar is offline. Asserted on the string.
- [ ] With the connection signal false, the search field is **still enabled**.
- [ ] A unit test drives **every** row of the outcome-to-sentence table, plus one asserting that **no row overclaims** — following the existing test of that name beside `baseMapUnavailableNotice`.
- [ ] A wording change in the domain function turns a browser test red, proving the sentence is shared rather than duplicated in the component.
- [ ] All four outcomes are reachable and visible in the browser suite, each driven by the condition that causes it.
- [ ] The mutation check is recorded per criterion. **Report any surviving mutation as green, with its reason.**

```sh
pnpm --filter @ballastella/core exec vitest run src/places
pnpm exec playwright test e2e/editor-base-map.e2e.ts
pnpm lint && pnpm check && pnpm -r build && pnpm -r test
pnpm test:e2e
```

All four exit 0. **Read exit codes directly.** Never pass `--reporter=`. Do not pipe gate output through `grep`. No test may reach the network — drive refusals by routing the fixture host, never by letting a request out.

## Blocked by

- Slice 1 — [`01-find-a-place-and-go-to-it.md`](./01-find-a-place-and-go-to-it.md)

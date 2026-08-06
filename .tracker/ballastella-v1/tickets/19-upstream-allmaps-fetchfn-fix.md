# 19 — Upstream the `@allmaps/render` `fetchFn` fix, and remove our patch

> **HUMAN ONLY. Do not assign this to an agent.** It requires opening a pull request against a
> third-party repository under someone else's governance, engaging with maintainers, and judging
> which of several fixes they should accept. None of that is work an implementing agent should do on
> the project's behalf. An agent *may* be asked to help draft the patch or reproduce the defect, but
> the PR, the conversation, and the decision are a person's.

## Why this exists

`patches/@allmaps__render@1.0.0-beta.83.patch` is carried locally so that warped rendering works at
all. It is a workaround shaped for this repository, not a fix suitable for upstream as-is. Left
alone, it becomes permanent debt with no owner: every `@allmaps/*` bump — which
[ADR-0010](../../../docs/adr/0010-integer-format-version-with-forward-only-migrations.md) already
makes a migration event — has to re-verify it, and `@allmaps/render` arrives *transitively* through
`@allmaps/maplibre`, so a bump of maplibre moves render underneath us.

This ticket closes that loop: get the fix upstream, then delete our patch, its guard, and its
`patchedDependencies` entry together.

**Fulfills** — no [SPEC.md](../SPEC.md) user story directly. It protects the ones that rest on
warped rendering: 30 and 32–37 in ticket 07, all of ticket 08's refinement, and 78–92 in ticket 16,
since a published site renders through the same path.

## The defect

`@allmaps/render@1.0.0-beta.83`, `src/tilecache/CacheableWorkerImageDataTile.ts` — in `dist` at
`dist/tilecache/CacheableWorkerImageDataTile.js`:

```js
this.#worker.getImageData(
  this.fetchableTile.tileUrl,
  proxy(() => this.abortController.abort()),  // proxied
  this.fetchFn,                               // NOT proxied — the defect
  width, height
)
```

`postMessage` cannot clone a function, so **every tile fails with `DataCloneError`**. Upstream
catches it and `console.error`s it (`:27-30`), so nothing propagates: `addGeoreferencedMap` succeeds,
the layer reports bounds, and the map renders **blank with no error surfaced**. Anyone passing the
documented `fetchFn` option to `WarpedMapLayer` gets a blank map and no diagnosis — this is not
specific to Ballastella.

Note `CacheableImageDataTile` (the non-worker sibling, used by `CanvasRenderer`) handles `fetchFn`
correctly on the main thread. Only the worker path is affected, and `WebGL2Renderer` — what
`WarpedMapLayer` uses — is the worker path.

## The trap: the obvious one-line fix does not work

**Measured, in Chromium, against upstream's own worker rebuilt verbatim in a scratch directory
(ticket 07):**

| Attempt | Result |
| --- | --- |
| Unpatched | `DataCloneError` on the function |
| `proxy(this.fetchFn)` alone | **`DataCloneError` on the `AbortSignal`** that upstream puts in `init` |
| …and with the signal removed | `TypeError: Unserializable return value` — a `Response` is not cloneable |
| Fetch on the main thread, hand the worker a `blob:` URL | Works |

So the one-liner fails **twice** before it gets as far as the Response: `init.signal` is itself
unclonable. Anyone proposing it should be shown this table.

One more thing worth telling the maintainers, also measured: through a Comlink proxy
`typeof response.ok === 'function'`, so `!response.ok` is *always* false and upstream's HTTP-error
handling silently never fires. Any fix that keeps the Response behind a proxy inherits that.

Wrapping it as `proxy(this.fetchFn)` looks right and fails differently. The worker does:

```js
// @allmaps/stdlib, inlined into the worker bundle
if (typeof fetchFn === "function") response = await fetchFn(input, init);
if (!response.ok) { ... }
return response;      // then: await response.blob()
```

A `Response` is **not structured-cloneable**, so Comlink's `expose` handler cannot serialise the
return value and answers with `TypeError("Unserializable return value")`. The DataCloneError is
traded for a different error, still swallowed, map still blank. Anyone proposing the one-liner should
be shown this.

There is also no fix available to a *consumer*: marking the Response with `Comlink.proxy()` from
outside would depend on symbol identity across two bundled copies of comlink, and would silently
disable the `!response.ok` HTTP-error branch as described above.

**A second, independent upstream defect found by ticket 07, worth the same PR or its own.**
`@allmaps/annotation@1.0.0-beta.37` carries the Resource Mask as an SVG `polygon points` string
validated by a regex that accepts plain decimals only. `Number#toString` switches to exponential
notation below 1e-6, so a vertex at e.g. `1.5e-7` image pixels serialises as `1.5e-7`, matches no
branch of that regex, and makes the **entire Alignment unreadable** — not just that vertex. We work
around it in our own code (`packages/core/src/alignment/georeference-annotation.ts` emits plain
decimal notation with every significant digit kept), so no patch is needed, but upstream should
either widen the regex or serialise defensively. Ticket 08 makes the mask editable, which is what
makes this reachable in practice.

**A fourth, found by ticket 08: `typeAndOrderToTransformationType` has unreachable branches.** It tests
`type === 'polynomial'` in its first branch *before* looking at the order, so its order-2 and order-3
branches can never run and both `polynomial2` and `polynomial3` come back as `polynomial1`. The
written *file* is correct in every case — only upstream's own inverse helper is wrong — so we read the
order directly instead, pinned by a test that fails when upstream fixes it. **This needs no patch,
only a four-line reordering upstream**, and it is the cheapest of the four to get merged. Related:
`WarpedMap` reads `transformation.type` and ignores the order, so the type has to be passed as an
explicit map option too, or the picker changes the file and not the map.

**And a third, in `@allmaps/annotation`'s transformation types.** Its Zod enum has no `polynomial1`
member and its `.or()` fallback is unreachable dead code, so `generateAnnotation` writes **no
transformation at all** for it and parsing a file containing `polynomial1` returns `undefined`. We
write `{ type: 'polynomial', options: { order: 1 } }` via upstream's own
`transformationTypeToTypeAndOrder`, which round-trips and reads back as `polynomial1`. See open
question 7 in the tracker — this one also needs an ADR-0013 wording decision on our side.

## What we did locally, and what upstream should probably do

Our patch runs the custom fetch on the main thread — where the closure lives — and hands the worker a
`blob:` URL it fetches with plain `fetch`, revoking it in a `finally`. The decode stays off the main
thread, which is the reason the class exists. Tiles with no custom `fetchFn` take the original path
untouched.

That is a reasonable upstream fix, but it is not the only one and probably not the maintainers'
first choice. Options to put to them, in the order I would argue them:

1. **Fetch on the main thread when `fetchFn` is supplied, pass a `blob:` URL** — what we do. Smallest
   diff, preserves worker decode, no protocol change. Cost: one extra object URL per tile, and a
   custom `fetchFn` no longer runs off the main thread (it never could).
2. **Change the worker protocol to accept bytes** — main thread fetches, transfers an `ArrayBuffer`.
   Cleaner separation and no blob URLs, but it changes the exposed worker signature, so it is a
   larger change and a breaking one for anyone calling the worker directly.
3. **Proxy the function *and* have the worker consume a proxied Response** — pass
   `proxy(this.fetchFn)` and, in the worker, `await` the proxied `blob()` (Blobs *are* cloneable).
   Requires the `!response.ok` check to be reworked, since `ok` becomes a Promise. Most faithful to
   the current shape, most subtle.
4. **Fail loudly instead of swallowing.** Independent of the above and worth proposing regardless:
   `:27-30` turns every tile error into a `console.error`. A `TILEFETCHERROR` event — which the class
   already dispatches on the synchronous path at `:32` — would have made this a five-minute
   diagnosis rather than a day's.

Licensing is not an obstacle: `@allmaps/*` is MIT
([ADR-0021](../../../docs/adr/0021-mit-licence-and-gpl-hygiene.md)), and this project already depends
on the Allmaps ecosystem heavily enough that the fix is worth contributing rather than hoarding.

## Steps

- [ ] Reproduce against upstream's own repository, not ours, so the report stands on its own.
- [ ] File an issue describing the defect and the swallowed error, with the `proxy()` trap spelled
      out so the one-liner is not merged as a fix.
- [ ] Open a PR implementing whichever option the maintainers prefer; offer option 1 with our patch
      as the starting diff.
- [ ] Argue option 4 (dispatch `TILEFETCHERROR` rather than `console.error`) whether or not it lands
      with the rest.
- [ ] When a release carries the fix: raise `@allmaps/maplibre` in `pnpm-workspace.yaml` — an
      ADR-0010 migration event — and confirm `@allmaps/render` resolves past the fix.
- [ ] Delete, in one commit: `patches/@allmaps__render@1.0.0-beta.83.patch`, the
      `patchedDependencies` entry in `pnpm-workspace.yaml`, `scripts/check-allmaps-patch.mjs`, its
      line in `package.json`'s `lint` script, and its step in `.github/workflows/ci.yml`.
- [ ] Keep `e2e/editor-warped-fetch.e2e.ts` — it asserts cached tiles, which is the real contract and
      is exactly what should keep passing once the patch is gone. Only its comment needs updating.

## Acceptance criteria

- [ ] An upstream issue exists and is linked here.
- [ ] An upstream PR exists and is linked here.
- [ ] Either the fix is released and every artefact listed above is deleted, or this ticket records
      the maintainers' decision and why we are still carrying the patch.
- [ ] `pnpm lint` and `pnpm test:e2e` pass with the patch removed — in particular
      `e2e/editor-warped-fetch.e2e.ts` still asserts `cachedTiles > 0` without it.

## Out of scope

- Vendoring or forking `@allmaps/render`. If upstream declines, that is a new decision with its own
  ticket, not a silent escalation of this one.
- Any change to how Ballastella injects `fetchFn`. [ADR-0011](../../../docs/adr/0011-injection-layer-for-local-tiles.md)'s
  injection point is correct and is not in question — it is the only reason the defect was found.

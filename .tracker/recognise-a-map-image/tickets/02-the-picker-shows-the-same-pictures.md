# The picker for a map you already have shows the same pictures

## What to build

The "Already in this Workspace" section of the Add-a-Map-Image dialog shows each candidate map's
picture, exactly as the hub does. This is the surface where recognising a sheet matters most: a scholar
is choosing which of several scans to add to the Project they have open, and the only thing
distinguishing them today is a label that may be a random folder name.

This is a small slice deliberately. Ticket 01 built the component; this ticket uses it in a second
place and proves it there.

## Where to start

- `apps/editor/src/lib/map-images/AddMapImage.svelte` — the "Already in this Workspace"
  section and its candidate rows. The `available` derivation filters the same
  `session.mapImages` records the hub renders, so **the data is already present and no new
  plumbing is needed.**
- The `MapThumbnail` component ticket 01 added, in the same directory.
- Whatever ticket 01's hub markup ended up as — match it rather than inventing a second treatment.
- `e2e/support/map-images.ts` — `ensureAddMapImageOpen`, `settle`, and the busy-state helpers.
  **Read the ⚠ comments.** The dialog stays open for a while after an add has visibly succeeded, and
  that window is what made this suite flake; a test that asks about the dialog without settling first
  will be intermittently wrong rather than wrong.

## Contract

**No new data and no new resolution.** The picker's rows already hold `WorkspaceMapImage` records
carrying `thumbnail` and `tiles`. If this ticket finds itself adding a field, a fetch, or a call into the
domain layer, something has gone wrong — stop and re-read ticket 01's contract.

**The same component, the same box, the same glyph.** The rows are laid out more tightly than the hub's
cards, so the box may need to be smaller; if it is, it is smaller by a prop on the existing component,
not by a second component or a copied block of markup.

**Each row's picture still carries `alt=""` and is still not interactive.** The row already has its own
action, and a picture that takes focus would put a stop between a scholar and the button they are
reaching for.

### User Stories

Covers SPEC story **3**.

## Out of scope

- **Redesigning the picker.** The dialog's layout, its sections, its one-at-a-time add guard, and its
  busy states are all untouched.
- **Changing what the picker offers.** The `available` filter — the Workspace's maps minus the ones this
  Project already has a Layer for — is not this ticket's business.
- **The remote-add flow or the from-a-file flow** in the same dialog. Only the "Already in this
  Workspace" section gains pictures.
- **Referenced maps' pictures.** Ticket 03. A referenced candidate shows the glyph here until then, and
  it will start showing a picture with no change to this ticket's code.
- **Adding a second `MapThumbnail`.** One component, two call sites.

## Acceptance criteria

- [x] In the Add-a-Map-Image dialog, a Workspace-held candidate map shows a picture that has
      actually decoded: `naturalWidth > 0`. Asserted exactly — 700 × 500 reduces to 175 × 125 by
      ADR-0030's rule — so a URL at any other scale factor is red rather than merely smaller.
- [x] A candidate whose `thumbnail` is `null` shows the glyph and no broken image. An `info.json`
      declaring no `tiles`, so no tile side is known: an in-workspace map, and therefore a case ticket
      03 cannot make a picture of either.
- [x] Adding a candidate to the Project still works, and the dialog still closes — the existing
      behaviour of this dialog is unchanged. Asserted at the end of the picture test, and all sixteen
      pre-existing tests in the spec pass untouched.
- [x] No new field, fetch, or domain-layer call was added for this ticket. The rows already held
      `WorkspaceMapImage`; the only addition is `session.imageServiceFetch()`, which is the shim
      the hub already reads through and the component's own required prop.
- [x] `pnpm precommit` passes. `lint`, `check` and `test` green first time; `e2e` needed a second run,
      and the reason is recorded below rather than glossed.
- [x] A mutation record is written into this ticket.

```sh
# Add to the spec ticket 01 created, or to the dialog's own spec — whichever holds the
# already-in-this-Workspace flow. `test` must come from e2e/support/network-fence.ts.
pnpm test:e2e editor-add-map-image.e2e.ts
pnpm test:e2e editor-map-image-thumbnails.e2e.ts

pnpm precommit
```

Success is exit code 0 from each. Read exit codes directly; no `grep`, and no `--reporter=…`.

### The mutation record

| Criterion | Mutation | Result |
| --- | --- | --- |
| the picker's picture actually decoded | point the component at a URL that was never written | expect red — green means the assertion is `toBeVisible`, not `naturalWidth` |
| the dialog still behaves | — | the pre-existing dialog assertions must pass untouched |
| **REMEDIATION** — the picker's box is the picker's, not the hub's | drop `size` from where it is consumed: hardcode `96` on the glyph and on the `<img>`'s `width`/`height`, leaving the wrapper box dynamic | expect red on the **glyph's** laid-out box — green means nothing sees the prop, and it can be reverted silently. The picture's box is invariant under this and cannot be the assertion; see below |

**Run.** `MapThumbnail.svelte`'s `fetchTile(url)` was changed to
`fetchTile(url.replace('/0/default.jpg', '/90/default.jpg'))` — a rotation the tiler never wrote, at a
URL otherwise identical, so the element is still rendered and still laid out at its attribute
dimensions.

`pnpm test:e2e editor-add-map-image.e2e.ts -g "actually decoded"` → **exit 1**, both the run and
its retry, timing out on the `naturalWidth` poll:

```
Error: Timeout 20000ms exceeded while waiting on the predicate
> 731 |    .toEqual({ width: 175, height: 125 });
```

**The failure is on the right line.** The `<img>` was present and visible throughout — the dialog
probe shows the dialog open and the row rendered — so `toBeVisible()` would have passed over the empty
box. Only `naturalWidth` went red, which is what the ticket's trap is about.

**A first attempt was a false negative worth recording.** `url.replace('/full/', …)` left the URL
untouched and the test passed: `wholeImageDerivative` builds
`{service}/0,0,{w},{h}/{dw},{dh}/0/default.jpg` and never contains `/full/`. A mutation that does not
mutate reports the assertion as strong when nothing was tested — the second attempt was checked
against the URL the derivative actually produces.

Reverted; the two picker tests and all sixteen pre-existing tests in the spec pass unchanged.

**Run (remediation).** Review found the `size` prop itself untested: a reviewer simulated its loss and
both picker tests stayed green, because `naturalWidth` is intrinsic to the bytes and CSS-independent and
`toBeVisible()` is true of a 96-pixel glyph clipped inside a 48-pixel `overflow-hidden` box. A laid-out
box assertion was added at each call site — the picker's picture and glyph at 48, the hub's picture at
96 — alongside the existing `naturalWidth` assertions rather than in place of them.

`MapGlyph {size}` became `MapGlyph size={96}` and the `<img>`'s `width={size} height={size}` became
`width={96} height={96}`, with the wrapper's inline `style` left driven by the prop — exactly the
half-revert a careless edit would produce.

`pnpm test:e2e editor-add-map-image.e2e.ts -g "picker"` → **exit 1**, both tests, on the run and
its retry.

**The glyph is where the mutation is caught, and the `<img>` provably cannot catch it.** That is worth
writing down, because a first draft of this remediation asserted the picture's box as 48 × 48, saw it go
red under the mutation, and read that as coverage. It was not: the same assertion was **equally red
against the unmutated tree**, which is a broken assertion rather than a detected regression, and the
unmutated run is what exposed it.

```
> 753 |    expect(await picture.boundingBox()).toMatchObject({ width: 48, height: 48 });
-   "height": 48,        -   "width": 48,
+   "height": 33.8389892578125,  +   "width": 47.380767822265625,
```

Tailwind Preflight sets `img, video { max-width: 100%; height: auto }`
(`tailwindcss@4.3.3/preflight.css:230`), and an author stylesheet beats a presentational hint. So:

- **`height: auto` overrides the `height` attribute.** The element's height is always its width over the
  sheet's ratio — 48 / (175/125) = 34.3 at the picker, 96 / 1.4 = 68.6 at the hub — and never the box's
  side. There is no value of `size` for which the picture's box is square.
- **`max-width: 100%` clamps the width to the wrapper**, which the mutation left driven by the prop. A
  hardcoded 96 inside a 48-pixel box therefore lays out at *exactly* the same 48 × 34.3 as the correct
  code. The picture's box is invariant under this mutation, in both directions.

So the assertions were rewritten to claim what is true and load-bearing: the wrapper's box and the width
that fills it (`clientWidth`, not `boundingBox()`, because the dialog animates in under a transform and
its box reads 47.38 for the first frames), plus the **glyph's** own box — which has no `max-width` and so
overflows to 48 × 96 when `size` stops reaching it. Re-run under the same mutation:

```
> 810 |    expect(await glyph.evaluate(…[clientWidth, clientHeight])).toEqual([48, 48]);
-   48,   +   48,
-   48,   +   96,
```

⚠ **For whoever changes these sizes:** a regression in the `<img>`'s `width`/`height` attributes is
invisible to layout whenever the hardcoded value is ≥ the box, which covers both call sites as they
stand. The attributes still earn their place — they stop the row changing shape as pictures resolve —
but the glyph is the only thing an e2e assertion can watch the prop through.

### `viewer-reader.e2e.ts` is flaky on this machine, and it is not this ticket's

The first `pnpm precommit` reported `FAIL e2e` on one test —
`viewer-reader.e2e.ts:2345 takes the notice down by itself when the map's own record answers again` —
and it is worth writing down why that was not treated as a regression, because "a flake" is the most
convenient thing an implementer can decide about a red test.

- It passes in isolation: `pnpm test:e2e viewer-reader.e2e.ts -g "…record answers again"` → exit 0.
- Running the whole spec reproduced flakiness at **two different tests** (`:1854`, `:2293`) and *not*
  the one precommit failed on — both passed on retry. So the file is timing-sensitive here rather than
  broken at any one assertion.
- This ticket's diff is three files, all of them the editor's or the editor's spec. The viewer is a
  separate Playwright project on its own server and cannot see any of it.
- `pnpm precommit e2e` re-run: **exit 0**, 563 passed, 2 flaky (`editor-undo.e2e.ts:333` and
  `viewer-reader.e2e.ts:2293`, both passing on retry, 0.35% against a 3% budget).

Left open for whoever owns that suite: `viewer-reader.e2e.ts` flaked in three different places across
two runs on an idle box, which is more than the budget was set to absorb comfortably.

⚠ The same two traps as ticket 01 apply here: `toBeVisible()` passes for a broken image, and asserting
`src` against a computed string compares the computation with itself.

⚠ **A picker assertion that does not settle the dialog first will flake, not fail.** Use
`ensureAddMapImageOpen` / `settle` from the support module rather than waiting on appearance.

## Blocked by

- 01 — the component and the `thumbnail` field do not exist before it.

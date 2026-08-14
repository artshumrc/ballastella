# The map pane's notices are one component

## Parent

[SPEC.md](../SPEC.md)

## What to build

Both apps say the same things about a map that is not drawing — the Base Map's archive did not
answer, a Historical Map's tiles stopped arriving, this Layer could not be reached — and both already
take the *sentence* from core so the two deployments cannot describe one outage two ways. What is
still written twice is the **presentation**: the alert boxes, the `role="alert"` versus `aria-live`
decisions, and the `sr-only` running commentary about what is on the map and where it is looking.

Make that one component, so a notice cannot be an alert in one app and a live region in the other.

## Where to start

- `apps/editor/src/lib/project/ProjectScreen.svelte` — the `base-map-offline`, `referenced-offline`
  and `base-map-unavailable` blocks, and the `sr-only` div holding `stack-status`, `opening-view`,
  `offline-availability` and `offline-done`.
- `apps/viewer/src/routes/+page.svelte` — `base-map-notice`, `base-map-not-published`,
  `base-map-unavailable`, `historical-map-tiles-unavailable`, `project-needs-network`,
  `layer-unreachable`, and its own `sr-only` div with `stack-status` and `opening-view`.
- Read the long comments on both sides before changing anything. They record a decision that must
  survive: an element **inserted** with its text already in it is `role="alert"`, because an
  `aria-live` region is announced on a text *change* rather than on insertion — so a live region
  inside an `{#if}` is a notice a screen-reader user never hears. This is a recorded amendment to
  ADR-0016's `aria-live="polite"` mandate for status.
- ⚠ The viewer's own comment flags that `base-map-notice` and `base-map-not-published` **have the bug
  the others avoid** — both sit inside `{#if}` blocks and are `aria-live`. Fixing them is in scope
  here: render them unconditionally with an empty string when they have nothing to say.

## Contract

**The sentences stay core's.** `baseMapFallbackNotice`, `baseMapUnavailableNotice`,
`baseMapNotPublishedNotice` and `historicalMapTilesUnavailableNotice` are already the one source of
each; this ticket must not add a second sentence in a template. If a new sentence is wanted, it
belongs in core.

**One rule for which mechanism a notice uses**, applied by the shared component rather than
remembered per call site:

| Shape | Mechanism |
| --- | --- |
| Appears and disappears with its text | `role="alert"` |
| Always present, text changes | `aria-live="polite"` with `aria-atomic="true"` |

**`role="status"` is not available.** The save indicator owns that role for the whole editor, and a
second makes `getByRole('status')` ambiguous — which is a hint that a screen-reader user would have
to disambiguate too.

**The `sr-only` commentary keeps its test ids and its `data-` attributes** — `data-drawn`,
`data-opening-view`, `data-offline`, `data-cache-serving`. Suites read them and they are the only
machine-checkable statement of what the map is showing.

**Which notices each app renders is unchanged.** The editor keeps `offline-availability` and
`offline-done`; the viewer keeps `project-needs-network` and `layer-unreachable`. This ticket unifies
*how* a notice is presented, not *which* ones exist.

**The `project-needs-network` paragraph stays.** It is not the per-Layer badge ticket 05 removed: it
names Historical Maps that will not draw without a connection, which is a fact a Reader on a train
can act on by knowing.

### User Stories

17, 22, 70

## Out of scope

- **Do not merge `BaseMapPane` and `ReaderMapPane`.** They have different data paths, different tile
  fetchers, and different Base Map style decisions. Only the chrome around them is shared here.
- **Do not change any sentence's wording.** If wording is wrong, that is a core change and a
  different ticket.
- **Do not change when a notice appears** — not the `online.current` gate on the Base Map's
  accusation, not `tileFailure`'s recovery rule, not `siteRecordKnown`'s wait.
- **Do not touch the zoom controls or attribution** unless they are trivially the same in both, and
  say so if you skip them.

## Acceptance criteria

- [ ] One notice component in `packages/ui`, used by both apps.
- [ ] Every conditionally-inserted notice is `role="alert"`; every always-present one is
      `aria-live="polite"` with `aria-atomic="true"`. No notice is both and none is `role="status"`.
- [ ] `base-map-notice` and `base-map-not-published` are rendered unconditionally with an empty
      string when they have nothing to say, and are announced when their text changes.
- [ ] Every existing notice test id still resolves to an element with the same text as before.
- [ ] The `sr-only` commentary keeps `data-drawn`, `data-opening-view`, `data-offline` and
      `data-cache-serving` with the same values.
- [ ] No sentence is composed in a template; every one comes from core.

```bash
pnpm lint
pnpm check
pnpm test
pnpm --filter @ballastella/core test
pnpm --filter @ballastella/ui test

pnpm test:e2e editor-base-map
pnpm test:e2e editor-project-screen
pnpm test:e2e editor-offline-copy
pnpm test:e2e viewer
pnpm test:e2e viewer-reader
```

Success: everything exits 0 with no assertion edits to the notice text.

**Mutation check:** turn one `role="alert"` back into an `aria-live` region inside its `{#if}` and
show the accessibility assertion goes red. If no test can tell the difference, write one — this is
the defect the viewer's own comment says is currently shipping.

## Blocked by

- 05 — the Reader's stack becomes the Layer card

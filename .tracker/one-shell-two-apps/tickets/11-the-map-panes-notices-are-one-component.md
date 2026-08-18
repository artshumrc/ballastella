# The map pane's notices are one component

## Parent

[SPEC.md](../SPEC.md)

## What to build

Both apps say the same things about a map that is not drawing — the Base Map's archive did not
answer, a Map Image's tiles stopped arriving, this Layer could not be reached — and both already
take the *sentence* from core so the two deployments cannot describe one outage two ways. What is
still written twice is the **presentation**: the alert boxes, the `role="alert"` versus `aria-live`
decisions, and the `sr-only` running commentary about what is on the map and where it is looking.

Make that one component, so a notice cannot be an alert in one app and a live region in the other.

## Where to start

- `apps/editor/src/lib/project/ProjectScreen.svelte` — the `base-map-offline`, `referenced-offline`
  and `base-map-unavailable` blocks, and the `sr-only` div holding `stack-status`, `opening-view`,
  `offline-availability` and `offline-done`.
- `apps/viewer/src/routes/+page.svelte` — `base-map-notice`, `base-map-not-published`,
  `base-map-unavailable`, `map-image-tiles-unavailable`, `project-needs-network`,
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
`baseMapNotPublishedNotice` and `mapImageTilesUnavailableNotice` are already the one source of
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
names Map Images that will not draw without a connection, which is a fact a Reader on a train
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

- [x] One notice component in `packages/ui`, used by both apps.
- [x] Every conditionally-inserted notice is `role="alert"`; every always-present one is
      `aria-live="polite"` with `aria-atomic="true"`. No notice is both and none is `role="status"`.
- [x] `base-map-notice` and `base-map-not-published` are rendered unconditionally with an empty
      string when they have nothing to say, and are announced when their text changes.
- [x] Every existing notice test id still resolves to an element with the same text as before.
- [x] The `sr-only` commentary keeps `data-drawn`, `data-opening-view`, `data-offline` and
      `data-cache-serving` with the same values.
- [x] No sentence is composed in a template; every one comes from core, from the shared component, or
      from the one app it is true of — see the completion note, which says which is which.

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
## Completion note

**Two components, and the notices are one of them.** `packages/ui/src/MapNotice.svelte` is every
notice on both map panes: `base-map-notice`, `base-map-offline`, `referenced-offline` and
`base-map-unavailable` in the editor, and `base-map-notice`, `base-map-not-published`,
`base-map-unavailable`, `map-image-tiles-unavailable`, `project-needs-network` and
`layer-unreachable` in the viewer. `packages/ui/src/MapCommentary.svelte` is the `sr-only` running
commentary — `stack-status` and `opening-view`, with `data-drawn` and `data-opening-view` on them —
which the ticket's opening paragraph names alongside the alert boxes as the other half of what was
written twice.

**The mechanism is `shape`, and it is the component's decision.** `comes-and-goes` renders nothing at
all until there is something to say and is then inserted as `role="alert"`; `always-present` keeps the
element on the page with an empty string so that its text arriving is a *change*. The two are one
switch on one element, so no notice can carry both and none can be `role="status"`. **There is no
`readOnly`, `mode` or `editable` prop**, here or anywhere in this epic.

**The viewer's two broken notices are fixed, and the shape alone did not fix them.**
`base-map-notice` and `base-map-not-published` were `aria-live` regions inside `{#if}` blocks —
inserted with their text, and therefore announced to nobody — which the viewer's own comment
recorded as shipping. Giving them the `always-present` shape was necessary and not sufficient: it
moved the `{#if}` out by one level, and the block they were still inside — the whole controls column
— is itself built client-side once the Project file resolves, with both sentences settled before it
exists. A `MutationObserver` installed from document creation, against the built viewer on a site
published with `baseMapAssetsBundled: false` and `withoutBaseMap: true`, still logged two inserts
each carrying its full sentence and **no change record at all**.

So the regions are rendered at the top of `<main>`, above the Front-Page/Project split, where they
are part of the prerendered HTML and hold an empty string from the first frame. A `showingTheMap`
gate on the *text* keeps when they speak exactly where it was — a Project's map, and not the Front
Page, a Project that would not open, or a sheet read as a document. The same measurement now reads
`insert` with an empty string while the document is still parsing, then `change` carrying the
sentence some 200 ms later, for both notices.

**Two `toHaveCount(0)` assertions in `viewer-reader.e2e.ts` became `toHaveText('')`**: the element is
meant to be there and silent, and that is the fix rather than a weakened assertion. A third site
gained the mechanism assertions and never held a `toHaveCount(0)` of its own.

**The sequence is asserted, and not the attributes.** `aria-live`, `aria-atomic` and the absent
`role` are identical whether the region was mounted before its text or with it, so no attribute
assertion could have caught the first attempt — and `map-notice.dom.test.ts`'s transition test drives
the component directly, which is a sequence the app never performs. `watchNoticeArrivals` in
`viewer-reader.e2e.ts` records the arrivals from document creation and two existing specs assert the
pair — insert with an empty string, then a change carrying the sentence — one for each notice, on the
arrival path a Reader meets. Both go red against the un-hoisted template.

**What each sentence's source is.** The four core sentences are untouched and still come from
`baseMapFallbackNotice`, `baseMapUnavailableNotice`, `baseMapNotPublishedNotice` and
`mapImageTilesUnavailableNotice`; `opening-view` still renders `openingViewSentence`, now called
inside `MapCommentary` rather than in each app. `MapNotice` composes **no prose at all** — headings,
sentences and bodies all arrive from the consumer. The empty-stack sentence stayed two sentences
because the two differ in wording and changing wording is out of scope: "Nothing is on the map yet."
invites the one thing an author can do, and a Reader has nothing to add, so each app hands its own
over as `emptyStackNote`, exactly as `LayerList` takes `noLayersGuidance`. The count sentence — "2 of
3 Layers are drawn over the Base Map." — was identical in both and is now the component's.

**Two residual duplications, named rather than silently left.** `The Base Map did not load` is spelled
in both apps as a `heading` prop; it is the only heading both apps render, and moving headings into
core would be adding sentences to core, which the Contract reserves for a different change. The
`base-map-offline` and `referenced-offline` bodies are still the editor's own template prose, as they
were: neither is a core sentence and neither is rendered by the viewer.

**The prose sweep covers this ticket's sentences.** `EDITOR_ONLY_PROSE` in `viewer-reader.e2e.ts`
reads `body` `textContent` on a Project page, so it reaches the `sr-only` commentary, but its phrases
were leftovers from tickets 05 and 06: not one of the sentences this ticket moved into a per-app
snippet was listed, and "this Workspace" does not match "your Workspace". The editor's empty-stack
line and its offline reassurance are in the list now, so hard-coding either into `MapCommentary` or
`MapNotice` fails the sweep as well as the component tests. This epic has produced that defect four
times.

**Mutation checks, all red as required, all reverted.**

| Mutation | What went red |
| --- | --- |
| every notice given `aria-live` instead of `role="alert"` | the alert test (`role` expected `alert`) |
| `always-present` moved inside the `{#if}` | the live-region test — the element is gone when empty |
| the `{#if}` removed, so an alert never leaves | the alert test's absence half |
| an editor sentence written into `MapNotice` itself | four tests, including the prose sweep |
| the two always-present notices left in the controls column | the arrival-sequence assertions, both notices |
| the editor's empty-stack and offline sentences rendered by `MapNotice` | the widened prose sweep |
| `MapCommentary` saying "Nothing is on the map yet." itself | the paired empty-stack test's Reader half |
| the `emptyStackNote` render dropped | the same test's editor half |
| the `children` render dropped | the paired extras test's presence half |
| an `offline-availability` line rendered for everybody | the same test's absence half |
| `data-drawn` and `data-opening-view` removed | four commentary tests |
| `stack-status` given `role="status"` | the live-region test |

**And in the browser**, against the real built viewer: putting `base-map-not-published` back inside an
`{#if}` as an `aria-live` region turned both halves red in `viewer-reader.e2e.ts` — the empty-string
assertion (element absent) and the mechanism assertion (`aria-atomic` missing). Reverted, and both
pass again.

**Seam 2 is unchanged at 630 of 630.** No browser test was added; the five new browser claims are
assertions folded into existing specs — `role="alert"` and no `aria-live` on `base-map-unavailable`,
`aria-live`/`aria-atomic`/no `role` on `base-map-not-published`, and the arrival sequence of each of
the two always-present notices.

**The viewer's bundle** (`du -sb apps/viewer/build`): 2 857 086 bytes before, 2 858 656 after — 1 570
bytes, of which 502 are the hoist and the gate that made the two notices audible.

**The zoom controls and attribution were skipped**, as the ticket's last out-of-scope line asks to be
told: they are not written in either app's template. Both are MapLibre's own, added inside
`BaseMapPane` and `ReaderMapPane`, which this ticket must not merge.

**The controls column is the width it was.** The two always-present notices were briefly two
zero-height children of a `gap-4` column, which put 2 rem of extra air between the Base Map switcher
and the Layer stack on an untroubled site — three 16 px gaps where there had been one. Hoisting them
out of the column for the announcement above took that back with it: measured on a published site
with nothing wrong, switcher bottom to Layer stack top is 16 px, as it was before this ticket. Above
the split they are zero-height and margin-free when empty, so they cost the page nothing there
either.

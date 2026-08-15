# The Layer card moves to the shared package

## Parent

[SPEC.md](../SPEC.md)

## What to build

Move the Layer stack — the list, the card, and the kind-style table — into `packages/ui`, and make
every editing prop optional so that a consumer which passes none gets a card with no editing on it.

**The editor's interface does not change.** This ticket is the prefactor that makes ticket 05 easy:
make the change easy, then make the easy change. It is complete and verifiable on its own — the
editor renders exactly as before, from a component that now lives where both apps can reach it.

## Where to start

- `apps/editor/src/lib/layers/LayerList.svelte` — read the whole header before touching it. It
  records why the drag source is the handle and the drop target the card, why the move buttons are
  the contract and the drag the convenience (ADR-0016), and why a closed card carries so little.
- `apps/editor/src/lib/layers/layer-kind-style.ts` — the one table every colour in a card comes
  from. Its header explains why it is a module rather than a const, and that reason gets stronger
  here: `ProjectScreen` supplies snippets that must be the card's colour.
- `apps/editor/src/lib/layers/layer-list.dom.test.ts` and `LayerListHarness.svelte` — these move
  with the component. The harness exists because `LayerList` calls back and waits for new props;
  read its header before assuming a test can drive the component directly.
- `apps/editor/src/lib/project/ProjectScreen.svelte` — the caller, and the source of the
  `mapContents`, `problemAction` and `annotationContents` snippets.

## Contract

**Every write callback becomes optional**, and its absence removes the control it drives:

| Prop | Absent means |
| --- | --- |
| `ontypename` / `oncommit` | no rename pencil, and the name is never a field — **both, or neither**, so a one-sided pair must be tested and not only the pair and the empty set |
| `onmove` | no Move up / Move down, the drag handle is not rendered, **and no card is a live drop target** — the three drop handlers go with it, or a card highlights and calls `preventDefault` to accept a drop it cannot perform |
| `ondelete` | no Delete |
| `ondragopacity` | no opacity slider |
| — | ⚠ **`oncommit` is not exclusively the rename's.** The opacity slider's `onchange` calls it too — it ends whichever edit was in flight (ADR-0017 rule 1), and there are two — so `ondragopacity` passed without it would give a slider that reports every position it is dragged through and commits none. No consumer does that, so the prop shape stays as it is; the component header carries the same note, because this table's rows are not the whole truth about `oncommit`. |
| `onshow` | the visibility toggle is not rendered |
| `mapContents` / `annotationContents` / `problemAction` | that region simply is not there |

**There is no `readOnly` prop and no `mode` prop.** A control the consumer does not want is a
callback the consumer does not pass. Any implementation that adds a boolean and branches on it is
wrong and must be rejected in review.

**`referencedImageIds` becomes optional too.** When it is not passed, the "Remote reference — needs
the network" / "Local copy — no network needed" badge is not rendered at all. The editor keeps
passing it. This is the seam through which ticket 05 drops the badge a Reader cannot act on.

**Every custom property the card reads moves with it.** Ticket 02 took the kind inks; this ticket
takes `--layer-problem-ink`, which the warning triangle on a refused Layer's band is coloured with.
It is declared in `packages/ui/src/layout.css` and **nowhere else** — a second declaration in a
consumer's stylesheet is the drift ticket 02 established this rule against. Left behind in
`apps/editor/src/routes/layout.css` it was the exact defect ADR-0034 exists to prevent: Tailwind
emits the *utility* `.text-[var(--layer-problem-ink)]` into both apps' stylesheets the moment the
component is in the shared package, but the *declaration* went into the editor's alone — so the
first non-editor consumer to render a Historical Map with no Alignment would draw the triangle in
the inherited `base-content` instead of the mixed ink at 5:1, with nothing erroring and a grep for
the class still passing. Verify by grepping the built CSS of **both** apps for the declaration
`--layer-problem-ink:`, not for the utility.

**The kind-style table moves to `packages/ui` and keeps its whole-class-string rule.** Tailwind finds
the classes it generates by reading source, so `bg-${token}/10` built at runtime produces a class
that exists in the DOM and in no stylesheet. Consumers must keep using the strings whole.

**Tailwind must scan the new package.** Both apps' Tailwind configuration has to see
`packages/ui/**` or every shared class silently produces no CSS. Verify by looking at built output,
not by reasoning about it.

**Nothing rendered may change.** Same markup, same test ids, same classes, same behaviour.

### User Stories

57, 58, 59, 65

## Out of scope

- **Do not change the viewer.** It still renders `ReaderLayerControls`; ticket 05 replaces it.
- **Do not change what the editor renders.** Every existing `data-testid` keeps its identity and its
  place. If a test in `editor-layers` or `layer-list.dom.test.ts` needs editing, that is a signal
  something moved that should not have.
- **Do not move the Annotation surface.** `annotationContents` stays a snippet the editor fills;
  ticket 06 moves what goes inside it.
- **Do not touch the drag implementation.** happy-dom's `DragEvent` carries neither `dataTransfer`
  nor `relatedTarget`, so drag claims stay at Seam 2 — `vitest.config.ts` catalogues this.
- **Do not add ordinals, leaders, or a Reader's announcement.** Tickets 05, 08 and 12.

## Acceptance criteria

- [ ] The Layer list, the Layer card and the kind-style table live in `packages/ui`; the editor
      imports them and holds no copy.
- [ ] Every write callback and `referencedImageIds` are optional; omitting one removes exactly the
      control named in the table above and nothing else.
- [ ] No `readOnly`, `mode`, `editable` or equivalent boolean exists anywhere in the shared package.
- [ ] `layer-list.dom.test.ts` and its harness run from `packages/ui` and pass unchanged in
      substance.
- [ ] New component tests assert, for each optional callback, that the control is **present** when
      the callback is passed and **absent** when it is not. Both halves in the same test file.
- [ ] The editor's rendered Layer sidebar is unchanged: `editor-layers` and `editor-project-screen`
      pass with no edits to their assertions.
- [ ] Tailwind emits the shared package's classes into both apps' built CSS.

```bash
pnpm lint
pnpm check
pnpm test
pnpm --filter @ballastella/ui test

pnpm test:e2e editor-layers
pnpm test:e2e editor-project-screen
pnpm test:e2e editor-annotations

pnpm -r build
# The kind tint must exist in the built CSS of BOTH apps, not just the editor:
grep -rlo "layer-kind-ink-map" apps/editor/build apps/viewer/build
```

Success: everything exits 0, the e2e specs pass with no assertion edits, and the grep finds the
custom property in both builds.

**Mutation check:** for each optional prop, delete the guard that hides its control and show the
absent-half assertion goes red. An absence asserted without its positive control passes when a test
id is renamed, which is the vacuous green this repository's testing decisions exist to prevent.

## What the viewer's bundle cost

ADR-0034 requires the viewer's bundle to be measured across every move into `packages/ui` and the
number recorded in the ticket that made it, so that sharing components cannot silently make every
published site larger (SPEC story 61). `pnpm --filter @ballastella/viewer build`, before and after:

| | before | after | delta |
| --- | --- | --- | --- |
| whole `build/` | 2,802,711 B | 2,820,923 B | **+18,212 B (+0.65%)** |
| CSS | 235,868 B | 254,042 B | +18,174 B |
| JavaScript | 2,563,457 B | 2,563,496 B | +39 B |

193 of those CSS bytes are `--layer-problem-ink` and its `@supports` fallback, which is the whole of
what moving the declaration here costs a published site — and the price of the triangle being the
colour the card says it is rather than whatever `base-content` happens to be. It is the only
difference the move makes to either built stylesheet: the editor's own is byte-identical, same
content hash, before and after.

**Effectively all of it is CSS.** The viewer still renders `ReaderLayerControls` and imports no
Layer card, so neither the component nor `@lucide/svelte` — which the shared package now depends
on, and which the viewer therefore reaches in its dependency graph — is in the bundle:
`grep -rl lucide apps/viewer/build` finds nothing, and the only `Untitled Layer` in it is
`ReaderLayerControls`'s own. What grew is the stylesheet, because `@source '.'` in
`@ballastella/ui/layout.css` now scans a component carrying the kind tints, the toggle and range
modifiers and the tiles badge. That is this ticket paying a cost of ticket 05's a ticket early
rather than avoiding one: those are the rules the shared card will need.

The 39 bytes of JavaScript are content-hashed asset names moving in the chunks that reference the
rebuilt stylesheet; no module entered the graph, which is what the two greps above say directly.

## Blocked by

- 02 — a shared UI package, proved by the Base Map switcher

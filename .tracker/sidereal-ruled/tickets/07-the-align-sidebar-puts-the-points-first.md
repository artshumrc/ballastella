# 07 — The align sidebar puts the points first

## What to build

The align sidebar is reordered so that what a scholar is doing is at the top, about half its prose is
removed, and the control that destroys a Control Point looks like a button and looks destructive.

New order: the one-sentence prompt, then the Control Points, then how the Map Image is stretched, then
*Check this alignment*, then *Done*. **Every warning stays.**

The copy triage, decided and not open for reinterpretation:

- **Keep, load-bearing:** the pairing prompt and all four of its branches, the warped-status line, the
  fold warning, the shortfall lines, the "changed elsewhere" alert and its three outcome sentences,
  and the refusal-to-undo notice.
- **Demote into the explainer disclosure:** the Simple-only note and the advanced-types note.
- **Cut to one sentence:** the "How this works" explainer keeps its first sentence; its second and
  third go.
- **Move off this screen:** the used-by sentence, to the Map Image's row on the Workspace Home, whose
  destination ticket 05 has already built.

## Where to start

- `apps/editor/src/lib/alignment/AlignmentWorkspace.svelte:1191-1630` — the column, and everything in
  it. Its container is
  `flex shrink-0 flex-col gap-3 bg-base-300 p-4 lg:min-h-0 lg:w-96 lg:overflow-y-auto lg:border-l lg:border-base-content/10`.
  In order today: the explainer disclosure (1206–1229), the pairing prompt (1240–1266), `undo-refused`
  (1274–1278), the "changed elsewhere" alert (1294–1372) with a ~40-line inline async handler at
  1311–1353, the outcome line (1381–1389), the fold warning (1401–1411), the transformation and check
  group (1413–1474), the warped status (1482–1498), the Control Points list (1509–1575), the used-by
  sentence (1602–1609), `ImageDetails` (1618–1620), and *Done* (1622–1629).
- The same file, **1564–1570** — the delete control as it stands:
  `class="btn btn-ghost btn-xs"` with the visible text `Delete point {ordinal}`. Ghost, `xs`, no
  `btn-error`, no glyph, no confirmation. Undo is the safety net and stays the safety net.
- `apps/editor/src/lib/alignment/TransformationPicker.svelte:120-217` — the select, its
  `aria-describedby="transformation-guidance"` wiring, the advanced disclosure, and the two notes
  being demoted.
- `apps/editor/src/lib/alignment/used-by.ts:54-70` — `describeAlignmentUsers`. **Keep the function and
  its test.** Only the render site moves.
- `apps/editor/src/lib/alignment/transformation-picker.dom.test.ts` — **this pins the four primary
  option strings verbatim**, the shortfall sentences verbatim, the `aria-describedby` wiring and its
  text, and that the group contains no `[title]` and no `[class*="tooltip"]`.
- `e2e/editor-align-route.e2e.ts:817-845` — asserts `aria-expanded=false`, that `align-explainer` has
  count 0 until clicked, that its text contains "Click a feature on the Map Image", that there is no
  `title`, and that there is no CSS-generated content. `:106-220` measures the sidebar's geometry at
  three viewport widths and `:294-296` requires `alignment-done` to be a **link**, not a button.
- `e2e/editor-alignment.e2e.ts:335-390`, `:703`, `:854`, `:969-990` — `control-point-select` text,
  the ordinal's computed `tabular-nums`, `control-point-delete` by first/nth and the renumbering after
  it, and row `innerText` equality across an undo.
- `e2e/editor-align-referenced.e2e.ts:700-800` — the used-by text and `data-used-by-count`, and at
  `:795-800` a live-region roll-call asserting `aria-live="polite"` on `pairing-status`,
  `warped-status`, `alignment-opening-view`, `alignment-used-by` and `changed-elsewhere-outcome`.
- ADR-0013 (transformation types and distortion), ADR-0022 (click-then-click pairing), ADR-0023 (one
  Alignment per Map Image), and ADR-0016's icon amendment.

## Contract

**The delete control becomes a trash glyph in `error` with its per-row name in `sr-only` text.** This
is ADR-0016's icon amendment applied and not relaxed: the accessible name is text, never a `title`,
and it still names *which* point — `Delete Control Point 3` — because three specs reach it by
accessible name. No confirmation dialog; undo remains the safety net, as ADR-0022's flow assumes.

**`alignment-done` stays an `<a>`**, full width, at the bottom, one large control. A spec asserts its
role is `link`.

**Every live region keeps its element, its `aria-live`, and when it speaks.** `pairing-status` with its
`data-pending`, `warped-status` with its `data-warped-status`, `alignment-opening-view`,
`changed-elsewhere-outcome`, and — where it now renders — `alignment-used-by`. The roll-call spec
checks five of them; moving one to another screen means that spec's expectation moves with it rather
than being deleted.

**`alignment-used-by` and `data-used-by-count` move to the Map Image row, they do not disappear.**
Update `editor-align-referenced.e2e.ts` to assert them where they now render. Deleting the assertion
is the wrong fix: the sentence explains an ADR-0023 consequence and is the only place it is explained
in words.

**The demoted notes stay reachable and stay text.** The Simple-only note and the advanced-types note
move inside the explainer disclosure. They do not become tooltips and they do not become
CSS-generated content — the align spec asserts the absence of both, deliberately.

**The explainer's first sentence keeps the substring `Click a feature on the Map Image`**, because
that is what the spec matches on and it is also the right sentence.

**The sidebar's geometry is unchanged**: same container classes, same `lg:w-96`, same
`lg:overflow-y-auto`. `editor-align-route.e2e.ts` measures this column against the panes at three
widths and none of those assertions should need to move.

**`transformation-picker.dom.test.ts` is rewritten, not relaxed.** The four option strings and the
shortfall sentences are still asserted verbatim; what changes is where the two notes are asserted to
live. A test that stops checking the wording is how the prose creeps back.

## User Stories

- **62.** As an author placing my first Control Point, I want one sentence telling me what to do, with
  the rest of the explanation available and closed.
- **63.** As an author, I want the Control Points I have placed to be the first thing in the column,
  because they are what I am doing.
- **64.** As an author, I want a row's ordinal, its dot's colour and the mark on both map panes to
  identify the same point from the same rule.
- **65.** As an author, I want the control that destroys a Control Point to look like a button and look
  destructive, and to name which point it destroys to a screen reader.
- **66.** As an author, I want every warning I have today: the fold warning, the shortfall lines, the
  "changed elsewhere" alert and its outcomes, the refusal to undo, and the warped status.
- **67.** As an author, I want the transformation guidance and the notes about Simple and about advanced
  types available where I would look for them rather than always on screen.
- **68.** As an author, I want the fact that one Alignment is shared by every Project drawing this Map
  Image told to me on the Map Image, before I start refining, rather than beside the controls while I
  click.
- **69.** As an author, I want *Done* to stay exactly as it is: one large control, at the bottom,
  always reachable.
- **70.** As an author, I want the column to keep its live regions announcing pairing, warped status,
  the opening view and outcomes, unchanged in what they say and when.
- **77.** As a contributor, I want the copy this epic deletes to be deleted deliberately, with the
  specs that pin it rewritten to assert the new arrangement rather than relaxed to assert nothing.

## Out of scope

- **The Resource Mask instructions** at `AlignmentWorkspace.svelte:1026-1029`. They are on the same
  screen but not in this column, and they are not in this epic.
- **`DistortionControls`' three control labels.** `Colour the Map Image by how much it is stretched`,
  `Draw a grid, bent by the Alignment` and `What the colours show` are asserted by accessible name and
  are long on purpose. They stay inside the *Check this alignment* disclosure, unchanged.
- **The transformation catalog.** ADR-0013's labels, guidance and tiers live in
  `packages/core/src/alignment/alignment.ts` with their own test. Do not edit the words.
- **Adding a confirmation to delete.** Undo is the safety net by design.
- **Pairing behaviour.** ADR-0022's click-then-click, the Escape cancel, and the pending state are
  unchanged.
- **Numbering the column as stages.** A rejected layout numbered *place points → choose stretch →
  check*, which asserts a sequence the task does not have: refining an existing Alignment starts at
  the third step. Do not reintroduce it.

## Acceptance criteria

- [ ] The column renders in the order: prompt, Control Points, transformation, check disclosure, then
      *Done* pinned last.
- [ ] The explainer renders one sentence, containing `Click a feature on the Map Image`, and the
      Simple-only and advanced-types notes render inside the disclosure.
- [ ] The used-by sentence no longer renders in the align sidebar and does render on the Map Image's
      row on the Workspace Home, with `data-used-by-count`.
- [ ] `describeAlignmentUsers` and `used-by.test.ts` are unchanged.
- [ ] The delete control renders a glyph, is coloured `error`, and has the accessible name
      `Delete Control Point {n}` with no `title` attribute.
- [ ] `alignment-done` is still a link, full width, last in the column.
- [ ] Every live region named in the Contract still carries `aria-live="polite"` and still announces
      the same sentences.
- [ ] The fold warning, `undo-refused`, the "changed elsewhere" alert and all three of its outcome
      sentences, the shortfall lines and the warped status all still render.
- [ ] The sidebar's container classes are unchanged and the three-width geometry assertions pass
      untouched.
- [ ] `transformation-picker.dom.test.ts` still asserts the four option strings and the shortfall
      sentences verbatim, and still asserts no `[title]` and no `[class*="tooltip"]`.
- [ ] The word count of prose rendered in the column at rest is materially lower than before — measure
      it and say what it was and what it is now, in the ticket's Answer.
- [ ] `pnpm precommit` passes; if `SEAM_2_CEILING` moves, the table records the count and the reason.

```bash
pnpm --filter @ballastella/editor test

pnpm test:e2e editor-alignment
pnpm test:e2e editor-align-route
pnpm test:e2e editor-alignment-refinement
pnpm test:e2e editor-align-referenced
pnpm test:e2e editor-warped-fetch
pnpm test:e2e editor-undo

# No tooltip channel, and no left border for emphasis.
grep -n "title=\|tooltip" apps/editor/src/lib/alignment/AlignmentWorkspace.svelte
grep -n "border-l\b\|border-l-" apps/editor/src/lib/alignment/AlignmentWorkspace.svelte
# expect for the second: only the column's own `lg:border-l` boundary against the map

pnpm precommit
```

Success is a column a scholar can use without reading it, every warning still present, and six specs
green with their assertions rewritten to the new arrangement rather than weakened.

## Blocked by

- 01
- 05

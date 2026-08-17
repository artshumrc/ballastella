# 02 — The selected Annotation's row is unmistakable

## What to build

Today the mark of a selected Annotation is a 10% wash on the header button and a semibold name. In a
24 rem column of four near-identical rows that is not enough, and it is the fault a scholar reported
first.

Move the wash from the button to **the whole row**, and add a two-pixel spine in the Layer kind's own
ink down the row's left edge. Both apps get it, because the row is shared.

This is a small, self-contained, immediately visible improvement, and it is also a prefactor: ticket
06 rewrites this component, and doing the selection mark first means 06 does not have to do it while
also moving a panel across the screen. The wash on the whole `<li>` is correct both before the
disclosure is removed (it covers the header and the revealed region) and after (it covers the row), so
none of this work is thrown away.

While in the file, fence the three list behaviours that must survive the rest of the epic — see
*User Stories*. They are already true; the job is to leave a test that fails if a later ticket breaks
them.

## Where to start

- `packages/ui/src/AnnotationRow.svelte` — the `<li>` (currently `border-b border-base-200
  last:border-b-0`) and the button beneath it, whose class list carries `open && font-semibold
  ${KIND_STYLE.annotation.tint}`. The long comment above that button argues why the wash is the mark
  and why `border-primary` and daisyUI's `menu-active` were removed; **read it, because the spine you
  are adding is not the rule that was removed** — see the Contract.
- `packages/ui/src/layer-kind-style.ts` — `KIND_STYLE.annotation.tint` is `bg-info/10` and
  `KIND_STYLE.annotation.ink` is `text-[var(--layer-kind-ink-annotation)]`. Every colour comes from
  this table; nothing in the component names a colour another way, and the classes must be written
  whole because Tailwind finds them by reading the source.
- `packages/ui/src/layout.css` — where `--layer-kind-ink-annotation` is computed, and the measured
  argument for the half-and-half mix.
- `packages/ui/src/annotation-list.dom.test.ts` and `packages/ui/src/AnnotationListHarness.svelte` —
  the seam and the harness. The harness owns the open id, for the reason its header gives: the
  component reports the gesture and waits for the answer as a prop.
- `e2e/editor-annotations.e2e.ts` — there is an existing browser assertion comparing the selected row's
  computed colour against the Layer header's, because the wash is shared. Find it before you change
  the element the wash is on.

## Contract

- **The wash goes on the `<li>`, not the button.** `KIND_STYLE.annotation.tint`, unchanged — do not
  pick a stronger alpha. At 10% over `base-100` the row's text stays on the colour it was already
  legible on; a heavier fill has to re-solve its own contrast and repaint the text to win.
- **The spine is `--layer-kind-ink-annotation`**, drawn as an inset box shadow or a left border on the
  `<li>`, two pixels, full height of the row.
- ⚠ **This is not the rule that was removed, and the ADR trail must not read as though it were.** What
  was removed was `border-primary` on a `menu-active` row: two colours making two claims, `primary`
  being the *app's* action colour reserved for controls outside the Layer cards. This spine is the
  Annotation Layer's own ink, from the one table, on the selected row only. The comment you leave must
  say that, or the next reader will delete it citing the old note.
- **Colour is still not the only channel.** The name stays semibold and `aria-expanded` still carries
  the state. Do not remove either.
- `aria-expanded` remains the single property carrying the selection. **Do not add `aria-pressed`** —
  the file already argues why, and the argument is unchanged by this ticket.
- The row keeps its `contents` snippet and keeps opening. **Nothing about the disclosure changes here.**

## User Stories

- **7.** As either app's user, I want the selected row marked by more than colour, so that a monochrome
  screen still says which row it is.
- **8.** As either app's user, I want the row's selected state to reach a screen reader, so that "which
  Annotation is active" does not depend on seeing a wash.
- **12.** As either app's user, I want a Layer's Annotations to stay in the Layer's own card, so that
  membership in a group I can show and hide is still what the stack tells me.
- **13.** As either app's user, I want the count of Annotations in the Layer to stay above the list, so
  that an empty Layer and an unread Layer stay distinguishable.
- **14.** As an author, I want deleting an Annotation to renumber the rest, so that the ordinals stay
  the positions they claim to be.
- **54.** As a keyboard user, I want one property to carry the selection, so that two properties cannot
  disagree about which Annotation is active.

Story 54 is what the Contract's "do not add `aria-pressed`" line is protecting, and this is the ticket
that owes it a test: `aria-expanded` present on both states, and no `aria-pressed` anywhere on the row.
Ticket 06 later adds `aria-controls` to point at the Inspector — that is the same one property gaining a
target, not a second property.

Stories 12, 13 and 14 are **already true**. They are on this ticket because it is the row-and-list
ticket, and what it owes them is a test at the component seam that goes red if tickets 06 or 08 break
them. 13 includes the distinction the list already draws between `annotations === null` (nobody has
read it) and `annotations.length === 0` (it is empty) — assert both, because collapsing them told a
Reader that a Layer holding a scholar's work was empty.

## Out of scope

- **Removing the disclosure, `contents`, `keepInView`, the slide, or `data-reveal-ms`.** Tickets 06 and
  08. If you delete any of it here, both apps break.
- **The Annotation Inspector.** It does not exist yet.
- Touching `AnnotationReading`, `AnnotationEditor`, or either app's screens.
- Restyling the Layer card, the list's caption, or the ordinal's own colour. The ordinal already wears
  the kind's ink for a measured reason.
- Changing `KIND_STYLE`. The table is right; this ticket reads from it.

## Acceptance criteria

- [ ] The selected row's wash covers the whole row, header and revealed region together, and the
      unselected rows carry none.
- [ ] The selected row draws a spine in `--layer-kind-ink-annotation`; an unselected row does not.
- [ ] The selected row's name is semibold and `aria-expanded="true"`; no `aria-pressed` exists anywhere
      in `AnnotationRow.svelte`.
- [ ] Component-seam tests cover: the wash and spine appearing on the selected row only; the name's
      weight; `aria-expanded` on both states; the caption's count for one and for several; the `null`
      collection saying nothing at all versus the empty collection saying it is empty; and ordinals
      renumbering when the collection re-renders one Annotation shorter.
- [ ] Each new test has been watched to fail once against a deliberate break, and the break is named in
      the commit message.
- [ ] The existing browser assertion that compares the selected row's colour to the Layer header's
      still passes, or has been repointed at the `<li>` with the change noted.
- [ ] `pnpm precommit lint check test` passes, and `pnpm test:e2e editor-annotations.e2e.ts` passes.

```bash
cd /home/dflood/repos/ballastella
pnpm --filter @ballastella/ui exec vitest run annotation-list
pnpm --filter @ballastella/ui test
pnpm precommit lint check test
pnpm test:e2e editor-annotations.e2e.ts
```

Success: the `ui` project is green with the new assertions, `precommit lint check test` exits 0, and
`editor-annotations.e2e.ts` exits 0.

## Blocked by

None — can start immediately.

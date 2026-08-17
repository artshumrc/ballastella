# 01 — Record the reversal: an ADR and the word for the panel

## What to build

Two documents, and no code.

**An ADR** stating that an Annotation's content is read beside the map rather than inside its row —
and *why*, in a way that replaces the reasoning it contradicts rather than sitting beside it. This
epic reverses `one-shell-two-apps` ticket 01, whose decision is argued at length in the header of
`AnnotationRow.svelte`. That argument is not wrong; it is answered differently. Say so.

**A glossary entry** in `CONTEXT.md` for **Annotation Inspector**, so the UI and the code have one
word for the panel and a reviewer can hold the epic to it.

## Where to start

- `AnnotationRow.svelte`, the file header — the decision being reversed, in its own words: "**The row
  is the disclosure.** The editor used to render an Annotation's details as a *sibling of the list*: a
  box headed 'The west quay' sitting under a list in which 'The west quay' is one of four rows, with
  nothing joining the two." Read all of it before writing a line of the ADR.
- `.tracker/one-shell-two-apps/tickets/01-an-annotation-opens-in-its-own-row.md` — the ticket that
  took the decision, including its recorded "Coverage gap".
- `docs/adr/0009-annotations-use-simplestyle-spec.md` — read the section headed "Amendment: a Layer has
  no default style; a new Annotation is drawn with the last one's". It is the model for how this
  repository writes a reversal: it states plainly that it contradicts the section above it, lists the
  three things given up, and says which of them is the real loss.
- `docs/adr/0034-a-shared-ui-package-for-the-components-both-apps-render.md` — the shared-package
  boundary the Inspector will live inside.
- `CONTEXT.md` — the glossary's shape. Every entry is a term, a definition in the project's voice, and
  an `_Avoid_:` line of near-synonyms.
- `docs/adr/` — the highest existing number is `0034`, so this is **0035**.

## Contract

**The ADR must contain all four of these, or it has not done its job:**

1. **What the row-as-disclosure decision was for.** The details had been a sibling of the list,
   unmoored from the row they belonged to, and putting them inside the row was what moored them.
2. **Why moving them further away is nevertheless right.** Two claims on an Annotation were being
   answered in one place: membership in a Layer (a group that is shown, hidden, ordered, renamed and
   deleted as a group) and the content it carries. The stack answers the first well and the second
   badly.
3. **What moors the panel now that it is not inside the row** — and this is the load-bearing paragraph,
   because it is the thing the sibling panel never had: the dashed leader from the mark to its row, and
   the ordinal, glyph and shape word repeated in the Inspector's own header from the same
   `annotationOrdinal` and `annotation-name.ts` rules the row and the canvas use.
4. **What is given up**, named rather than glossed: `keepInView`, `scrollSettled`,
   `scrollingAncestor`, the slide transition and its `data-reveal-ms`, and the `contents` snippet in
   both apps — hard-won code with measured Chromium timings recorded in its comments, and its tests.

Also state that **the stored file does not change.** No migration, no rewrite, no schema question.

**The glossary entry** defines the Inspector as the docked panel where one Annotation's content is
read and, in the editor, changed. Its `_Avoid_:` line must include **panel** as well as popup, drawer,
sidebar and detail view — `AnnotationPanel` names a component this project has already deleted, and a
returning name that means something else is worse than a new one.

## User Stories

- **68.** As a maintainer, I want the reversal of the row-as-disclosure decision recorded in an ADR, so
  that the reasoning it replaces is not simply contradicted by newer code.
- **70.** As a maintainer, I want "Annotation Inspector" in the glossary, so that the UI and the code
  use one word for it and reviewers can hold us to it.

## Out of scope

- **Any code change at all.** Not a rename, not a comment, not a `data-testid`. This ticket is two
  markdown files.
- **Editing `AnnotationRow.svelte`'s header comment** to point at the new ADR. Tempting, and it belongs
  to ticket 06, which is the ticket that actually changes the component. Editing it here would leave a
  file claiming a behaviour it still has.
- **Amending ADR-0009 or ADR-0034.** Neither is being reversed. The Inspector lives inside ADR-0034's
  boundary rather than changing it, and style still lives on each Annotation.
- Deciding anything the epic's `SPEC.md` has already decided. Where the spec and your instinct differ,
  the spec wins or you stop and ask.

## Acceptance criteria

- [ ] `docs/adr/0035-*.md` exists and contains all four required elements from the Contract, each
      identifiable as its own passage rather than a clause.
- [ ] The ADR names `one-shell-two-apps` ticket 01 and `AnnotationRow.svelte`'s header as the decision
      it reverses.
- [ ] The ADR states that no stored file changes.
- [ ] `CONTEXT.md` has an **Annotation Inspector** entry whose `_Avoid_:` line includes `panel`.
- [ ] `git diff --stat` shows changes confined to `docs/adr/` and `CONTEXT.md`.
- [ ] `pnpm lint` passes — it includes the formatter, and these files are formatted.

```bash
cd /home/dflood/repos/ballastella
ls docs/adr/0035-*.md
grep -n "Annotation Inspector" CONTEXT.md
grep -n "_Avoid_" CONTEXT.md | grep -i panel
git diff --stat
pnpm lint
```

Success: the two files exist, `git diff --stat` names only `docs/adr/` and `CONTEXT.md`, and `pnpm
lint` exits 0.

## Blocked by

None — can start immediately.

This ticket blocks **05** and **06**, the two tickets that perform the reversal. It deliberately does
not block 02, 03 or 04: none of those changes where an Annotation's content is read, so none of them
needs this ADR to exist first.

# An Annotation's content is read beside the map, not inside its row

> **Reverses the decision recorded in [`one-shell-two-apps` ticket
> 01](../../.tracker/one-shell-two-apps/tickets/01-an-annotation-opens-in-its-own-row.md) and argued
> in the header of `packages/ui/src/AnnotationRow.svelte`.** That argument is not wrong. It is
> answered differently here, and this ADR replaces it rather than sitting beside it.

An Annotation's **content** — its title, its rendered description, whatever metadata comes next, and
for an author how it is drawn — is read in a panel docked over the map: the **Annotation Inspector**.
An Annotation's **membership** — that it belongs to a Layer which is shown, hidden, ordered, renamed
and deleted as a group — stays in the Layer stack, where its row becomes a selector that opens
nothing.

## What the row-as-disclosure decision was for

Before that ticket, the editor rendered an Annotation's details as a **sibling of the list**: a box
headed "The west quay" sitting under a list in which "The west quay" was one of four rows, with
nothing joining the two. In a 24 rem column with four Annotations in it, which row the box belonged to
was inferred rather than seen — read off proximity and a repeated string, both of which stop working
the moment the column scrolls.

Putting the details **inside the row** moored them. The row that was open was the Annotation that was
selected; one fact, one place, and the same shape the Layer card one level up already used. That is
what the decision was for, and it worked: it is the only reason the sibling box's ambiguity has not
been a complaint since.

## Why moving the content further away is nevertheless right

The row-as-disclosure decision solved the wrong half of the problem, because the problem was not
where the box was. **Two different claims on an Annotation were being answered in one place, and each
made the other harder to read.** Membership is what a stack of cards is for: a Layer's Annotations
listed inside the Layer they belong to, in the order they are drawn, countable at a glance. Content is
not. A title, a paragraph of prose, and — for an author — some twenty-five controls for how the shape
is drawn do not fit in a 24 rem column that three sibling rows are sharing, and cramming them there
made the list's length a function of how much any one Annotation had to say.

So the stack answers the first claim well and the second badly, and the repair is to stop asking it
the second question. The content goes where there is room for it: beside the map, over the map,
against the thing it is about.

## What moors the panel now that it is not inside the row

This is the load-bearing paragraph, because mooring is the one thing the sibling box never had and the
only reason the reversal is safe. Two mechanisms hold the panel to its Annotation, and neither existed
in the arrangement ticket 01 replaced:

- **The dashed leader.** `LeaderLine` draws from the selected mark on the canvas to its row in the
  stack, and it keeps doing exactly that — `leaderPath` is unchanged and no second leader is drawn to
  the Inspector. The line is what says, on screen and continuously, which mark this selection is
  about.
- **The repeated identity.** The Inspector's own header draws the ordinal from `annotationOrdinal`,
  the glyph from `iconForGeometry` and the name from `annotation-name.ts` — the same three rules the
  row draws from, so an untitled Annotation reads as the same "Untitled shape 3" in the panel as in
  its row and neither can drift from the other. One rule per part, two surfaces. The mark on the
  canvas carries no text of its own; what ties it to both is the leader.

Proximity is therefore not what identifies the panel's subject, which is why the panel no longer has
to be adjacent to be legible. The sibling box was ambiguous because it asserted a relationship it
gave no evidence for; the Inspector names its Annotation the way the row names it, and a line joins
the mark to that row — the two ends the panel is not between.

## What is given up

Hard-won code, with measured Chromium timings recorded in its comments, and the tests that hold it.
Named rather than glossed, because each of these was written for a real defect:

- **`keepInView`**, the rule that brought an opened row's header back into the column when opening it
  had pushed the header off the top.
- **`scrollSettled`**, and the reason it waits for stillness rather than for one `scrollend`: opening
  a half-visible row scrolls the column twice, and the first scroll's `scrollend` lands in or beside
  the click's own task. The measurement behind it — `scrollend` at 47 ms, then a smooth scroll from
  81 ms to 347 ms — dies with the function that needed it.
- **`scrollingAncestor`**, which found the column that actually scrolls, and `keepInView`'s fallback
  to the document for the layout where nothing above the row scrolls on its own.
- **The slide transition and its `data-reveal-ms`**, the 220 ms `cubicOut` reveal and the attribute
  that carried its computed duration out for the reduced-motion test.
- **The `contents` snippet in both apps**, and with it `AnnotationList`'s forwarding of it: the
  editor's Annotation editor and the viewer's reading pane both stop being things a row reveals.

The real loss is `scrollSettled` and the timing knowledge in it. It is accepted because the behaviour
it served is gone rather than broken: nothing opens inside the row, so no row can push its own header
off the screen, and the replacement for keeping the subject visible is the camera reserving the
Inspector's footprint in its padding — a claim about the map, tested against a real one. Code that
nothing renders is worse than code deleted, so this machinery is removed rather than left unreachable.

## The stored file does not change

Nothing about the stored `FeatureCollection` changes. simplestyle properties, `stroke-dasharray`, and
Markdown in `description` are all untouched; style still lives on each Annotation, exactly as
[ADR-0009](./0009-annotations-use-simplestyle-spec.md)'s amendment leaves it. There is no migration,
no rewrite, and no schema question here: a Project written before this change opens after it byte for
byte, and no Project is rewritten because it was opened
([ADR-0010](./0010-integer-format-version-with-forward-only-migrations.md)).

## Where the Inspector lives

Inside [ADR-0034](./0034-a-shared-ui-package-for-the-components-both-apps-render.md)'s boundary rather
than changing it. `AnnotationInspector` joins `packages/ui` beside `AnnotationList`, `AnnotationRow`
and `AnnotationReading`, so the Reader's panel is the author's panel with props withheld — the Style
face is a snippet the viewer does not pass, and the absence of the tab strip falls out of that absence
rather than out of a mode flag.

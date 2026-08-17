# The Annotation Inspector

## Problem Statement

A scholar selects an Annotation and cannot tell which one they selected.

The row they pressed wears a 10% wash on its header strip and nothing else. Directly beneath it, a
bordered box opens carrying — if the Annotation has a title — the same title again in the same weight,
six pixels lower; and if it has no title, the word "Untitled" beneath a row reading "Untitled shape
3". The panel is the innermost of four concentric bordered rectangles between the sidebar's edge and
the words, and the one that immediately contains it is the one that visually detaches it from the row
it belongs to.

Inside that panel, the scholarly content — the reason the tool exists — is one line of text and a
block of prose, and its only affordance is a 14-pixel ghost pencil. Around it are roughly
twenty-five controls for how the shape is drawn: nine fill swatches, nine stroke swatches, three
line styles, three sliders and their readouts. Someone who opened a row to write a sentence is shown
a colour picker. The value hierarchy is inverted, and the same 0.65 rem uppercase treatment marks
three unrelated levels of structure — which Layer this is, how many Annotations are in it, and which
part of the drawing a group of controls is about — so depth is unreadable.

Underneath the visual problem is a structural one. **Two different claims on an Annotation are being
answered in the same place, and each makes the other harder to read.** An Annotation belongs to a
Layer — it is a member of a group that is shown, hidden, ordered, renamed and deleted as a group —
and an Annotation carries content, being a title, a description, whatever metadata comes next, and
for an author how it is drawn. Membership is what a stack of cards is for. Content is not, and it
does not fit in a 24 rem column that three other rows are sharing.

Two further faults compound it. Selection *is* editing, so clicking a mark on the canvas to read an
Annotation forces open an authoring form and scrolls the sidebar. And **New Annotation is a mode
rather than an action**: pressing it hides the whole list, choosing a shape arms a tool, and
finishing the shape leaves the tool armed — so the surface is still in drawing mode with nothing
being drawn, and the list of what is already in the Layer is still out of the way.

The same faults reach a Reader. A published site renders the same rows and reveals the same title
and prose inside them, so a Reader meets the crowding without any of the controls that caused it.

## Solution

**An Annotation's content is read beside the map; its membership is read in the stack.**

The left column keeps the Layer stack exactly as it is: a Layer's kind, its name, whether it is
showing, and inside it the Annotations it holds. An Annotation's row becomes a *selector*. It
carries its ordinal, its shape glyph, its shape word and its name; it wears the Layer's own wash and
a spine in the Layer's own ink when it is the selected one; and **nothing opens inside it**.

The Annotation itself is read in the **Annotation Inspector**: a panel docked to the top-right of the
map pane, drawn *over* the map rather than beside it. It is as wide as a comfortable measure and as
tall as its own content, so the map stays visible below it and beside it — this is the whole
difference between it and a docked sidebar, which would take a column of width permanently whether
anything was selected or not. It is headed by the same ordinal, glyph and shape word the row draws,
from the same one rule, so the canvas, the row and the panel cannot disagree about which Annotation
is which. Dismissing it returns the whole map.

In the editor the Inspector has two faces and a tab strip: **Text**, which is the title, the rendered
description and the controls that change them; and **Style**, which is how the Annotation is drawn.
Text is shown on every selection — the strip has no memory, so selecting another Annotation shows its
words, never the previous one's swatches. Styling is therefore always one deliberate press away and
never simply present, which is what stops a read gesture from producing an authoring surface. It also
matches how styling actually works: a newly drawn Annotation is given the last one's style, so
choosing a colour is an act performed once at the head of a run rather than per Annotation.

In the viewer the Inspector has one face, so there is no tab strip at all — not a disabled Style tab
and not a lone Text tab. A Reader gets the identity header, the title and the rendered description,
and nothing else. **The viewer is the editor with the editing subtracted, and every difference is an
absent callback or an unpassed snippet** rather than a mode flag: the pattern the shared package
already mandates, extended to this surface.

MapLibre's zoom control moves to the bottom-left of every map pane, so it can never be under the
Inspector. Selecting an Annotation reserves the Inspector's footprint in the camera's padding, so the
mark a scholar selected is never hidden behind the panel that describes it.

And **New Annotation becomes an action**. Pressing it offers the three shapes; the list stays where
it is; drawing the shape and finishing it returns everything to rest with the tool disarmed and the
new Annotation selected, its title ready to type. One press of New Annotation, one Annotation.

## User Stories

An author is a scholar using the editor. A Reader meets a Published Site. Where a story says
"either app", the behaviour is the shared component's and is the same in both.

### Reading an Annotation

1. As an author, I want the Annotation I selected to be named in the panel that describes it, so that
   which one I am looking at is never something I have to infer.
2. As an author, I want the panel's ordinal, glyph and shape word to be the same ones its row and its
   mark carry, so that "look at 3" identifies one Annotation across a desk.
3. As an author, I want an untitled Annotation to read as the same "Untitled shape 3" in the panel as
   in its row, so that the two surfaces never contradict each other.
4. As an author, I want the Annotation's title to appear once rather than twice a few pixels apart, so
   that I am not left wondering whether the second one is a different field.
5. As an author, I want the dashed leader to keep running from the mark on the canvas to its row, so
   that the thing I already found legible is not taken away.
6. As an author, I want the description rendered rather than shown as Markdown source, so that what I
   wrote is what I read.
7. As either app's user, I want the selected row marked by more than colour, so that a monochrome
   screen still says which row it is.
8. As either app's user, I want the row's selected state to reach a screen reader, so that "which
   Annotation is active" does not depend on seeing a wash.
9. As an author, I want room enough to read a paragraph of prose, so that a description is not a
   four-line window inside a four-deep stack of boxes.

### The list, and membership

10. As an author, I want an Annotation's row to select it without opening anything, so that the list
    stays the same length however much any one Annotation has to say.
11. As an author, I want the list of Annotations to stay visible while I draw, so that "what is
    already in this Layer" is not hidden exactly when I am adding to it.
12. As either app's user, I want a Layer's Annotations to stay in the Layer's own card, so that
    membership in a group I can show and hide is still what the stack tells me.
13. As either app's user, I want the count of Annotations in the Layer to stay above the list, so that
    an empty Layer and an unread Layer stay distinguishable.
14. As an author, I want deleting an Annotation to renumber the rest, so that the ordinals stay the
    positions they claim to be.

### The Inspector's placement

15. As an author, I want the panel docked over the map rather than beside it, so that the map does not
    lose a column of width permanently for a panel that is often empty.
16. As an author, I want the panel to be as tall as its content and no taller, so that a short
    Annotation does not reserve a screen's height to say two sentences.
17. As an author, I want the map visible below and beside the panel, so that it is still the map there
    rather than a backdrop.
18. As an author, I want the panel never to sit under the zoom control, so that I never have to
    dismiss a panel to zoom.
19. As an author, I want the selected mark to stay out from under the panel, so that the leader ends
    somewhere I can see.
20. As an author, I want to dismiss the panel, so that I can have the whole map back without
    deselecting my place in the list.
21. As an author, I want a long description to scroll inside the panel, so that the panel cannot grow
    over the attribution the Base Map's licence requires.
22. As an author, I want the leader drawn under the panel rather than across it, so that a decoration
    never crosses a control.

### Styling

23. As an author, I want no swatch and no slider on screen until I ask for one, so that selecting an
    Annotation to read it does not put an authoring form in front of me.
24. As an author, I want the Style face beside the map, so that the control and the change it makes
    are in the same glance.
25. As an author, I want the Style face to open on a deliberate press, so that styling is something I
    reach for rather than something I dismiss.
26. As an author, I want the Text face shown every time I select an Annotation, so that the panel
    never opens on the previous Annotation's swatches.
27. As an author, I want a newly drawn Annotation to take the last one's style, so that picking a
    colour once styles the run I am about to draw.
28. As an author, I want an Annotation whose shape this build cannot draw to have no Style face at
    all, so that I am not offered a tab that opens on nothing.
29. As an author, I want the Style face to show what the file says rather than what it inherits, so
    that a control never reports a value from somewhere I cannot see.

### Writing

30. As an author, I want to edit the title and description where I am reading them, so that correcting
    a sentence does not mean finding another surface.
31. As an author, I want to delete an Annotation from the panel that describes it, so that the delete
    is next to the thing it destroys.
32. As an author, I want a delete I regret to be undoable, so that there is a way back without a
    confirmation dialog in the way of every deliberate one.
33. As an author, I want typing to coalesce into one write per file, so that a sentence is one save
    rather than forty.
34. As an author, I want tabbing through a field I did not type in to write nothing, so that reading
    my own Project does not restamp it.
35. As an author, I want the fields to stay open while I type a whole sentence, so that a save landing
    mid-word does not shut them.

### New Annotation as an action

36. As an author, I want New Annotation to offer the three shapes without hiding the list, so that
    starting a new one does not take away the ones I have.
37. As an author, I want finishing a shape to return everything to rest, so that I am never in drawing
    mode with nothing being drawn.
38. As an author, I want the tool disarmed once the shape is finished, so that my next click on the
    map selects rather than draws.
39. As an author, I want one press of New Annotation to make one Annotation, so that the surface's
    state is something I set rather than something I discover.
40. As an author, I want the Annotation I just drew selected with its title ready to type, so that
    titling a shape straight after drawing it is one gesture.
41. As an author, I want to cancel a gesture in progress from the keyboard and from a button, so that
    abandoning a half-drawn shape is not a thing only Escape can do.
42. As an author, I want the tool and the gesture announced as words, so that which tool I am holding
    does not depend on seeing a highlight.

### What a Reader gets, and does not

43. As a Reader, I want a Published Site to look like the tool it was made in, so that I recognise a
    scholar's Project as the thing they built.
44. As a Reader, I want to select an Annotation and read its title and description, so that the
    scholarship is what the site delivers.
45. As a Reader, I want no tab strip at all rather than a lone Text tab, so that I am not shown a
    control that switches between one thing.
46. As a Reader, I want no Style tab, so that I am not offered — or refused — a control that was never
    mine.
47. As a Reader, I want no Edit and no Delete, so that nothing on the page suggests I can change
    somebody's work.
48. As a Reader, I want no drag handle, no reorder, no rename and no Layer delete, so that the stack is
    something I read rather than something I appear able to rearrange.
49. As a Reader, I want no New Annotation and no place lookup, so that a site I opened does not issue
    a request to a third-party service I never asked it to.
50. As a Reader, I want to show and hide a Layer, so that I can look at one thing at a time.
51. As a Reader, I want the same dashed leader from a mark to its row, so that the numbered marks are
    as legible to me as to the author.
52. As a Reader, I want a stranger's description rendered inert, so that opening a Project cannot run
    somebody's script on the site's own origin.

### Keyboard and assistive technology

53. As a keyboard user, I want the row to say that it controls the panel and whether the panel is
    showing, so that the region I opened is announced rather than merely drawn.
54. As a keyboard user, I want one property to carry the selection, so that two properties cannot
    disagree about which Annotation is active.
55. As a keyboard user, I want to reach the panel from the row and get back to the list, so that the
    panel is not a place the keyboard falls into.
56. As a keyboard user, I want focus to land somewhere useful when the panel closes or its Annotation
    is deleted, so that I am not returned to the top of the document past the map's own controls.
57. As a screen-reader user, I want the panel named, so that arriving in it tells me what it is about.
58. As a user who has asked for less motion, I want the panel to arrive rather than travel, so that
    the setting is respected here as everywhere else.
59. As a keyboard user, I want every control in the Style face to be a native element, so that nothing
    here has to be made operable afterwards.

### On a phone

60. As an author on a phone, I want the Project screen to be usable at all, so that a 24 rem sidebar
    does not take the whole window and leave the map nothing.
61. As either app's user on a phone, I want the Inspector as a sheet over the map, so that a panel
    docked to a corner has somewhere to go when there is no corner.
62. As either app's user on a phone, I want no leader drawn, so that a line across a stacked layout is
    not asserting a relationship the layout cannot show.
63. As a Reader on a phone, I want the same subtraction as on a desktop, so that the sheet is not a
    third interface with rules of its own.

### Contributors and maintainers

64. As a contributor, I want the Inspector to be one component both apps render, so that the Reader's
    panel is the author's panel with props withheld rather than a second implementation of it.
65. As a contributor, I want every editor-only control to be an absent callback or an unpassed snippet,
    so that there is no `readOnly` flag that can disagree with the controls it claims to describe.
66. As a contributor, I want the tab strip's absence in the viewer to fall out of the absence rule, so
    that parity needs no case of its own.
67. As a contributor, I want the Inspector's parity provable without a browser, so that "the viewer
    offers none of this" is a test rather than a promise.
68. As a maintainer, I want the reversal of the row-as-disclosure decision recorded in an ADR, so that
    the reasoning it replaces is not simply contradicted by newer code.
69. As a maintainer, I want the disclosure machinery removed rather than left unreachable, so that the
    next reader is not maintaining code nothing renders.
70. As a maintainer, I want "Annotation Inspector" in the glossary, so that the UI and the code use one
    word for it and reviewers can hold us to it.
71. As a contributor, I want each claim asserted at the cheapest seam that can actually fail for the
    reason its title gives, so that the suite does not grow a browser test for what a `<li>` says.
72. As a contributor, I want the sanitiser claim kept in a real browser, so that a DOM implementation
    that returns its input untouched cannot make it vacuously green.
73. As a contributor, I want layout and camera claims kept in a real browser, so that "the map is
    visible below it" is never asserted where there is no viewport.
74. As a contributor, I want no new kind of seam, so that this epic does not pay the cost the suite
    epic exists to stop paying.
75. As a maintainer, I want the stored file untouched by this change, so that a Project written before
    it opens after it with no migration and no rewrite.

## Implementation Decisions

### The word

**Annotation Inspector** — the docked panel where one Annotation's content is read and, in the
editor, changed. It is added to `CONTEXT.md`'s glossary, with the avoid-list: popup, drawer, sidebar,
detail view, and **panel**. `AnnotationPanel` is deliberately not reused: it names a component this
project has already deleted, and a returning name that means something else is worse than a new one.

### The new shared component

`AnnotationInspector` joins `packages/ui`, beside `AnnotationList`, `AnnotationRow` and
`AnnotationReading`. It owns the identity header, the tab strip and the dock; it owns none of what
the faces contain.

```ts
{
  annotation: Annotation;
  /** Its place in the collection, for annotationOrdinal and the untitled fallback's number. */
  index: number;
  /** Dismiss. The selection is the consumer's, so this reports rather than clears. */
  onclose: () => void;
  /** The Text face. Both apps pass AnnotationReading; the editor wraps it in its own controls. */
  text: Snippet<[Annotation, number]>;
  /**
   * The Style face. Absent in the viewer — and its absence is the whole of why a Reader
   * has no tab strip, rather than a case written for a Reader.
   */
  style?: Snippet<[Annotation]>;
}
```

- **The tab strip renders if and only if `style` was passed.** One face is not a choice, so there is
  nothing to switch between and no strip. This is the absence rule doing the work; no `readOnly`,
  `mode` or `showTabs` prop is added anywhere in this epic.
- **The active face is the component's own `$state`, reset to Text whenever a different Annotation
  arrives.** The reset is guarded by comparing `annotation.id` against the last one shown, not by
  reading the object: `annotation` is a fresh object after every save, which is on every keystroke,
  and an unguarded effect would slam the face back to Text mid-sentence. `AnnotationEditor`'s `shown`
  guard is the existing precedent and the existing bug it was written for.
- **The identity header draws `annotationOrdinal(index)` and the shape glyph**, and the title comes
  from `annotationName(annotation, index)` — the same functions the row uses, not wording of its own.
  This is the fix to the "which one is this?" fault and it is the component's, so neither app can get
  it wrong.
- Named for assistive technology by the Annotation it is about. One Inspector is on screen at a time
  — one Layer card open, one row selected — which is what lets its id be a fixed string, the same
  argument `AnnotationList` already makes for its own.

### The row stops being a disclosure

`AnnotationRow` keeps `annotation`, `index`, `open` and `onopen`, and loses `contents`. `open` still
means "this is the selected Annotation" — one fact, one value, unchanged.

- **`aria-expanded` stays, and gains `aria-controls` pointing at the Inspector's id.** `aria-controls`
  does not require containment, so the disclosure semantics survive the region moving across the
  screen. `aria-pressed` is still refused, for the reason already recorded: two properties for one
  fact are two things that can disagree.
- The selection wash moves from the header button to the whole row, with a spine in
  `--layer-kind-ink-annotation` down its left edge. The name still goes semibold, so colour is not
  the only channel.
- **Removed with the disclosure**: the revealed region and its `slide`, `data-reveal-ms`,
  `keepInView`, `scrollSettled`, `scrollingAncestor`, and the `bind:this` on the row's button that
  existed only to feed them. `AnnotationList` loses `contents` and forwards nothing in its place.

### The editor's two faces

`AnnotationEditor` is dissolved rather than moved. Its text half becomes the editor's `text` snippet
— `AnnotationReading` plus *Edit text* and *Delete* — and its style half becomes the `style` snippet,
carrying the Pin, Fill and Line groups, `ColorPicker` and `LineStylePicker` unchanged. Both snippets
are the editor's; the viewer passes `AnnotationReading` for `text` and nothing for `style`.

- **`AnnotationReading` becomes shared by both apps' Text faces.** It is already the viewer's, and its
  two-different-reasons safety note (the title is an interpolation, the description is DOMPurify's
  own output) governs both consumers from one place.
- **Delete lives in the Inspector**, not on the row and not in the Layer card's footer. It acts on the
  Annotation as a thing with content, which is the Inspector's half of the split; putting it in the
  card footer would place two deletes of different scope in one card. It stays undoable and keeps
  having no confirmation dialog (ADR-0014).
- An Annotation whose geometry this build cannot draw is passed **no `style` snippet**, so it has no
  Style tab rather than a Style tab that opens on a sentence explaining its own emptiness.
- Every Style control stays a native element, and the resolved-against-simplestyle rule is unchanged.

### The dock

The Inspector is absolutely positioned inside the map pane's own positioned container:
top-right-inset, a fixed comfortable width capped by `max-width` so it cannot exceed a narrow pane,
and `max-height` leaving the attribution clear, with its body scrolling inside rather than the panel
growing past it.

**`z-index: 7`, and the number is load-bearing.** The leader is 5 and `layout.css` already forces
MapLibre's four control corners to 6 so the leader cannot be drawn across them — that rule exists
because `.maplibregl-map` opens no stacking context, so those numbers are all compared in one place.
7 puts the Inspector one clear of the controls, which is what keeps the leader under it.

- **The leader is unchanged and still runs mark → row.** The row is still where the ordinal lives and
  the left column still does not overlap the canvas, so `leaderPath` answers as it does today. A
  second leader to the Inspector is deliberately not drawn: one Annotation, one line, and
  `leaderPath` would refuse it anyway — the Inspector sits inside the canvas box, and the function
  requires the two boxes not to overlap.
- **Zoom moves to the bottom-left in all three map panes** — the Project screen's Base Map pane, the
  viewer's reader pane, and the alignment route's image pane. The first two must move; the third moves
  for consistency alone, because "zoom is bottom-left in this application" is one thing to learn and
  "bottom-left except on the alignment route" is two. Bottom-left is free in every pane; the editor's
  top-left holds the place lookup and the viewer's is empty.
- **Selecting an Annotation reserves the Inspector's footprint in the camera's padding**, so the
  selected mark is inside the un-occluded region. This is the replacement for the sidebar
  auto-scrolling that goes away with the disclosure, and it is the answer to a mark — and a leader's
  end — hidden behind the panel that describes it.

### New Annotation as an action

- **`Drawing.finish()` returns the tool to `select`.** The rule belongs to the state machine rather
  than to a page handler, so there is one place that says a finished gesture is over. This reverses
  the deliberate stickiness that made three pins three clicks on the map; the cost is accepted, and
  if a drawing run proves painful the repair is a visible *Draw another* control on the Annotation
  just finished, never a tool that stays armed silently.
- **`AnnotationLayerContents` loses the `choosing` branch entirely.** The list is always rendered, so
  the special case that hid it — and the lone captionless `<ol>` that carried the freshly drawn row
  back onto the screen — both stop having anything to do and are deleted. The surface goes from four
  modes to two.
- Pressing New Annotation still deselects, because a new Annotation is not an edit to the old one.
  Finishing selects the drawn Annotation and opens the Inspector on its Text face with the title
  field focused.

### The editor gets a breakpoint

The Project screen has never had one: the sidebar is a fixed 24 rem column with no responsive rule,
so on a phone it takes the window and the map gets nothing. It adopts the **same breakpoint the
viewer already uses**, so both apps stack at the same width and `leaderPath`'s `stacked()` refusal
begins in both at the same place. Below it: the sidebar is a block in a page that scrolls as a whole,
and the Inspector is a bottom sheet over the map, in both apps, with the same subtraction.

### Records

- **A new ADR** states that an Annotation's content is read beside the map rather than inside its row,
  and why. It must replace the reasoning it contradicts rather than sit beside it: the row-as-
  disclosure decision was taken because the details had been a *sibling of the list*, unmoored from
  the row they belonged to, and this design moves them further still. What moors them now is the
  leader and the repeated ordinal, which the sibling panel never had. Written before the first ticket.
- **No schema change.** Nothing about the stored `FeatureCollection` changes; simplestyle,
  `stroke-dasharray`, and Markdown in `description` are all untouched, and no Project is rewritten
  because it was opened.

## Testing Decisions

### What makes a good test here

A test asserts what a user of the surface can observe — what is rendered, what a gesture reports,
what reaches a file — and never how the component reaches it. It must be able to **fail for the
reason its title gives, at the seam it is written at**; a claim asserted one seam below the thing it
is about is the vacuous green this repository's testing decisions exist to prevent. Every claim goes
to the cheapest seam that can genuinely fail, and no claim is deleted in the move.

### The seams, and that there are no new ones

This epic adds **no new kind of seam**. It adds one harness at a seam that already exists.

- **Seam 1 — Node, no DOM.** `annotation-editing.svelte.ts`'s existing test file is the prior art, and
  the drawing state machine's disarm-on-finish rule is asserted here. A second file beside it is a
  file, not a seam.
- **Seam 1c — the component-and-DOM seam.** Vitest in Node against happy-dom, one Svelte component
  rendered under a Harness parent that owns the state the component's gestures change. This is where
  most of this epic's claims live. `packages/ui/src/annotation-list.dom.test.ts` with
  `AnnotationListHarness.svelte` is the pattern to follow, including *why* a component whose
  behaviour depends on its parent updating needs a real parent rather than prop replacement.
- **Seam 2 — Playwright against the built apps.** Real MapLibre, real OPFS, a real static server.
  `e2e/editor-annotations.e2e.ts` and `e2e/viewer-reader.e2e.ts` are the specs this epic touches.
- **The pure-function seam.** `packages/ui/src/leader-line.test.ts` already owns `leaderPath`,
  including its refusal on a stacked layout. This epic changes nothing about the function and adds
  nothing here; the stacked-layout stories are already covered, and the ticket that claims them cites
  that test rather than writing a new one.

### What is asserted at Seam 1c

A new `AnnotationInspectorHarness` is the only new test seam artefact, and it exists for the reason
the other harnesses do: the Inspector reports gestures and waits for the answer as a prop.

- The identity header draws the ordinal, the glyph and the name from the shared rules — and an
  untitled Annotation reads the same in the header as in its row. This is the central fault, and it is
  a rendering claim, so it belongs here rather than in a browser.
- **The tab strip renders with a `style` snippet and does not render without one.** This is the parity
  claim, and it is provable without a browser precisely because the Inspector lives in the shared
  package: the viewer's shape is this component with the snippet withheld.
- Selecting a different Annotation shows Text, even when Style was showing. And the guard: a fresh
  `annotation` object with the *same* id — which is what every keystroke produces — does not reset the
  face. The second half is the one that catches the regression.
- Absent `ontext`/`oncommit` renders no *Edit text*; absent `ondelete` renders no *Delete*; a
  geometry with no `style` snippet has no Style tab. Each guard tests the prop it belongs to.
- The row selects, reports `onopen`, wears the wash, carries `aria-expanded` and an `aria-controls`
  naming the Inspector — and renders **no** revealed region. `annotation-list.dom.test.ts` already
  owns this file's other claims and extends here.
- Reduced motion is read from a real media query against a real `matchMedia`, as
  `annotation-list.dom.test.ts` already does through happy-dom's device settings.

### What stays at Seam 2, and why it cannot move

- **The sanitiser.** DOMPurify answers "supported" against happy-dom and then returns its input
  essentially untouched, so an inertness claim at Seam 1c is green whatever the sanitiser does. Story
  52 stays in `viewer-reader.e2e.ts`, in a real browser against a real published build, and keeps
  asserting that the prose *arrived* before asserting what did not — a blank description passes every
  "is the payload inert?" assertion there is.
- **Every layout claim.** Seam 1c has no layout: no `offsetWidth`, no scroll geometry, no visibility
  derived from paint. So "the map is visible below the panel", "the panel does not grow over the
  attribution", "a long description scrolls inside it", and "the leader is drawn under the panel
  rather than across it" are all Seam 2 or nothing.
- **The camera.** That selecting a mark keeps it clear of the Inspector is a claim about a real
  MapLibre with a real viewport.
- **The control relocation**, in both apps' panes, asserted against the rendered control rather than
  the call that placed it.
- **One write per gesture** (ADR-0017 rule 1), and that tabbing through an untouched field writes
  nothing. Storage is the subject, so storage has to be real.
- **The whole-application shape of the subtraction**: a Published Site offering no Edit, no Delete, no
  drawing tools and no place lookup, asserted against the built viewer. Seam 1c proves the component
  withholds them; Seam 2 proves the app that ships does not pass them.

### Retiring, not deleting

Every Seam 2 test that this epic makes obsolete — the ones driving the row's disclosure, its scroll
behaviour and the panel nested inside it — names its replacement. A ticket that reports a smaller
suite by dropping a claim has moved the cost onto whoever finds the regression.

## Out of Scope

- **Bulk restyle.** *Apply this style to every Annotation in this Layer* is the action ADR-0009's
  amendment says should return, and the Style face is the obvious home for it — but it is a new
  capability, not part of relocating an existing one. It is not built here, and the face is built so
  that adding it later needs no rearrangement.
- **New metadata fields.** The Inspector makes room for source, date, certainty and whatever follows;
  it does not define any of them. What an Annotation carries beyond title and description is a
  separate decision with a schema question attached.
- **Dragging, moving or resizing the Inspector.** It is docked. That is the decision, and it is what
  distinguishes this from the floating variant that was considered and rejected.
- **Selecting more than one Annotation.** One selection remains one value.
- **Footnotes in a description**, already deferred past v1 by ADR-0009.
- **The alignment route's Control Point column and its leader.** Untouched, except that its pane's
  zoom control moves with the others.
- **Any change to the stored file**, to the place lookup, to publishing, or to the Layer card's own
  controls beyond the Annotation list inside it.
- **Reinstating a Layer default style.** Style stays on each Annotation, carried forward when one is
  drawn.

## Further Notes

The design was arrived at by drawing five alternatives and their phone variants and then discarding
four. Two of the rejected ones are worth recording, because the reasons are the reasons this design
is shaped as it is.

**A full-height docked column on the right** was the closest rival. It gives the text the most room
of any option, and it is what "put it in a sidebar" naturally means. It was rejected because it
spends that room permanently: a 24 rem column of chrome on the right, whether anything is selected or
not, and on a 1280 laptop the map falls under half the window. The docked-over-the-map panel buys the
same room and gives it back when the panel is dismissed.

**A floating, draggable inspector** was rejected for the opposite reason: it is the most machinery of
any option — positioning, dismissal, drag, focus containment, and a collision rule against every
existing map overlay — and every one of those is a way to end up somewhere unhelpful. Docking is the
same benefit with none of that.

Worth knowing when reading the tickets: **on a phone all five candidates collapsed into two shapes**,
text in the row or text in a sheet. The phone layout is therefore not what chose the desktop one, and
it should not be allowed to relitigate it.

One asymmetry to expect. The viewer already collapses to a single column below `lg`, with
`LeaderLine` measuring for it, so its sheet is a change to a layout that is already responsive. The
editor's Project screen has no breakpoint at all, so the same story is new work there. Tickets should
not assume the two apps are equidistant from any of this.

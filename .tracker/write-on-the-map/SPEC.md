# Write on the map

## Problem Statement

A scholar can put a Pin where a place is, draw a Line along a route, and draw a Shape around a
parish — and cannot write the word "Zuiderzee" across the water.

Every Annotation this build offers is a mark that points at geography and then says its piece
somewhere else: in its row in the Layer stack, and in the Annotation Inspector when it is selected.
Nothing an author writes is ever *on* the map. So the one thing a historical map does with its own
ink — naming what is there, in the place where it is — is the one thing the tool cannot do.

The workarounds are all worse than the gap. A Pin titled "Zuiderzee" marks a single point in the
middle of a body of water that is not a point, and the title is only readable after a click. A Shape
drawn around the water and titled has the same problem with more work. A scholar teaching from a
published Project has to say "click the third pin" instead of letting a Reader simply read the map.

The absence is felt hardest exactly where the tool is meant to be strongest. An aligned Map Image is
frequently a scan whose own lettering is faded, damaged, in an unfamiliar hand, or in a language the
Reader does not have. Writing the modern name beside the old one is the commonest scholarly act
performed over a georeferenced map, and it is unavailable.

## Solution

**A fourth Annotation: the Label.** A scholar picks *Label* from the drawing tools, clicks a place on
the earth, and types. The words are drawn on the map at that place, in a colour they choose, on a
background colour they choose, at one of three sizes.

A Label is a Point Annotation like a Pin, so everything a Pin already has, it has: it lives in an
Annotation Layer, it is listed in the stack with its own ordinal, it is selected by clicking it on
the map or its row in the list, it is dragged by its vertex handle with the keyboard or the pointer,
it is deleted and undeleted, and it travels in the same `annotations/<layer-id>.geojson`. What
differs is what is drawn for it: its own words instead of a pin.

**Nothing about the file format changes.** A Label is a Point whose simplestyle `marker-symbol` is
`"label"`: what the marker shows at that point is its own title. The words are its `title`, the text
colour is `marker-color`, the background is `fill` and `fill-opacity`, and the three sizes are
`marker-size`, whose values in simplestyle-spec 1.1.0 are already exactly `small`, `medium`, and
`large`. Every field is one simplestyle already defines, so ADR-0009 needs a note recording the
convention rather than an amendment, and a Layer carrying Labels opens in geojson.io or QGIS as
titled markers rather than as something only this app can read.

**The gesture is the one that already exists.** Placing a Label is placing a Pin: one click, and the
Inspector opens with the keyboard in the text field, because a freshly drawn Annotation already
arrives asking to be titled. For a Label that field is not a nicety on the side — it is the
Annotation's content and the thing that draws — so the Text face offers it and nothing else.

**A Label needs the Base Map's typefaces, and a small number of Published Sites do not carry them.**
Sites published by older builds were written without the Base Map's glyphs, and the viewer already
drops every text-drawing layer on such a site rather than firing 404s at files that are not there.
Labels are the first Annotation that would be caught by that, so on those sites they are not drawn
and the notice already on the page says so, in place of its current promise that the Annotations are
unaffected.

## User Stories

An **author** is a scholar working in the editor. A **Reader** meets a Published Site. Where a story
says "either app", the behaviour belongs to a shared module and is the same in both.

### Placing a Label

1. As an author, I want a fourth tool beside Pin, Line and Shape called Label, so that writing on the
   map is something the tool offers rather than something I have to improvise.
2. As an author, I want the Label tool to be reached the same way as the other three — press *New
   Annotation*, then choose — so that there is one way to start an Annotation and not two.
3. As an author, I want placing a Label to take one click, so that it costs what placing a Pin costs.
4. As an author, I want the keyboard to land in the Label's text field the moment it is placed, so
   that clicking and typing is one gesture.
5. As an author, I want the Label tool to put itself down when the Label is placed, so that one press
   of *New Annotation* makes one Annotation, as it already does for the other three shapes.
6. As an author, I want to abandon a Label mid-gesture with Escape or Cancel, so that a misclick is
   not something I have to delete afterwards.
7. As an author, I want the status region to name the Label tool and say what to do with it, so that
   which tool I am holding is not information available only by looking at a highlight.
8. As an author, I want a placed Label announced as added, so that a screen reader tells me the
   gesture completed.
9. As an author, I want to place a Label with the keyboard alone, so that the map pane is operable
   without a pointer, as it already is for every other vertex in this application.

### The words

10. As an author, I want to type the words that are drawn on the map, so that a Label says what I mean
    rather than what a lookup guessed.
11. As an author, I want the field that holds those words to be labelled as the Label's text rather
    than as a title, so that what I am typing and what appears on the map are plainly the same thing.
12. As an author, I want no description control on a Label, so that a surface offering two kinds of
    prose does not make me choose which one draws.
13. As an author, I want a Label that arrived from another tool carrying a description to still show
    that description when I read it, so that opening a stranger's file never hides what is in it.
14. As an author, I want my Label's text to be the name it carries in its row and in the Inspector's
    header, so that the map, the list and the panel cannot disagree about which Annotation is which.
15. As an author, I want a Label with no text yet to be told plainly that it draws nothing until it
    has some, so that an Annotation I placed and did not finish is not silently invisible.
16. As an author, I want editing a Label's text to redraw it on the map as I type, so that I can see
    the words land where I meant them.
17. As an author, I want emptying a Label's text to remove the property rather than write an empty
    string, so that a Label I cleared is not an empty label in somebody else's tool.
18. As an author, I want my Label's text drawn as text and never parsed as markup, so that an
    apostrophe or an angle bracket in a place name is a character rather than a hazard.

### Styling a Label

19. As an author, I want to choose the colour of a Label's text from the same nine colours every other
    Annotation offers, so that a Project has one vocabulary of colour.
20. As an author, I want to choose the colour of the background the text sits on, so that a Label is
    legible over a dark Map Image and over a pale one.
21. As an author, I want to make the background transparent, so that a Label can sit directly on the
    map when that reads better.
22. As an author, I want three text sizes — small, medium and large — so that a regional name and a
    street name can be told apart at a glance.
23. As an author, I want the size control to be the same three-way control the Pin already has, so
    that I learn it once.
24. As an author, I want a Label's Style face to offer only what a Label has, so that I am not shown a
    line-style control for something that has no line.
25. As an author, I want the next Label I draw to carry the last one's colours and size, so that
    styling a run of Labels is a choice made once at the head of it.
26. As an author, I want drawing a Pin after a Label to give me a Pin rather than another Label, so
    that the tool I chose is what I get.
27. As an author, I want a Label's style controls reachable and operable by keyboard, so that styling
    is not a pointer-only act.

### On the map

28. As either app's user, I want a Label's words drawn at the place they belong to, so that the map
    reads as a map rather than as a legend.
29. As either app's user, I want a Label drawn over the Layers below it and under the Layers above it,
    so that the stack's order means the same thing for a Label as for everything else.
30. As either app's user, I want two Labels close together both drawn, so that the application never
    quietly discards one of them for tidiness.
31. As either app's user, I want to click a Label on the map to select it, so that a Label is reached
    the same way a Pin is.
32. As an author, I want the selected Label emphasised on the map, so that the row I opened and the
    thing on the map are visibly the same Annotation.
33. As an author, I want the leader line to run from my selected Label to its row, so that the
    connection I already rely on is not lost for the new kind.
34. As an author, I want to drag a Label to a new place, so that a name put down in the wrong spot is
    moved rather than remade.
35. As an author, I want to nudge a Label's position with the arrow keys, so that fine placement does
    not need a steady hand.
36. As an author, I want moving a Label to cost exactly one write when the gesture ends, so that
    dragging does not thrash the Workspace.
37. As either app's user, I want a Label's background to grow with its words, so that a long name is
    not clipped by a box sized for a short one.
38. As either app's user, I want a Label to keep its size as I zoom, so that it stays readable at every
    scale rather than growing into the map.

### The list, the Inspector, and the rest of the application

39. As either app's user, I want a Label to carry a glyph of its own in its row and in the Inspector's
    header, so that a list of mixed Annotations says what each one is.
40. As either app's user, I want a Label called a "label" in the words beside that glyph, so that the
    glyph is never alone with the meaning.
41. As an author, I want an untitled Label to read as "Untitled label 3", numbered by the same ordinal
    its row and the Inspector draw, so that one Annotation has one number.
42. As an author, I want to delete a Label from the Inspector as I would any other Annotation, so that
    deletion is one act with one place.
43. As an author, I want a deleted Label restored by undo, into the Layer and the position it came
    from, so that undo means the same thing for every kind.
44. As an author, I want a Label to count towards its Layer's Annotation count, so that the number over
    the list is the number of things in it.
45. As an author, I want to hide a Layer and have its Labels go with it, so that visibility is a
    property of the Layer for every kind of Annotation.
46. As an author, I want a Layer's opacity to leave its Labels alone exactly as it leaves its Pins
    alone, so that the control behaves as it already documents.

### The file, and other tools

47. As an author, I want a Label written as an ordinary GeoJSON Point with simplestyle properties, so
    that my Workspace stays a set of files other tools can read.
48. As an author, I want a Layer of Labels opened in geojson.io to show titled markers rather than
    nothing, so that the portability claim holds for the new kind too.
49. As an author, I want a Label written by another tool — a Point carrying the same marker symbol — to
    open here as a Label, so that the convention is a format and not a private flag.
50. As an author, I want a file I only looked at to be byte-identical afterwards, so that opening a
    Project never produces a diff.
51. As an author, I want a Point carrying an unknown marker symbol to stay a Pin and keep that symbol
    when written back, so that this app never destroys something it does not understand.
52. As an author, I want a Label to survive an export and reopen in a Review Workspace, so that sending
    a Project to a colleague sends its Labels with it.
53. As an author, I want a Label to survive a Backup and restore, so that the new kind is not a hole in
    my recovery.

### The Published Site

54. As a Reader, I want a Published Site to draw the author's Labels, so that I read the map they made
    rather than a version with the words removed.
55. As a Reader, I want to click a Label and have its Layer's card open with that Annotation selected,
    so that a Label is a way into the work rather than only decoration.
56. As a Reader, I want a Label's Inspector to show me its words in its header and whatever description
    it carries, and no editing controls at all, so that the viewer stays the editor with the editing
    subtracted.
57. As a Reader, I want Labels to draw at the same size, colour and place they had in the editor, so
    that publishing changes nothing about how the work looks.

### When something is missing

58. As a Reader of a site published without the Base Map's typefaces, I want to be told that the
    author's Labels are not drawn here, so that a missing part of the work is never silent.
59. As a Reader of such a site, I want everything else — the geography, the Map Images, the Pins, the
    Lines and the Shapes — to draw as usual, so that one absent asset does not cost me the Project.
60. As an author, I want the editor always to be able to draw a Label, so that what I author is never
    dependent on an asset the authoring app might not have.
61. As either app's user, I want a Label whose text is empty to draw nothing rather than an empty
    coloured box, so that the map carries no marks nobody made.

### Accessibility

62. As an author using a keyboard alone, I want to reach the Label tool, place a Label, type its text,
    style it and delete it, so that the whole feature is operable without a pointer.
63. As an author using a screen reader, I want the Label tool's button, its status line, and its text
    field all named, so that the feature is not a silent region of the toolbar.
64. As either app's user, I want a Label's row to announce its kind, so that "which of these is a
    Label" does not depend on seeing a glyph.
65. As an author who has asked for reduced motion, I want the Label surfaces to respect that as the
    rest of the application does, so that the setting means one thing everywhere.

## Implementation Decisions

### The word

**Label** is added to `CONTEXT.md`'s glossary: *an Annotation whose content is drawn on the map — a
scholar's own words, set at a place on the earth, in a colour and a size they chose.* The
Annotation entry already lists "a label, pin, route, or shape" among what an Annotation may be, so
this names something the glossary already gestured at. Avoid-list: text, caption, marker, title,
annotation text.

The editor's drawing tool is `'text'` in code only if that is what the existing union forces; the
name the user meets, in the button, the status line and every announcement, is **Label**.

### A Label is a Point whose `marker-symbol` is `label`

The discriminator is a **simplestyle field this build already validates**, not a new extension.
`simpleStyleViolations` accepts `marker-symbol` matching `/^([0-9]|[a-z]|[\w-]{2,})$/`, which
`"label"` satisfies today, so a Layer of Labels is conformant against the existing conformance
instrument with nothing relaxed.

`marker-symbol`'s meaning in simplestyle is *what this marker shows at its point*. "It shows its own
words" is a reading of that field rather than an overload of it, which is the distinction ADR-0009
draws when it forbids overloading `stroke` for line style. **ADR-0009 therefore gains a short section
recording the convention, and no amendment**: no property is added, no property changes meaning, and
the file remains simplestyle-spec 1.1.0 plus `stroke-dasharray`.

The mapping, in full:

| What the author chooses | Stored as |
| --- | --- |
| the words drawn on the map | `title` |
| the colour of those words | `marker-color` |
| the colour behind them | `fill` |
| how solid that background is | `fill-opacity` |
| small / medium / large | `marker-size` |
| that this is a Label at all | `marker-symbol: "label"` |

`title` is chosen for the words over any property of ours because it is the field every other tool
already renders, and because the row and the Inspector header already name an Annotation from
`annotationName` — so a Label reads in the list as the words it draws, with no second wording to keep
in step. The consequence, accepted: "a Label has no title" is true of the *interface*, where the one
field is called the Label's text, and not of the file.

`core`'s annotation module gains the constant and one predicate:

```ts
/** What a Point's `marker-symbol` says when the marker shows its own words. */
export const LABEL_MARKER_SYMBOL = 'label';

/** Whether this Annotation is a Label: a Point that draws its `title` on the map. */
export const isLabel = (annotation: Annotation): boolean => …;
```

`isLabel` is the **one** place the discriminator is read. Nothing else compares `marker-symbol` to a
string literal.

### `marker-symbol` stops being inherited by a newly drawn Annotation

`styleForNewAnnotation` copies every style property off the last Annotation drawn in the Layer, and
`marker-symbol` is in that list. Left alone, drawing a Pin straight after a Label would produce a
second Label — the tool the author chose overridden by the previous Annotation's style.

So `marker-symbol` leaves the copied set, and the creation path writes it: the Label tool writes
`marker-symbol: "label"`, every other tool writes nothing. **The discriminator is decided by the tool
in hand and never inherited.** Colour, size and opacity continue to inherit exactly as they do now,
including across kinds — a scholar who picks red keeps red whatever they draw next, which is the rule
ADR-0009's amendment already chose.

This means a `marker-symbol` from another tool (`"harbor"`, `"7"`) is no longer copied onto the next
Annotation drawn. It is still carried on the Annotation that has it and still written back untouched.

### What is drawn: one symbol layer per Annotation Layer

The renderer gains a `label` bucket beside `fill`, the three `line-*` buckets and `point`. It is a
MapLibre `symbol` layer filtered to Point features whose `marker-symbol` is `label`, and — this is
load-bearing — **the existing `point` bucket's filter gains the negation**, so a Label does not also
draw a Pin.

Its layout and paint read every value off the feature, as every other bucket does:

```
'text-field':  ['get', 'title']
'text-font':   ['Noto Sans Regular']
'text-size':   ['match', ['coalesce', ['get','marker-size'],'medium'], 'small', …, 'large', …, …]
'text-color':  ['get', 'marker-color']
'icon-text-fit': 'both'
'icon-opacity':  ['to-number', ['get','fill-opacity']]
'text-allow-overlap': true, 'icon-allow-overlap': true, 'text-ignore-placement': true
```

`text-allow-overlap` follows the Pin's own rule and the reason recorded beside it: two Annotations
near each other are two claims a scholar made, and MapLibre's default is to drop one. Silent loss of
somebody's work is not decluttering.

`text-font` is a stack the bundled glyphs carry; `Noto Sans Regular`, `Noto Sans Medium` and `Noto
Sans Italic` are what is written with every Published Site.

An Annotation whose `title` is absent or empty produces no `text-field` and MapLibre draws nothing —
which is story 61's behaviour reached by the renderer's own semantics rather than by a filter written
for it.

### The background chip

The background is an image behind the text, sized to the text by `icon-text-fit`. **A stretchable SDF
rounded rectangle, coloured per feature by `icon-color`**, mirroring the Pin exactly: one image
registered by an `ensure…` helper on every stack build, because a theme change calls `setStyle` and
discards every registered image. Selection emphasis is then the Pin's own — `icon-halo-color` from
the feature's `stroke`, `icon-halo-width` raised while selected — so the selected Label is drawn
exactly as the file asks with an aura around it, never recoloured.

Corner geometry is preserved by the stretch zones rather than by luck: `content`, `stretchX` and
`stretchY` confine stretching to the flat edges, where a distance field is linear along the stretch
axis, and leave the corners at their own aspect.

**This is the one part of the epic that must be proved in a browser before it is built on**, and
ticket 01 does exactly that and nothing else. If a stretched SDF renders with distorted corners or
refuses `icon-color`, the contingency is named here rather than invented later:

> **Contingency.** Drop SDF. Register one plain RGBA rounded rectangle **per distinct background
> colour present in the Layer**, keyed `ballastella-label-bg-<hex>`, registered from the collection
> both at stack build and inside `setAnnotations` — so a colour chosen after the layer was added has
> its image before the data reaches the source. `icon-image` then reads
> `['concat', 'ballastella-label-bg-', ['get','fill']]`, and `icon-opacity` carries `fill-opacity`.
> The cost is that `icon-color` and `icon-halo-*` are SDF-only, so the selected Label is emphasised by
> `text-halo-color`/`text-halo-width` in its own `stroke` instead. The palette is closed at nine
> colours and a foreign file's tenth is registered on demand, so nothing is capped.

### Where a Label is, for everything that points at it

`annotationAnchor` already answers a Point with its own coordinate and needs no change. The screen
box a leader line aims at currently gives a Point the pin's extent, anchored at its tip — which is
wrong for a Label, which is centred on its coordinate and has no pin. **A Label's box is its anchor
point**, like a Line's and a Shape's: the leader ends on the drawing itself. This is the second place
`isLabel` is read.

### What the structure key knows

`whatItContains` gains `hasLabel`, and `hasPoint` narrows to "a Point that is not a Label", so a
Layer of Labels alone pays for no pin layer and a Layer of Pins alone pays for no symbol layer.
`annotationDrawKey` gains the bucket, so the first Label drawn in a Layer rebuilds the stack once and
every subsequent edit to it goes through `setAnnotations`. `annotationLayerIds` gains the bucket too,
which is what makes a Label clickable in both apps — hit-testing is by layer id and a bucket absent
from that list is a mark nobody can select.

### Glyphs, and the sites that have none

The viewer strips `glyphs` and drops every `symbol` layer on a Published Site that does not carry the
Base Map's display assets, and on a site with no Base Map at all it builds a bare style with no
`glyphs` at all. Both paths carry a comment asserting that nothing the Layer stack draws needs them;
Labels make that false.

- The stack asks the map whether the style carries glyphs, and **omits the Label bucket when it does
  not**. Nothing else about the Layer changes: its Pins, Lines and Shapes draw as before.
- `baseMapNotPublishedNotice` gains the Labels to its sentence. Its current promise — "The Map Images
  and the Annotations are not affected" — becomes false the day this ships, and a false reassurance is
  worse than the absence it describes.
- The bare-style branch's comment is corrected in the same change.
- The editor is unaffected: it always builds the full style, glyphs included, from the assets in its
  own `static/`. Story 60 is a property of that and is asserted rather than assumed.

New publishes have carried the display assets since ADR-0025; this is a legacy-site path only.

### The editor's surfaces

- **The drawing state machine** gains a fourth tool: one minimum vertex, the user-facing name
  *Label*, and the Pin's own status wording — the gesture is a click, so the sentences are the same.
  Its glyph joins the shared icon table, which is typed such that a tool added in the editor and not
  in the table fails to compile.
- **The shape word and the glyph become questions about the Annotation, not about its geometry.**
  `shapeWord` already takes the whole Annotation; the icon lookup does not, and is changed to match.
  Both then read `isLabel` and cannot disagree. This is the third and last place the discriminator is
  read outside `core`.
- **The Style face** shows, for a Label, one group: the text colour, the background colour, the
  background opacity, and the three sizes. No line group, no line style, no stroke width. The
  controls are the ones already built — the colour picker and the size radio group — regrouped by
  which part of the Label they are about, which is how the face is already organised.
- **The Text face** shows, for a Label, the text field alone, captioned as the Label's text. No
  description control and no *Edit text* gate around a single field whose contents are the drawing. A
  description already in the file is still rendered at rest and still written back, so nothing a
  stranger's file carries is hidden or dropped.
- **An empty Label says so.** While a Label's text is empty, the Text face carries a plain sentence
  that it draws nothing until it has some. It is text in the face, not a tooltip and not a toast.
- Writes keep ADR-0017's rules unchanged: typing is coalesced into one write per file, a placement is
  one write, and a drag or a held arrow key is one write on gesture end.

### The viewer's surfaces

No new component and no new prop. The Inspector's Text face in the viewer is already the description
alone, which renders nothing when there is none — so a Reader selecting a Label meets the identity
header carrying its words and an empty face, by the same code path an undescribed Pin already takes.
The viewer's difference from the editor remains an unpassed snippet.

## Testing Decisions

### What makes a good test here

A test asserts what a user of the surface can observe — what is rendered, what a gesture reports,
what reaches a file — and never how the code got there. It must be able to **fail for the reason its
title gives, at the seam it is written at**. Every claim goes to the cheapest seam that can genuinely
fail it, and a claim moved down a seam is never a claim deleted.

The rule that decides most placements in this epic: **a claim about a MapLibre style is not a claim
about what was drawn.** Asserting that a layer exists with a `text-field` expression is worth having
and is not evidence that words appeared on a map; asserting that `queryRenderedFeatures` at the point
a Label was placed returns that Label out of the Label bucket is.

### The seams, and that there are no new ones

This epic adds **no new kind of seam**. CONTRIBUTING is binding: an in-memory `ProjectStore` for
application logic, and Playwright against headless Chromium for the running app, with the
component-and-DOM seam in between where a component's own rendering is the subject.

- **Seam 1 — Node, no DOM.** `packages/core`'s annotation and render tests, and the editor's drawing
  state machine test. Prior art: `annotation.test.ts`, `stack-layers.test.ts`, `drawing.svelte.test.ts`.
- **Seam 1c — component and DOM.** Vitest against happy-dom, one component under a Harness parent
  that owns the state its gestures change. Prior art: `annotation-style-face.dom.test.ts`,
  `annotation-text-face.dom.test.ts`, `annotation-tools.dom.test.ts`, `annotation-inspector.dom.test.ts`.
- **Seam 2 — Playwright against the built apps.** Real MapLibre, real OPFS, a real static server.
  Prior art: `editor-annotations.e2e.ts` with its `e2e/support/annotations.ts` driving, and
  `viewer-reader.e2e.ts`.

### What is asserted at Seam 1

- `isLabel` answers for a Point with the symbol, and refuses a Point without one, a Point carrying a
  *different* symbol, a Line, a Shape, and a foreign geometry.
- A Label round-trips byte-identically: parse a Layer containing one and serialise it back unchanged.
  This extends the round-trip claim `annotation.test.ts` already owns rather than adding a new one.
- `simpleStyleViolations` reports nothing for a Label's properties. This is the whole of the "no new
  extension" claim and it is checkable in one assertion, which is why the discriminator was chosen to
  make it so.
- `styleForNewAnnotation` does not copy `marker-symbol` — asserted from a Label (the next Annotation
  is not a Label) and from a foreign symbol (`"harbor"` is not propagated) — while colour, opacity and
  size still are.
- `toRenderCollection` carries `marker-symbol` onto the render copy, since the layer filter reads it.
- `whatItContains`/`annotationDrawKey`: a Layer of Labels asks for the Label bucket and **not** the
  point bucket; a Layer of Pins asks for the point bucket and not the Label bucket; a Layer with both
  asks for both. And the key **does not change** when a Label's text, colour or size changes — the
  regression this key exists to prevent, already asserted for the other kinds.
- `annotationLayerIds` includes the Label bucket, so a Label is hit-testable.
- The mark box for a Label is its anchor point, not a pin-sized box.
- The drawing state machine: the Label tool finishes on one vertex, disarms itself, and reports the
  geometry — the Pin's own assertions, extended.

### What is asserted at Seam 1c

- The toolbar offers four shapes, the fourth named *Label*, pressed state and all, and reports the
  tool it was given.
- The Style face for a Label renders the text colour, the background colour, the background opacity
  and the three sizes — and renders **no** line-style control and no stroke width. The negative half
  is the one that catches a face that simply showed everything.
- Choosing a size and choosing a colour report the exact simplestyle property names. A control writing
  `markerSize` or a hex without its `#` is what this catches.
- The Text face for a Label renders one field, captioned as the Label's text, and **no** description
  control; and it renders a description that is present in the Annotation.
- The empty-Label sentence appears while the text is empty and goes when it is not.
- The row and the Inspector header call a Label a "label" and draw its own glyph, and an untitled one
  reads as "Untitled label 3" in both — asserted in the shared package, so neither app can differ.

### What stays at Seam 2, and why it cannot move

- **That a Label is drawn at all.** happy-dom has no MapLibre, no glyphs and no canvas: every claim
  about words appearing on a map is Seam 2 or nothing. `editor-annotations.e2e.ts` places a Label,
  types its text, and asserts `queryRenderedFeatures` at the placed point returns it from the Label
  bucket with the expected properties — the pattern that file already uses for Pins.
- **That a Pin drawn after a Label is a Pin**, asserted on the map and in the written file. This is
  the inheritance carve-out's real consequence and it is worth a browser.
- **That an empty Label draws nothing and a filled one draws**, asserted as a transition rather than
  as two states, because "it drew after I typed" is the claim.
- **One write per gesture** (ADR-0017 rule 1), through `ballastellaAnnotationWrites`: placing is one,
  dragging is one on gesture end, typing coalesces. Storage is the subject, so storage is real.
- **The file on disk.** After placing and titling a Label, the Layer's GeoJSON carries a Point with
  `marker-symbol: "label"` and the title, read back out of OPFS — the product is the user's folder.
- **Selecting a Label** by clicking it on the map, and the leader line reaching it.
- **The Published Site draws Labels**, in `viewer-reader.e2e.ts`, against a real published build.
- **A site without display assets draws no Labels and says so**, and its Pins, Lines and Shapes still
  draw. The notice's new sentence is asserted as rendered text.
- **Export/reopen and Backup/restore carry a Label**, extending the existing transfer specs rather
  than adding one.

### Retiring nothing

No existing test is made obsolete by this epic. Any that a ticket believes is obsolete names its
replacement before removing it.

## Out of Scope

- **A description on a Label.** The field is not offered. One already in a file is preserved and
  rendered, and nothing here forecloses adding the control later.
- **Rotated, curved, or along-a-line text.** A Label is set horizontally at a point. Naming a river
  along its course is a real want and a different feature.
- **A font or typeface choice.** One stack, the one the Base Map's glyphs carry.
- **Free numeric text size.** Three sizes, because simplestyle names three and because a slider here
  would be the only continuous control on a surface built out of nameable choices.
- **Collision-aware placement and automatic decluttering.** Every Label draws, always, per the rule
  the Pin already follows.
- **A Label attached to a Line or a Shape** — naming an existing Annotation by drawing its title on
  the map. A Label is its own Annotation at its own point.
- **Rescuing legacy Published Sites.** Sites published without display assets do not gain them; they
  gain an honest sentence.
- **Bulk restyling.** Applying one Label's style to every Label in a Layer is the action ADR-0009's
  amendment says should return, and it returns for every kind at once or not at all.
- **A Label's own leader line to what it names.**
- **Migrating anything.** No existing Project changes, and no file is rewritten because it was opened.

## Further Notes

**Why not a namespaced property.** `ballastella:label` was the obvious discriminator and would have
been a second extension to ADR-0009, an ADR amendment, a new branch in the conformance instrument,
and a property no other tool can read. `marker-symbol` costs none of those and degrades better: a
Layer of Labels in geojson.io is titled markers rather than markers carrying a private flag.

**Why the words are `title`.** The alternative was a `text` property of our own, and it fails on the
surface a scholar actually looks at: the row and the Inspector header name an Annotation from
`annotationName`, so a Label with a separate text property would read "Untitled label 4" in the list
while saying "Zuiderzee" on the map. One Annotation, one name.

**The background chip is the only genuine unknown**, and ticket 01 exists to remove it before
anything is built on top of it. Everything else in this epic is a fourth entry in tables that already
have three.

**What this does not settle.** ADR-0005 says all drawing goes through `terra-draw`, and this is the
fourth slice to decline it. Nothing changes: a Label is placed by the same click that places a Pin, on
the same overlay-point seam that gives every vertex a named button and arrow-key movement. The
disagreement between the ADR and the code remains recorded for a human rather than settled here.

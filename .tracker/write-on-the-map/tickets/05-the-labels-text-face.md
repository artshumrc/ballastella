# The Label's Text face

## Parent

[SPEC.md](../SPEC.md) — "The editor's surfaces", the Text face paragraph and the empty-Label
sentence.

## What to build

The Annotation Inspector's Text face, when the selected Annotation is a Label, is one field holding
the words that draw on the map — captioned as the Label's text, not as a title — and nothing else.

No description control, because a Label's content is what is on the map and a second kind of prose
would make an author choose which one draws.

While that field is empty, the face says plainly that this Label draws nothing until it has words, so
that an Annotation placed and not finished is never silently invisible.

A description that a stranger's file already carries is still rendered when the Label is read, and
still written back untouched — nothing in a file is hidden because this app offers no control for it.

## Where to start

- `apps/editor/src/lib/annotations/AnnotationTextFace.svelte` — read the header first. Three rules
  live there and all three matter here: the face is **text until somebody asks to change it**; the
  face must **not draw the title**, because the Inspector's identity header above it already does; and
  the `shown` guard exists because `annotation` is a fresh object after every save, which is on every
  keystroke.
- `apps/editor/src/lib/annotations/annotation-text-face.dom.test.ts` and
  `AnnotationTextFaceHarness.svelte` — the seam and the harness this extends.
- `packages/ui/src/AnnotationDescription.svelte` — the package's one `{@html}`, fed nothing but
  DOMPurify's output. Used as-is; not modified.
- `packages/core/src/annotation/annotation.ts` — `setText`, and why an empty string **removes** the
  property rather than writing `""`.
- `packages/ui/src/AnnotationInspector.svelte` — the identity header that already names the
  Annotation, so nothing here draws the words a second time.

## Contract

**One field, and the *Edit text* gate does not apply to it.** For a Pin the face is prose to read,
with a pencil to turn it into a form. For a Label the single field *is* the Annotation's content and
the thing that draws, so it is a field on arrival — which is also what makes ticket 03's "click and
type" one gesture rather than "click, press Edit, type".

The identity header still owns the name. The field is labelled for what it does — the Label's text —
and the header above it keeps drawing `annotationName`. That is one title on screen, in a field, which
is the rule the header's own note states.

**No description control for a Label**, and a description that exists is still rendered at rest
through `AnnotationDescription`. So:

```
a Label with no description        →  the field, and nothing below it
a Label with a description         →  the field, and the rendered description below it, read-only
a Pin / Line / Shape               →  unchanged in every respect
```

**Clearing the field removes the property.** `setText` already does this; the criterion is that a
Label whose words are deleted leaves no `"title": ""` in the file.

**The empty-Label sentence** is ordinary text inside the face, associated with the field so it reaches
a screen reader. Not a tooltip, not a toast, not a `title` attribute — CONTRIBUTING is explicit that a
tooltip is not an information channel. It is present exactly while the words are empty.

**The `shown` guard is not to be disturbed.** Comparing `annotation.id` — never the object — is what
stops every keystroke's save from resetting the face mid-sentence. If a new derived value is added
here, it reads the id.

**No new motion.** A Label adds no transition of its own; the Inspector's existing arrival is what a
Label gets, including its zero duration under reduced motion.

## User Stories

11. As an author, I want the field that holds those words to be labelled as the Label's text rather
    than as a title, so that what I am typing and what appears on the map are plainly the same thing.
12. As an author, I want no description control on a Label, so that a surface offering two kinds of
    prose does not make me choose which one draws.
13. As an author, I want a Label that arrived from another tool carrying a description to still show
    that description when I read it, so that opening a stranger's file never hides what is in it.
15. As an author, I want a Label with no text yet to be told plainly that it draws nothing until it
    has some, so that an Annotation I placed and did not finish is not silently invisible.
17. As an author, I want emptying a Label's text to remove the property rather than write an empty
    string, so that a Label I cleared is not an empty label in somebody else's tool.
65. As an author who has asked for reduced motion, I want the Label surfaces to respect that as the
    rest of the application does, so that the setting means one thing everywhere.

## Out of scope

- **The Style face.** Ticket 04.
- **The viewer's Text face.** It is already the description alone and renders nothing when there is
  none, so a Reader selecting a Label needs no change. Ticket 08 asserts that; do not add a case for
  it here.
- **Markdown in a Label's words.** The field is plain text drawn on a map; it is not rendered as
  Markdown anywhere and no sanitiser is involved in it.
- **Adding a description control back for Labels later.** Out of scope by decision, not by oversight.
- **Touching the Pin/Line/Shape path through this face.** The *Edit text* gate, the pencil, the
  textarea and the delete button stay exactly as they are for every other kind.
- **The delete button.** It stays where it is and works for a Label already; ticket 06 asserts it.

## Acceptance criteria

- [ ] With a Label selected, the face renders one field captioned as the Label's text, and renders
      **no** description control and no *Edit text* button.
- [ ] With a Label carrying a description, that description is rendered below the field.
- [ ] With a Pin, a Line or a Shape selected, the face is byte-for-byte the surface it is today —
      asserted, not assumed.
- [ ] The empty-Label sentence is present while the field is empty and absent once it has words, and
      is associated with the field for assistive technology.
- [ ] Typing in the field reports the text through the existing `ontext` path, coalesced.
- [ ] Clearing the field produces an Annotation with no `title` property at all.
- [ ] A fresh `annotation` object carrying the **same** id does not reset the face — the guard that
      catches the every-keystroke regression.
- [ ] With reduced motion asked for, the Inspector's reveal duration reads zero with a Label selected.
- [ ] In a browser: placing a Label lands the keyboard in the field, and typing draws the words.

```bash
pnpm --filter @ballastella/editor exec vitest run -t "text face"
pnpm test:e2e editor-annotations
pnpm precommit
```

Success: all green, with both halves — the field present, the description control absent — named in
the `text face` output.

## Blocked by

- Ticket 03 — a Label has to be creatable before its Text face can be driven.

# 05 — The Annotation Inspector, proved at the component seam

## What to build

`AnnotationInspector` in `packages/ui`, with a harness and a component-seam test file — and **no app
renders it yet**. Ticket 06 wires it into the editor; ticket 08 wires it into the viewer.

This is not a horizontal slice dressed up. The thing this epic promises is that *the Reader's panel is
the author's panel with props withheld*, and the seam where that is provable in milliseconds is this
one. `apps/viewer` has no unit tests at all, so if the parity claim is not asserted here it can only be
asserted against a built browser — and the epic's whole cost argument says it should not have to be.
The deliverable is the component **and the proof that its absences are load-bearing**.

## Where to start

- `packages/ui/src/AnnotationListHarness.svelte` — the pattern for the harness, and read its header:
  a component that reports a gesture and waits for the answer as a prop needs a **real parent**, not
  prop replacement from the test body, or the test asserts its own assignment and stays green when the
  component stops reporting.
- `packages/ui/src/annotation-list.dom.test.ts` — the pattern for the tests, including how happy-dom's
  `settings.device` is used to answer a real `prefers-reduced-motion` media query rather than stubbing
  Svelte's signal. Its header also states what must **not** be asserted here and why.
- `packages/ui/src/AnnotationReading.svelte` — the Text face's content in both apps. Read its header
  carefully: the title is safe because it is a Svelte interpolation and the description is safe because
  it is `renderDescription`'s output. Those are two different reasons and neither may be swapped for the
  other.
- `packages/ui/src/annotation-name.ts` (`annotationName`, `shapeWord`), `packages/ui/src/shape-icons.ts`
  (`iconForGeometry`), and `annotationOrdinal` from `@ballastella/core` — the three rules the header
  must draw from rather than inventing wording.
- `apps/editor/src/lib/annotations/AnnotationEditor.svelte` — specifically the `shown` guard and the
  comment above it. That guard is the precedent for this component's face reset, and the comment records
  the exact bug it was written for: `annotation` is a fresh object after every save, which is on every
  keystroke, so an unguarded effect slammed the fields shut mid-sentence and a `fill()` in the suite
  landed on a field that no longer existed.
- `packages/ui/vitest.config.ts` — one project, `name: 'ui'`, `environment: 'happy-dom'`,
  `include: ['src/**/*.test.ts']`. No `--project` flag needed.
- `packages/ui/src/index.ts` — the package's exports.
- `.tracker/the-suite-runs-in-three-minutes/SPEC.md`, the *Implementation Decisions* section — the
  written boundary of this seam and its three recorded fidelity limits.

## Contract

```ts
{
  annotation: Annotation;
  /** Its place in the collection, for annotationOrdinal and the untitled fallback's number. */
  index: number;
  /** Dismiss. The selection belongs to the consumer, so this reports rather than clears. */
  onclose: () => void;
  /** The Text face. Both apps pass AnnotationReading; the editor wraps it in its own controls. */
  text: Snippet<[Annotation, number]>;
  /**
   * The Style face. Absent in the viewer — and its absence is the whole of why a Reader has no
   * tab strip, rather than a case written for a Reader.
   */
  style?: Snippet<[Annotation]>;
}
```

- **The tab strip renders if and only if `style` was passed.** One face is not a choice, so with one
  face there is no strip — not a disabled Style tab, and not a lone Text tab. **Do not add a
  `readOnly`, `mode`, or `showTabs` prop.** Absence is the mechanism, and a flag beside it is a second
  description of the same thing that can disagree with the first.
- **The active face is this component's own `$state`, and it resets to Text whenever a different
  Annotation arrives.** The reset is guarded by comparing `annotation.id` against the last id shown —
  **not** by reading the object, for the reason `AnnotationEditor`'s `shown` guard records. A fresh
  object with the *same* id must not reset the face; that is the half of this that catches the
  regression, and it must have its own test.
- **The identity header draws `annotationOrdinal(index)`, `iconForGeometry(annotation.geometry?.type)`
  and `shapeWord(annotation)`**, and its title comes from `annotationName(annotation, index)`. No
  wording of its own, and no second "Untitled" — this is the fix to the epic's central fault, and it
  lives in the component so neither app can get it wrong.
- **The glyph is never alone with meaning.** The shape word sits beside it, as it does in the row.
- **The Inspector is named for assistive technology by the Annotation it is about.** One Inspector is on
  screen at a time — one Layer card open, one row selected — which is what makes a fixed id safe here,
  the same argument `AnnotationList` already makes for its own.
- **`onclose` reports; it does not clear.** The selection lives in the consumer's state.
- If the Inspector animates in, the duration is zero under `prefers-reduced-motion: reduce`, and the
  computed number is **written out as a `data-` attribute**. happy-dom implements no Web Animations API,
  so a transition itself is invisible at this seam; the attribute is the only way the branch is
  assertable, and it is the trick `AnnotationRow`'s `data-reveal-ms` already uses for exactly this.
- **The component ships in `packages/ui` and is exported from its index.** Nothing in `packages/ui` may
  import from `apps/` — no `$lib`, no `$app/*`; `pnpm lint` enforces it.
- **This ticket adds no `terra-draw` or tiler dependency**, directly or transitively. The viewer reaches
  this package, and `pnpm lint` fails the build if either appears.

## User Stories

- **6.** As an author, I want the description rendered rather than shown as Markdown source, so that
  what I wrote is what I read.
- **57.** As a screen-reader user, I want the panel named, so that arriving in it tells me what it is
  about.
- **58.** As a user who has asked for less motion, I want the panel to arrive rather than travel, so
  that the setting is respected here as everywhere else.
- **65.** As a contributor, I want every editor-only control to be an absent callback or an unpassed
  snippet, so that there is no `readOnly` flag that can disagree with the controls it claims to
  describe.
- **66.** As a contributor, I want the tab strip's absence in the viewer to fall out of the absence
  rule, so that parity needs no case of its own.
- **67.** As a contributor, I want the Inspector's parity provable without a browser, so that "the
  viewer offers none of this" is a test rather than a promise.
- **71.** As a contributor, I want each claim asserted at the cheapest seam that can actually fail for
  the reason its title gives, so that the suite does not grow a browser test for what a `<li>` says.
- **72.** As a contributor, I want the sanitiser claim kept in a real browser, so that a DOM
  implementation that returns its input untouched cannot make it vacuously green.
- **74.** As a contributor, I want no new kind of seam, so that this epic does not pay the cost the suite
  epic exists to stop paying.

Story 6 is delivered here in the sense the seam can carry: that the Text face renders
`AnnotationReading`'s **rendered** output rather than the Markdown source. Stories 71, 72 and 74 are
delivered by this file's header stating the boundary for this surface and by the test file containing no
sanitiser assertion — see *Out of scope*.

## Out of scope

- **Rendering the Inspector in either app.** Tickets 06 and 08. This ticket ends with a component, a
  harness, and a green `ui` project.
- ⚠ **Any assertion about a stranger's `description` being inert.** DOMPurify answers "supported"
  against happy-dom and then returns its input essentially untouched, so a sanitiser claim here is green
  whatever the sanitiser does. That claim lives in `e2e/viewer-reader.e2e.ts`. Write a comment in the
  test file saying so, as `annotation-list.dom.test.ts` already does — the absence has to be deliberate
  and legible, or someone adds it in good faith later.
- **Any layout assertion**: no `offsetWidth`, no scroll geometry, no "the map is visible below it", no
  "it does not overlap the attribution". This seam has no layout. Ticket 07 owns those, at Seam 2.
- **The dock's positioning, `z-index`, `max-height`, or the camera.** The component must not position
  itself; where it sits is the consumer's, and ticket 06 decides it. Do not add `position: absolute`
  here.
- **Promoting anything to a browser-mode component project** when happy-dom falls short. The answer is
  Seam 2, never a browser with a fake attached.
- **Changing `AnnotationRow`, `AnnotationList`, or `AnnotationReading`.** The Inspector composes
  `AnnotationReading` through a consumer's snippet; it does not import it as its content, because what
  the Text face holds differs between the apps.
- Deleting anything. The disclosure is still live in both apps until tickets 06 and 08.

## Acceptance criteria

- [ ] `AnnotationInspector.svelte` and `AnnotationInspectorHarness.svelte` exist in `packages/ui/src`,
      and the component is exported from the package index. The harness is not exported.
- [ ] With a `style` snippet, a tab strip renders with two faces. Without one, **no tab strip element
      exists in the DOM at all** — asserted as absence, not as a hidden or disabled control.
- [ ] Text is the showing face on first render, and after a *different* Annotation arrives while Style
      was showing.
- [ ] A fresh `annotation` object carrying the **same** id does not reset the face away from Style.
- [ ] The identity header renders the ordinal, the glyph and the shape word; an untitled Annotation's
      title reads exactly what `annotationName(annotation, index)` returns for the same index.
- [ ] The header renders no second "Untitled" and no wording not produced by the shared name rules.
- [ ] `onclose` is called when the dismiss control is pressed, and the component does not change its own
      state in response.
- [ ] The Inspector carries an accessible name naming the Annotation.
- [ ] The reduced-motion branch is asserted through the written-out attribute, driven by happy-dom's
      device settings, with the setting restored afterwards.
- [ ] Every test has been watched to fail once against a deliberate break; the breaks are named in the
      commit message.
- [ ] The test file's header states what is **not** asserted at this seam and why — the sanitiser, and
      layout.
- [ ] `grep -rn "readOnly\|showTabs" packages/ui/src` returns nothing.
- [ ] `pnpm precommit lint check test` passes. `pnpm lint` includes the shared-package import fence and
      the viewer-dependency fence; both must be green.
- [ ] The `ui` project still runs with **no browser process**.

```bash
cd /home/dflood/repos/ballastella
pnpm --filter @ballastella/ui exec vitest run annotation-inspector
pnpm --filter @ballastella/ui test
grep -rn "readOnly\|showTabs" packages/ui/src || echo "clean"
grep -rn "\$lib\|\$app/" packages/ui/src || echo "clean"
pnpm precommit lint check test
```

Success: both greps print `clean`, the `ui` project is green with the new file and starts no browser,
and `precommit lint check test` exits 0.

## Blocked by

- 01

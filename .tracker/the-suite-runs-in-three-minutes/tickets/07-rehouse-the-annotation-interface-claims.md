# 07 — Rehouse the Annotation interface claims to the component seam

## What to build

The other half of `editor-annotations.e2e.ts`: the claims about what the Annotation interface *shows and does*, as opposed to what it writes. Rehouse them to the component seam ticket 02 built, and retire the Seam 2 tests they replace.

Candidates, each to be judged against the boundary rather than assumed:

- the nine colours each named and legibly ticked, and only those nine offered;
- a pin offering marker controls and no line or fill controls;
- the selected row wearing the Layer's own wash rather than a rule of its own;
- "New Annotation" closing the Annotation that was open;
- a newly drawn Annotation being selected, and its row toggling the selection;
- the title and description fields staying open while a whole sentence is typed;
- the description reading as rendered Markdown rather than as source;
- a Project with no Annotation Layer saying so beside the button that fixes it;
- the drawing tools being announced as they are chosen.

## Where to start

- `e2e/editor-annotations.e2e.ts` — the describe blocks "drawing (SPEC stories 57, 58, 59)", "title and description (SPEC stories 62 and 67)", and "drawing into the Layer that is open (ticket 05)".
- `apps/editor/src/lib/annotations/` — the components, and `annotation-editing.svelte.ts`, whose whole dependency on the application is four methods (`AnnotationWriter`). It already has a Node test; the state claims may belong there rather than in a rendered component at all, which is cheaper still.
- `apps/editor/src/lib/layers/layer-list.dom.test.ts` and its parent harness (ticket 02) — the pattern to follow, including why a component whose behaviour depends on its parent updating needs a real parent rather than prop replacement.
- `apps/editor/vitest.config.ts` — the recorded divergences of the DOM implementation. Read them before assuming a focus or accessible-name claim can move.

## Contract

- **Ask of each claim: can this fail for the reason its title gives, at the seam I am moving it to?** "A newly drawn Annotation is drawn with the last one's style" is a claim about state the editing layer holds — it can move. "All three appear on the map, each painted by the layer for its geometry" is a claim about MapLibre — it cannot, and stays.
- **Anything touching the map canvas stays at Seam 2**: drawing by clicking the map, the popup rendered over the map, the pin draggable under a Map Image, the three line styles rendering distinctly.
- **The one-write-per-gesture claims stay at Seam 2** (ADR-0017 rule 1). They are about what reaches storage when a gesture ends, and storage is the subject.
- Prefer `annotation-editing.svelte.ts`'s existing Node seam over a rendered component wherever the claim is about state rather than markup. Fewer seams and cheaper tests; the component seam is for what is *rendered*.
- Every retired Seam 2 test names its replacement.

### User Stories

3, 5, 9, 21, 22, 23.

## Out of scope

- The document claims — ticket 06 owns those.
- The keyboard block — ticket 14.
- Adding props or `data-testid`s to components to make them testable. That is an application change needing its own justification.
- Promoting anything to a browser-mode component project when the DOM implementation falls short. The answer is Seam 2.

## Acceptance criteria

- [ ] Each moved claim is asserted at the component seam or at `annotation-editing.svelte.ts`'s Node seam, and each is watched to fail once against a deliberate break.
- [ ] Each claim that was *considered and rejected* for moving is listed in the commit message with the reason it stays at Seam 2.
- [ ] Every retired Seam 2 test is named alongside its replacement.
- [ ] `pnpm test:e2e editor-annotations.e2e.ts` passes; count and wall time recorded before and after.
- [ ] The whole component seam still runs with no browser process.
- [ ] `pnpm precommit lint check test` passes.

```bash
pnpm test:e2e editor-annotations.e2e.ts
pnpm --filter @ballastella/editor exec vitest run
pnpm precommit lint check test
```

Success: `editor-annotations.e2e.ts` holds only claims that need a real map or real storage; the rest are asserted in milliseconds; `precommit` exits 0.

## Blocked by

- 02
- 06

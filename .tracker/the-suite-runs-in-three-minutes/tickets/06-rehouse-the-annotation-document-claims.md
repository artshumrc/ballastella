# 06 — Rehouse the Annotation document claims to Seam 1

## What to build

`editor-annotations.e2e.ts` is 51 tests at roughly 11.8 worker-seconds each — the largest single concentration of cost in the suite. A large block of it asserts what ends up **in the GeoJSON file** and what the Markdown renderer does with untrusted text. Neither needs a browser to boot the application.

Rehouse those claims to Seam 1 (and, for the sanitiser, to the existing browser-mode test that already owns it), then retire the Seam 2 tests they replace.

Three groups:

1. **The untrusted-description matrix** — the payloads asserted inert in the Annotation's name, in the rendered description, in the popup, and across the whole document. One pure pipeline: `marked` parses, DOMPurify sanitises, and the order is not negotiable (ADR-0009).
2. **simplestyle emission** — colour, width, opacity, fill, the nine-colour palette, marker properties for a pin, dash tuples versus keywords, solid as the *absence* of `stroke-dasharray`, and defaults where neither Annotation nor Layer says anything.
3. **Display state never reaching the GeoJSON** — an unchanged Layer staying byte-identical across a session that only looked, and a file this app wrote surviving a parse-and-write round trip unchanged.

## Where to start

- `e2e/editor-annotations.e2e.ts` — the describe blocks "a description is untrusted, and this is asserted not assumed (ADR-0009)", "style controls write simplestyle names exactly (SPEC stories 63, 64, 65)", "solid, dashed, and dotted (SPEC story 61)", "style is on each Annotation (ADR-0009, as amended)", "display state never reaches the GeoJSON (ADR-0002, ADR-0010)".
- `packages/core/src/annotation/markdown.ts` and its existing `markdown.browser.test.ts` — the sanitiser already has a home. DOMPurify needs a DOM, which is why that test is in the browser project; the payload matrix joins it there rather than at Seam 2.
- `packages/core/src/annotation/annotation.ts` and `annotation.test.ts` — where simplestyle emission and style precedence belong.
- `packages/core/src/store/memory-project-store.ts` — the in-memory `ProjectStore` that makes "after this sequence the store contains these files with this content" cheap.

## Contract

- **One Seam 2 test must remain proving the sanitiser is actually wired into the Annotation popup.** Moving the matrix down without it leaves the wiring unasserted: the sanitiser could be perfect and the popup could render raw HTML, and every remaining test would pass. Keep the narrowest such test and say in its comment why it survives while its siblings moved.
- **Byte-identity claims move only when the bytes are still the assertion.** "An unchanged Annotation Layer stays byte-identical" is a claim about what the *application* writes during a session. If it can only be expressed at Seam 1 by calling the serialiser directly, it has become a claim about the serialiser agreeing with itself — leave it at Seam 2 and say so.
- Every retired Seam 2 test names its replacement in the retiring commit, per the epic's retirement rule. Retiring by deletion needs a stated reason and is expected to be rare here.
- Do not import the payload list from the application. A fixture that shares a source with the thing it tests agrees with it however wrong both are — `e2e/support/reader-project.ts`'s header carries the argument.

### User Stories

5, 9, 21, 27, 28, 35.

## Out of scope

- The drawing tests (a pin, a line, a shape drawn on the map), the one-write-per-gesture tests, the "render distinctly, each by its own layer with its own dash pattern" test, and "placing a Pin at a Place". Those need a real map; they stay, and ticket 07 handles the rest of this file.
- Changing the sanitiser, the palette, or anything in `core`.
- `editor-annotations`' keyboard block — ticket 14.

## Acceptance criteria

- [ ] The untrusted-description payload matrix is asserted at Seam 1, over the same payloads, with the parse-then-sanitise order still explicit.
- [ ] Exactly one Seam 2 test remains asserting the sanitiser is wired into the popup, and its comment says why.
- [ ] simplestyle emission, precedence and defaults are asserted at Seam 1.
- [ ] Every retired Seam 2 test is named in the commit alongside its replacement.
- [ ] Each new Seam 1 test is watched to fail once against a deliberate break.
- [ ] `pnpm test:e2e editor-annotations.e2e.ts` passes, and its test count and wall time before and after are recorded in `TRACKER.md`.
- [ ] `pnpm precommit lint check test` passes.

```bash
pnpm test:e2e editor-annotations.e2e.ts        # record count + wall time before and after
pnpm --filter @ballastella/core test
pnpm precommit lint check test
```

Success: the file is materially smaller and faster, every retired claim has a named new home, and `precommit` exits 0.

## Blocked by

- 01

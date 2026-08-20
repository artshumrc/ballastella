# 01 — The theme, the faces, and the two marking rules

## What to build

The generated daisyUI theme, in both apps, plus the two self-hosted faces and the two rules that
travel with them. **No component markup changes in this ticket.** Everything here is stylesheet, two
binary assets, a notices entry, and two tests.

When it lands, both apps are Sidereal in light and dark, set in Bluu Next over Instrument Sans, with
square structure and soft controls, hairlines that read on every surface, and no monospaced glyph
anywhere. The Project page changes by this alone and its markup is not touched.

## Where to start

- `docs/adr/0036-sidereal-ruled-the-generated-theme-and-two-rules-about-marking.md` — **read this
  first and in full.** It is the authority for every value. Do not invent a colour; copy the tables.
- `apps/editor/src/routes/layout.css` and `apps/viewer/src/routes/layout.css` — each has
  `@plugin 'daisyui';` with nothing after it. The editor's also holds the `.pane-overlay-point-*`
  rules, which already take their colours from theme variables and should need no edit.
- `packages/ui/src/layout.css` — the stylesheet both apps import. Its header explains what belongs
  here versus in an app's own: what a shared component needs wherever it renders. Read the
  Layer-kind-ink section; it is the model for the hairline mix.
- `packages/ui/src/layer-kind-style.ts` — `KIND_STYLE`, and the `--layer-kind-ink-*` custom
  properties in `layout.css` that it points at. **Do not change this file.** It is what the contrast
  test measures.
- `apps/viewer/svelte.config.js` and `apps/editor/svelte.config.js` — `paths: { relative: true }`,
  and the comment saying why it is mandatory. This decides where the fonts go; see the Contract.
- `scripts/check-seam-2-size.mjs` — `SEAM_2_CEILING` is `646`. This ticket must not raise it.
- `THIRD-PARTY-NOTICES.md` — the existing entries' shape.
- `daisyui@5.7.16/themes.css` under `node_modules/.pnpm/` — a stock theme block, if you want to see
  the shape the plugin expects before writing one.

## Contract

### The theme blocks

One `@plugin 'daisyui/theme'` block per theme, per app, immediately after each app's existing
`@plugin 'daisyui';`. Values are ADR-0036's two tables, copied.

Four things about them are load-bearing and are not style preferences:

1. **The names are exactly `light` and `dark`.** `apps/editor/src/lib/theme.svelte.ts` and
   `apps/viewer/src/lib/theme.svelte.ts` write those two strings to `data-theme`. A third name is a
   theme nothing can select.
2. **`prefersdark: false` in both.** `ThemeSignal` already owns the `prefers-color-scheme` decision.
   A second opinion about it is the divergence ADR-0016 exists to prevent.
3. **The base ramp descends** — `base-100` lightest, `base-300` deepest — in *both* themes, as
   daisyUI's own do. Inverting it in dark inverts every `border-base-300` in both apps and turns the
   align sidebar's and the Layer rail's `bg-base-300` from a well into a highlight, with nothing
   erroring.
4. **The structure tokens**, identical in both blocks:

```css
--radius-selector: 2rem;      /* toggle, range, checkbox, badge */
--radius-field: 0.1875rem;    /* button, input, select, textarea, menu, kbd */
--radius-box: 0rem;           /* card, modal, alert, select (outer) */
--size-selector: 0.25rem;
--size-field: 0.25rem;
--border: 1px;
--depth: 0;                   /* stock light ships 1; 0 is what makes a surface read as drawn */
--noise: 0;
```

The two app stylesheets are duplicates and **must not diverge**. This ticket is the only place either
is written; a later change to one is a change to both in the same edit.

### The hairline and the faces go in `packages/ui/src/layout.css`

Both are needed wherever a shared component renders, so they belong to the shared stylesheet rather
than to either app's routes:

```css
@theme {
	--color-rule: color-mix(in oklab, var(--color-base-content) 14%, transparent);
	--color-rule-strong: color-mix(in oklab, var(--color-base-content) 28%, transparent);
	--font-sans: 'Instrument Sans', ui-sans-serif, system-ui, sans-serif;
	--font-serif: 'Bluu Next', Georgia, serif;
}
```

`base-300` is deliberately **not** the rule colour: it is also a ground, so a rule drawn in it is
crisp against `base-200` and nearly invisible against a `base-100` surface in the same theme.

### ⚠ The font files live in `packages/ui/src/fonts/`, not in `static/`

This is the one place where the obvious answer is wrong, so it is a contract rather than a hint.

`paths: { relative: true }` is set in both apps and ADR-0006 makes it mandatory: the publish target —
a domain root or a project subdirectory — is unknown at build time. So **an absolute
`src: url('/fonts/InstrumentSans.woff2')` 404s on every site published into a subdirectory**, which
is most of them. And a relative URL from a stylesheet in `static/` is no better, because the built
CSS is served from `_app/immutable/assets/` and a relative path resolves against *that* directory.

So: put the two `woff2` files in `packages/ui/src/fonts/` and reference them **relatively from
`packages/ui/src/layout.css`**, which is the file beside them. Vite then treats each as an asset
import, hashes it, emits it, and rewrites the URL relative to the emitted stylesheet — correct under
any base path, in both apps, and **one copy of each file in the repository** rather than two static
copies to keep in step.

```css
@font-face {
	font-family: 'Instrument Sans';
	src: url('./fonts/InstrumentSans.woff2') format('woff2');
	font-weight: 400 700;
	font-stretch: 75% 100%; /* the width axis; a condensed label is this file, not a second one */
	font-style: normal;
	font-display: swap;
}

@font-face {
	font-family: 'Bluu Next';
	src: url('./fonts/BluuNext-Bold.woff2') format('woff2');
	font-weight: 700;
	font-style: normal;
	font-display: swap;
}
```

Verify the emitted URLs rather than assuming: after `pnpm build`, the font files must appear under
each app's build output and the `@font-face` rule in the built CSS must point at them by a path that
works from a subdirectory.

**Do not add a font package to any manifest.** A font is not a component library, nothing imports it,
and `packages/ui` may not reach into `apps/` at all (`scripts/check-ui-package-imports.mjs`).

### Where the files come from

| file | upstream | licence | bytes |
| --- | --- | --- | --- |
| `InstrumentSans.woff2` | `raw.githubusercontent.com/Instrument/instrument-sans/HEAD/fonts/webfonts/InstrumentSans[wdth,wght].woff2` | OFL | 88,784 |
| `BluuNext-Bold.woff2` | `raw.githubusercontent.com/velvetyne/BluuNext/HEAD/Fonts/webfonts/bluunext-bold-webfont.woff2` | OFL | 30,652 |

Check the first four bytes of each are `wOF2` (`head -c4 file | xxd -p` → `774f4632`) before
committing them. Both need a `THIRD-PARTY-NOTICES.md` entry under ADR-0021, because publishing copies
these bytes into every Published Site and that is redistribution, not use.

### No monospace, and the reset is load-bearing

In `packages/ui/src/layout.css`:

```css
code,
kbd,
samp,
pre {
	font-family: inherit;
	font-variant-numeric: tabular-nums;
}

code,
kbd,
samp {
	background: color-mix(in oklab, var(--color-base-content) 8%, transparent);
	padding-inline: 0.25em;
}
```

Without it the browser's own default monospace applies at all four `<code>` call sites — the folder
path in `ProjectCardList`, the Control Point readout in the align sidebar, `settings-folder-name`,
and `ImageDetails`' figures — defeating the decision with nothing erroring.

### Two tests, both at Seam 1c

**A contrast test, in `packages/ui`.** Render a Layer card for each kind under each theme and assert
that the kind's ink clears 4.5:1 against a `base-100` card, computing the ratio from the resolved
colours. Assert the property, **not the hex**: hard-coding `#8a5f14` pins the decision to a value and
makes the next palette a test rewrite. This test is what would have caught an inverted dark ramp.

⚠ `happy-dom` may not resolve `color-mix(in oklab, …)` for you. If it does not, compute the mix in
the test from the two theme values it is given and assert on that — the thing worth pinning is that
*the rule the theme uses* produces a legible ink, and a test that silently skips because the DOM
returned an empty string is worse than no test. Say in a comment which of the two you did and why.

**A no-monospace test.** Render a component containing a `<code>` and assert its computed
`font-family` is the text face. The existing `tabular-nums` assertion in `editor-alignment.e2e.ts`
passes whether or not this reset exists — tabular figures are not monospace — so it is not evidence
and this test is not redundant with it.

## User Stories

- **1.** As a Reader, I want the Published Site I am sent to to look like a considered piece of work
  rather than a framework's default, so that I take the scholarship in it seriously.
- **2.** As an author, I want one generated theme to dress both apps, so that what I author in and
  what my colleagues read are recognisably the same tool.
- **3.** As either user, I want the theme to declare exactly the two names the app writes to
  `data-theme`, so that choosing a theme cannot select a theme that does not exist.
- **4.** As either user, I want my operating system's light or dark preference honoured on arrival
  without asking, and the Base Map's flavor to move with it in the same action.
- **5.** As an author working past sunset, I want the interface to follow my desktop into dark *while
  it is open*, so that a change of light does not require reloading a screen I am mid-alignment on.
- **6.** As either user, I want the dark half of the palette to be as finished as the light half, so
  that which one I meet is not a judgement about how much care my session gets.
- **7.** As a maintainer, I want the three base grounds to descend from `base-100`, so that every
  `border-base-300` and every `bg-base-300` well in both apps means what daisyUI's own themes mean by
  it.
- **8.** As a maintainer, I want the palette's grounding, its rejected alternatives and its two
  marking rules recorded in an ADR, so that a later change knows what it is overruling.
- **9.** As a Reader, I want the site's type served from the site's own origin, so that reading a
  scholar's work does not report me to a font host.
- **10.** As a maintainer, I want both faces to be OFL and entered in `THIRD-PARTY-NOTICES.md`,
  because publishing copies the files into every Published Site and that is redistribution.
- **11.** As a Reader on a slow connection, I want the type to cost 119 KB rather than 364 KB, and I
  want that figure to be a measured one.
- **12.** As either user, I want a display face that heads a section and names the app and never
  appears on a control label.
- **13.** As either user, I want a folder path, a Control Point's coordinates and an image pyramid's
  figures set in the same face as everything else, with figures that line up in columns.
- **14.** As either user, I want a literal string still to *read* as a literal string, from a tinted
  ground rather than from a second family.
- **15.** As a maintainer, I want `code`, `kbd`, `samp` and `pre` reset explicitly, because the
  browser's default monospace otherwise defeats this decision in four places with nothing erroring.
- **16.** As either user, I want a surface separated from the surface behind it by a hairline and by
  space, so that the screen reads as drawn rather than as a stack of floating boxes.
- **17.** As either user, I want the controls I touch — toggles, sliders, checkboxes — to be round,
  and the panels they sit on to be square, so that a control reads as an object placed on a panel
  rather than stamped out of it.
- **18.** As a maintainer, I want that distinction to come from daisyUI's three radius tokens with no
  per-component override.
- **19.** As either user, I want a hairline to be equally visible on a card and on the ground behind
  it, in both themes.
- **20.** As either user, I want emphasis and selection marked by a ground tint and the element's own
  ink, never by a coloured left edge.
- **21.** As either user, I want a notice bordered on all four sides with a glyph beside its words, so
  that a warning does not read as a block quote.
- **22.** As a maintainer, I want the difference between a *boundary* rule and an *emphasis* rule
  written down, so that the align rail's edge against the map is not mistaken for a violation.
- **71.** As an author, I want the Project page's layout untouched, and to see only what the tokens do
  to it.
- **72.** As an author, I want the Layers rail to read as a well its cards sit in, in both themes.
- **73.** As an author, I want a Layer's kind still recognisable before it is read, at the same
  legibility it has today, with the ink-mixing rule unchanged.
- **76.** As a contributor, I want the theme block, the hairline and the type in each app's
  `layout.css` where daisyUI expects them, rather than in a file of our own invention.
- **78.** As a contributor, I want to know that `select` takes its radius from two tokens, so that a
  square dropdown on a soft control is not read as a bug.

Stories 20, 21 and 22 are made *possible* here and are enforced surface by surface in the tickets
that follow. What this ticket owes them is that the tokens exist and that no rule it writes itself
uses a left border for emphasis.

## Out of scope

- **Any component markup.** Not `LayerList.svelte`, not `ProjectCardList.svelte`, not
  `NavigationBar.svelte`, not `PublishDialog.svelte`. If a surface looks wrong under the new tokens,
  that is a later ticket's problem and you record it rather than fixing it here.
- **`layer-kind-style.ts` and the `--layer-kind-ink-*` mix.** The palette was chosen to satisfy that
  code, not the reverse. If a kind's ink fails contrast, the value in the ADR is wrong and needs a
  human, not a new mixing rule.
- **Subsetting either face.** They ship whole at 119 KB. Subsetting is the build obligation rejecting
  Junicode was meant to avoid.
- **The Base Map.** Protomaps' flavor per theme is ADR-0020's and the theme signal already drives it.
- **Any Playwright test.** `SEAM_2_CEILING` stays at `646`. Both new tests are Seam 1c.
- **`theme.svelte.ts` in either app.** Its three states and its live media-query listener are correct
  and this ticket depends on them.

## Acceptance criteria

- [ ] Neither app's `layout.css` contains a bare `@plugin 'daisyui';` without two
      `@plugin 'daisyui/theme'` blocks after it, and the two apps' blocks are textually identical
      apart from surrounding comments.
- [ ] Every colour value in both blocks matches ADR-0036's tables exactly.
- [ ] Both blocks name their themes `light` and `dark`, set `prefersdark: false`, and carry the eight
      structure tokens above.
- [ ] In each theme block, `--color-base-100` is lighter than `--color-base-200`, which is lighter
      than `--color-base-300`.
- [ ] `packages/ui/src/fonts/` holds exactly two `woff2` files, each beginning `wOF2`, of 88,784 and
      30,652 bytes; no font file exists under either app's `static/`.
- [ ] The `@font-face` rules in `packages/ui/src/layout.css` reference those files by a **relative**
      URL, and no stylesheet in the repository contains an absolute `url('/fonts/…')`.
- [ ] After a production build, both font files appear in each app's build output and the built CSS
      references them by a path that resolves from a subdirectory.
- [ ] `THIRD-PARTY-NOTICES.md` names both faces with their upstream and their OFL licence.
- [ ] A Seam 1c test asserts the Layer-kind ink clears 4.5:1 on a `base-100` card for both kinds in
      both themes, and does so without any hard-coded palette hex.
- [ ] A Seam 1c test asserts a rendered `<code>`'s computed `font-family` is the text face.
- [ ] Deleting the `code`/`kbd`/`samp`/`pre` reset makes that test fail. Check this by hand before
      declaring done — a test that passes either way is the failure mode this ticket exists to
      prevent.
- [ ] `SEAM_2_CEILING` is unchanged at `646`.
- [ ] `pnpm precommit` passes.

```bash
# The two new tests, by name rather than by path.
pnpm --filter @ballastella/ui test

# Everything, cheapest first. This is the gate.
pnpm precommit

# Confirm the emitted assets and the built URL.
pnpm build
find apps/editor/build apps/viewer/build -name '*.woff2' | sort
grep -ro "url([^)]*woff2[^)]*)" apps/viewer/build/_app/immutable/assets/ | head

# Confirm the bytes are what the ADR says they are.
for f in packages/ui/src/fonts/*.woff2; do printf '%s %s %s\n' "$f" "$(wc -c <"$f")" "$(head -c4 "$f" | xxd -p)"; done
# expect: 88784 774f4632  and  30652 774f4632

# Confirm nothing reaches for an absolute font path.
grep -rn "url('/fonts\|url(\"/fonts\|url(/fonts" --include='*.css' --include='*.svelte' apps packages
# expect: no output
```

Success is `pnpm precommit` green, both apps visibly Sidereal in both themes with no browser
monospace anywhere, and the Project page changed without a line of its markup being touched.

## Blocked by

None - can start immediately.

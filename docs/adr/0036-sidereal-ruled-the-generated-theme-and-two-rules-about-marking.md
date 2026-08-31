# Sidereal, Ruled: the generated theme, and two rules about how things are marked

Both apps shipped on stock daisyUI. `@plugin 'daisyui';` with no theme block, in
`apps/editor/src/routes/layout.css` and `apps/viewer/src/routes/layout.css`, and **no `@font-face`
and no font stack anywhere in the repository** — so every surface either app draws was in the
browser's default sans on daisyUI's default violet-and-pink pair. ADR-0016 anticipated this and
called the replacement "Tracy's generated theme", noting that it "ships in the published viewer, not
only the authoring app". This is that theme, and three rules that come with it.

The palette is **Sidereal**, the type is **Bluu Next over Instrument Sans**, and the structural
position is **Ruled**. The two decks that produced them, with the alternatives that lost, are
recorded under [Records](#records).

## Sidereal

The name of this project is an instrument, not a map. A ballastella is a graduated brass pole sighted
against a night sky, and `CONTEXT.md` is explicit that a Control Point pair *is* a sighting. So the
ground is night, the fittings are brass, and the colour that carries interaction is verdigris —
brass that has aged. Nothing in the palette is drawn from an antique map, which is the look this tool
is most likely to be mistaken for and least well served by: the work is measurement.

Brass is `primary`, slate the sighting line is `secondary`, verdigris is `accent`. The brass is a
desaturated ochre and **never a yellow**; the moment it brightens, the palette becomes an
institutional prospectus.

| | light | dark |
| --- | --- | --- |
| `base-100` | `#fbfaf7` | `#1a2130` |
| `base-200` | `#f1eee7` | `#141a24` |
| `base-300` | `#ddd7ca` | `#0d121a` |
| `base-content` | `#14181f` | `#e9e7e2` |
| `primary` — brass | `#8a5f14` | `#d6a244` |
| `primary-content` | `#fff9ec` | `#171208` |
| `secondary` — slate | `#3e5a73` | `#7e9bb6` |
| `secondary-content` | `#f2f6f9` | `#0c1219` |
| `accent` — verdigris | `#14625e` | `#45bdb3` |
| `accent-content` | `#effaf8` | `#04191a` |
| `neutral` | `#2a3038` | `#3a4553` |
| `neutral-content` | `#f3f2ee` | `#e9e7e2` |
| `info` | `#2c5c7a` | `#7ea6c4` |
| `success` | `#1f6a4a` | `#57b98c` |
| `warning` | `#9a6412` | `#e0a63c` |
| `error` | `#9e2f2a` | `#e1615a` |
| `info-content` | `#fbfaf7` | `#14181f` |
| `success-content` | `#fbfaf7` | `#14181f` |
| `warning-content` | `#fbfaf7` | `#14181f` |
| `error-content` | `#fbfaf7` | `#14181f` |

**The four semantic `-content` inks are one value per theme, and they have to be stated.** Each theme
takes the other's ground as its semantic ink: light uses its own `base-100`, dark uses light's
`base-content`. Omitting them would leave the semantic pair incomplete and risks illegible
`alert-*`, `badge-success`, `badge-warning`, and `btn-error` surfaces in both apps.

One ink per theme rather than eight hand-tuned values: it invents no hue the palette does not already
have, and it clears 4.5:1 on all eight pairs — light 4.78–6.95:1, dark 5.13–8.21:1. The tightest is
`warning` in light at 4.78:1, so **darkening `warning` is what would break this first**;
`semantic-content-contrast.dom.test.ts` measures all eight from the rendered colours and is what
fails if a later palette change does.

**Amendment: the generated themes are named `carto-light` and `carto-dark`, and every built-in
daisyUI theme is also selectable.** `ThemeSignal` still owns the `prefers-color-scheme` decision —
the editor's live, the viewer's read once at construction — and uses the two Carto themes while no
explicit choice exists. Every selectable theme declares a light or dark scheme in the shared theme
catalog so the same signal selects the matching Base Map flavor; theme name and map scheme are not
independent controls.

**`prefersdark` is nonetheless `true` on the `carto-dark` block, and it is not that second opinion.**
daisyUI emits it behind `:root:not([data-theme])` (`daisyui/theme/index.js`), so it styles only the
window before `ThemeSignal` has spoken and goes inert the moment the attribute is written — it cannot
disagree with the signal, because the two never apply at once. It is there because `themes: false`
the built-ins carry no default flags, and `startTheme()` runs from a mounted component while
`preferredTheme()` answers `carto-light` during prerendering: without it, an OS-dark machine paints Sidereal
light and flips to dark at hydration on every prerendered page, **including every Published Site**.
Verified in the built stylesheet rather than inferred — the emitted media query carries the dark
ramp, the semantic inks and the structure tokens.

**Sidereal is designed dark-first and that is a stance, not a default.** Neither app defaults to
dark; both start from the operating system. So the light half is what roughly half of Readers meet on
arrival and is held to the same finish, and "light is the concession" is a statement about how the
palette was drawn rather than about which one matters.

### The base ramp descends, and getting it backwards is silent

daisyUI's own themes run `base-100` → `base-300` from lightest to most-contrasted **in both light and
dark**: stock light is `100% → 98% → 95%` and stock dark is `25.33% → 23.26% → 21.15%`, measured in
`daisyui@5.7.16/themes.css`. So `base-100` is always the surface a card sits on and `base-300` is
always the deepest ground.

The first draft of Sidereal's dark half had `base-300` as the *lightest* of the three. That inverts
every `border-base-300` in both apps — which is the border on every card, every Layer, and the
Annotation Inspector — and it turns the align sidebar's and the Layer rail's `bg-base-300` from a
well into a highlight. Nothing errors and no test fails; the app simply looks wrong in one theme.
**Any future change to these three values keeps them descending.**

This is also, incidentally, the whole of the change to the Layer rail's ground: under the corrected
ramp it is the deepest well in dark and the most tinted paper in light, and no markup moves.

## Ruled

Structure is delimited by **hairline rules and space**, not by borders around boxes, elevation, or
rounded corners. `--depth: 0` and `--noise: 0` switch off daisyUI's own gradient and texture
treatments — stock light ships `--depth: 1` — which is what makes a surface read as drawn rather than
rendered.

### Structure is square; the things you touch are soft

Cards, modals and alerts have no radius. Toggles, range thumbs, checkboxes and badges are fully
round, and buttons, inputs and selects take 3px — enough that a control reads as an object placed on
a panel rather than stamped out of it.

This needs **no per-component override**, because daisyUI already separates the three. Verified
against `daisyui@5.7.16/components/`:

| token | value | components that read it |
| --- | --- | --- |
| `--radius-selector` | `2rem` | `toggle`, `range` (track and thumb), `checkbox`, `badge` |
| `--radius-field` | `0.1875rem` | `button`, `input`, `select`, `textarea`, `menu`, `kbd` |
| `--radius-box` | `0rem` | `card`, `modal`, `alert`, `select` (outer) |

`select` reads **both** `--radius-field` and `--radius-box`, so the Base Map chooser and the
transformation picker get a softened control with a square dropdown. That is the right outcome and it
is worth knowing it was not chosen — it is how daisyUI composes that component.

### The hairline is a mix, not a token

Under Ruled a 1px line is the only thing separating most surfaces, which makes it the most
load-bearing colour in the app — and **`base-300` cannot be it, because `base-300` is also a
ground**. A rule drawn in `base-300` is crisp against `base-200` and nearly invisible against a
`base-100` surface, in the same theme.

daisyUI 5 has no separator token, so this one is ours:

```css
@theme {
	--color-rule: color-mix(in oklab, var(--color-base-content) 14%, transparent);
	--color-rule-strong: color-mix(in oklab, var(--color-base-content) 28%, transparent);
}
```

One declaration, legible on every surface in both themes, and it cannot drift when the palette does.
This is the same technique `packages/ui/src/layout.css` already uses for Layer-kind ink and
`--layer-problem-ink`, so it is a house pattern rather than a new idea.

## Two rules about how things are marked

These are the two rules most likely to be broken by a well-meaning later change, because both
describe something *not* to reach for.

### No left border for emphasis or selected status

A coloured left edge is a habit rather than a design. It collides with right-to-left text, it reads
as a block quote when it lands near running prose, and — decisively here — where a 1px rule already
means *boundary*, a 3px rule on one edge means something a reader has to be taught.

So:

- **emphasis** is a ground tint;
- **selected status** is a ground tint plus the element's own ink — a selected Control Point row is
  tinted and its dot is `secondary`, which is the same colour that identifies it on both map panes;
- **a notice** is a hairline on all four sides over a 10% wash of its own colour, with a glyph beside
  the words rather than a bar beside the block.

A left border that genuinely separates two regions is **not** this rule's business. The align rail's
edge against the map pane is a boundary, doing the same job every other rule in the app does. The
test is what the line is *for*, not which side it is on.

### No monospace, anywhere

There is no monospaced face in either app. A folder path, a Control Point's coordinate readout, an
image pyramid's figures and a Workspace's folder name all reach for `<code>`, and `<code>`'s meaning —
*this is a literal string* — is worth keeping. It is carried by a tinted ground and tabular figures
instead of by a second family:

```css
code, kbd, samp, pre {
	font-family: inherit;
	font-variant-numeric: tabular-nums;
}
code, kbd, samp {
	background: color-mix(in oklab, var(--color-base-content) 8%, transparent);
	padding-inline: 0.25em;
}
```

**That reset is load-bearing and its absence is silent.** Without it the browser's own default
monospace family applies to all four call sites, defeating the decision with nothing erroring and no
test failing. `editor-alignment.e2e.ts` asserts a computed `tabular-nums` on a Control Point's
ordinal; tabular figures are not monospace, so that assertion is satisfied by the text face and is
not evidence that this reset is in place.

## The faces

| face | role | upstream | licence | woff2 bytes |
| --- | --- | --- | --- | --- |
| Instrument Sans | everything readable; variable weight **and width** | `github.com/Instrument/instrument-sans`, `fonts/webfonts/InstrumentSans[wdth,wght].woff2` | OFL | 88,784 |
| Bluu Next Bold | display only | `github.com/velvetyne/BluuNext`, `Fonts/webfonts/bluunext-bold-webfont.woff2` | OFL | 30,652 |

**119 KB per Published Site**, and both are **self-hosted from the app's own origin**. No request
reaches `fonts.googleapis.com` or any other third party: a webfont host sees every Reader of every
published site, which is not a thing a scholar's readers agreed to.

Three consequences follow from the file being *redistributed* rather than merely used. Publishing
copies these bytes into every Published Site (ADR-0006), so the licence has to permit
redistribution — which OFL does and which the free-but-bespoke foundry licences generally do not,
and which is why a face being free to download was never sufficient. Both need an entry in
`THIRD-PARTY-NOTICES.md` under ADR-0021. And 119 KB lands in the viewer's bundle, which ADR-0019
makes a dependency-graph property rather than a hope.

Instrument Sans is one file carrying both axes, so a condensed uppercase label is the same download
rather than a second family. **Bluu Next never reaches a control label** — it heads a section, names
the app, and titles a dialog, and nothing else.

**Where the files live is a constraint, not a preference.** Both sit in `packages/ui/src/fonts/` — one
copy — and are referenced by a *relative* URL from `packages/ui/src/layout.css`, so Vite emits them
and rewrites the URL relative to the emitted stylesheet. `paths: { relative: true }` is mandatory
under ADR-0006 because the publish target is unknown at build time, so an absolute
`url('/fonts/…')` would 404 on every site published into a subdirectory; and a relative URL from
`static/` is no better, because the built CSS is served from `_app/immutable/assets/` and resolves
against that directory. Any later face arrives the same way.

## Consequences

- **Every `card` in both apps loses its radius and its shadow.** `ProjectCardList.svelte`,
  `LayerList.svelte`, `AnnotationInspector.svelte` and the hand-rolled Map Image list all render
  `card`/`card-border`/`shadow-sm`, and Ruled makes those plates rather than floating objects. No
  markup has to change for this to happen, which is the point of taking it through tokens.
- **The Project page changes by tokens alone.** Two structural redesigns of the Layer stack were
  drawn and both are rejected (below). The rail keeps its cards, its tinted kind headers, its
  toggles, its opacity slider and its actions row.
- **The Layer-kind inks keep working, and that is not luck.** `layer-kind-style.ts` derives a kind's
  ink as `color-mix(in oklab, var(--color-accent) 50%, var(--color-base-content))`, so verdigris
  darkens toward near-black in light and lightens toward near-white in dark; Annotations do the same
  with `info`. Both clear 4.5:1 against a `base-100` card in both themes **with the mixing code
  untouched**. The rule this palette was held to is that a palette which cannot manage that is the
  wrong palette, not a reason to change the mixing code.
- **A glyph is still never alone with meaning** (ADR-0016). Nothing here relaxes that, and the align
  sidebar's delete control — which becomes an icon in `error` — carries its per-row name in visible
  or `sr-only` text and not in a `title`.

## Rejected

- **Google Fonts as a host.** Ruled out on tracking, not on the catalogue: a face that happens to be
  listed there is fine when served from our own origin.
- **Any monospaced face**, including for coordinates and paths. Reconsider only if a layout is
  genuinely unachievable with tabular figures; none was.
- **Junicode with Atkinson Hyperlegible**, which was the pairing with the strongest claim to this
  project's identity — a medievalist's text face beside an accessibility-first UI face. Rejected on
  weight: Junicode's own subset is 317,468 bytes against Instrument Sans' 88,784, in every Published
  Site, and making it viable requires a Latin subsetting step that becomes a build obligation nobody
  can skip silently. Worth revisiting if that step ever exists for another reason.
- **Four other palettes** — Ordnance, Marginalia, Cyanotype, Hypsometric — and **two other structural
  positions**, Panelled (what the code already renders, tuned) and Inset. All are in the first deck
  under [Records](#records).
- **Two redesigns of the Layer rail.** One turned the cards into a continuous ruled ledger with each
  Layer's kind as a coloured left edge — which the no-left-border rule above would now forbid anyway.
  The other added a fixed head and foot to the rail and moved the Base Map chooser and *Fit project*
  off the map pane, which would have deliberately deleted the arrangement
  `editor-base-map.e2e.ts:205-232` asserts. The one genuine repair inside the second — the add-Layer
  buttons scrolling out of reach — is kept, and needs no redesign.
- **Touching the Base Map.** Protomaps' flavor per theme is unchanged; ADR-0020's catalog decides it
  and the theme signal drives it.

## Records

The two design decks, with every alternative and the reasoning that discarded it:

- Options, four independent axes: <https://claude.ai/code/artifact/e282cb35-afdb-4923-8242-be03b46af129>
- The chosen combination, built out: <https://claude.ai/code/artifact/8153ea2c-10d0-4258-a2c4-10f31235cc4a>

⚠ Those are private artifacts and may not outlive the decision. Everything load-bearing is in this
ADR; the decks are the pictures, not the record.

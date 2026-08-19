# Annotation properties follow simplestyle-spec, with one extension

Annotations are stored as one GeoJSON `FeatureCollection` per annotation layer, and each Feature's `properties` follows **simplestyle-spec 1.1.0**: `title`, `description`, `marker-size`, `marker-symbol`, `marker-color`, `stroke` (a *colour*), `stroke-opacity`, `stroke-width`, `fill`, `fill-opacity`.

GeoJSON makes geometry portable, but `properties` is a free-form object — anything we put there is a private convention unless it follows an existing one. Adopting simplestyle is what makes the project's portability claim true rather than aspirational: a layer dropped into geojson.io, committed to a GitHub repository, or imported into desktop GIS renders with its titles and colours intact, with no work on our part. A bespoke schema would make the data portable only to us. W3C Web Annotation was rejected as the wrong ecosystem for this content — it is right for marks on an image, which is what an Alignment already is, whereas these are features on a map, and map tools eat GeoJSON.

## The one extension

simplestyle defines no dash pattern, so solid/dotted/dashed needs an extension: **`stroke-dasharray: [dash, gap]`**, borrowing SVG's well-known name and simplestyle's hyphenated shape. Solid is the property being *absent*.

Store the tuple, not a keyword like `"dashed"` — a tuple is intelligible to anything SVG-aware, a keyword is legible only to us. It also feeds `terra-draw`'s `lineStringDash` directly, which expects `[number, number]`.

Note that simplestyle's `stroke` is a **colour**. Do not overload it for line style.

## `description` holds Markdown

Scholars need italics, links, and footnotes. simplestyle only promises "a string," so both Markdown and HTML are legal; Markdown is chosen for how it *degrades* — a consumer that doesn't render it shows readable prose, where HTML shows visible tag soup.

**Rendered Markdown must be sanitised in the viewer.** This is a real vulnerability, not a formality: ADR-0007's referenced sources and the zip-import path mean a user can open a project authored by someone else, and the viewer is a published site on the user's own domain. Unsanitised `description` rendering is stored XSS on `maps.digitalhumanities.harvard.edu` or on a student's GitHub Pages origin.

### The rendering pipeline

Choosing Markdown as the stored format left the *rendering* step unnamed, and ADR-0018's note that `dompurify` arrives with triiiceratops does not fill the gap: **DOMPurify sanitises HTML, it does not produce HTML from Markdown.** It is the second stage of a two-stage pipeline whose first stage was never chosen. Both stages are declared here:

**`marked` → `dompurify` → insert. Never the reverse.** Sanitising before parsing is a known bypass shape — a parser downstream of the sanitiser can reconstruct markup from text the sanitiser already approved as inert.

`marked` is chosen over `markdown-it` and `remark` on **bundle size**, because the renderer ships in `apps/viewer` as well as the editor and ADR-0019 requires that build to stay lean. The parser is not the security boundary — DOMPurify is — so this is a size-and-features choice rather than a security one. What *is* load-bearing is that the parse is a real parser and never hand-rolled regex over user input, which is how this class of feature becomes an injection vector.

Both packages are **direct dependencies of both apps, declared in the ADR-0019 catalog.** ADR-0018's observation explains why `dompurify` costs nothing extra in install size; it is not permission to import it undeclared. pnpm's isolated `node_modules` exists to prevent exactly that, and a transitive dependency can be dropped or majored by its parent without warning.

### Footnotes are deferred past v1

The motivation above names footnotes, and they are the one part with a real cost. Footnote syntax emits anchor ids and back-references, so several annotation popups rendered on one page collide in the DOM unless the renderer namespaces ids per feature — and the sanitiser must then be configured to permit those ids and fragment links, widening the allowlist on the single surface in this project where a mistake is a vulnerability rather than a defect.

v1 ships **emphasis and links**. Footnote syntax typed by a user degrades to literal text, which is the same graceful-degradation property that motivated choosing Markdown in the first place. User story 62 is amended to match.

## Style precedence

Feature `properties` override the annotation layer's default style (ADR-0002), which overrides simplestyle's own defaults. Stated explicitly because the alternative — stamping every default onto every feature at creation time — produces much larger files that cannot be restyled in bulk.

### Amendment: a Layer has no default style; a new Annotation is drawn with the last one's

The precedence above is reduced to one step. **Feature `properties` override simplestyle's own defaults, and there is nothing in between.** An annotation Layer no longer carries a `defaultStyle`, and nothing resolves against one.

What replaces it is not a smaller version of it: when a scholar draws an Annotation, it is given the style of **the last Annotation drawn in that Layer** (`styleForNewAnnotation`), written onto it as ordinary `properties`. Pick a colour once and everything drawn after it is that colour — which is the outcome a Layer default was bought to produce, reached without asking anyone to hold a second concept.

The reason is that the concept could not be made legible. A Layer default is invisible inheritance: the control said "this Layer's default style", the file said nothing on the feature, and the map showed a colour that came from neither place a user was looking. In the redesigned Layer card it also produced two style sections — one for the Layer, one for the selected Annotation — with the same line-style control in both, which is where this was found.

**This reverses what the section above states, and the reversal is not free.** Three things are given up, and all three were the reasons for the original decision:

- **Files are larger.** Every Annotation carries its own style block rather than inheriting one. This is the cost the original decision existed to avoid, and it is accepted: a Project's GeoJSON is measured in kilobytes, and the properties are exactly the ones simplestyle defines, so nothing about portability changes.
- **A Layer can no longer be restyled in bulk.** Making every conjectural route in a Layer dashed is now one edit per Annotation. This is the real loss. If it comes back it should come back as an *action* — "apply this style to every Annotation in this Layer", which writes the properties — rather than as a default that is resolved at read time.
- **The criterion that a newly drawn Annotation carries no style properties at all is withdrawn**, along with the test asserting it. It now carries whatever the previous one did, and an Annotation drawn into an empty Layer still carries nothing.

**Existing Projects keep their bytes.** `defaultStyle` is no longer named by the Layer parser, so a Project written by an earlier build carries the field through `unknownFields` and writes it back untouched — no migration, and no file rewritten because it was opened (ADR-0010). Such a Layer's Annotations draw with simplestyle's defaults where they set nothing themselves, so a Project that relied on a Layer default does change appearance. That is accepted rather than migrated: stamping resolved styles onto features at open time would rewrite a document the user only looked at.


## A Label is a Point whose `marker-symbol` is `label`

**Not an amendment.** No property is added, none changes meaning, and the file remains simplestyle-spec 1.1.0 plus `stroke-dasharray`. This records a convention within what is already here, so that a reader meeting `marker-symbol: "label"` in a Workspace knows what the app makes of it.

An Annotation whose words are drawn on the map — a Label — is a `Point` carrying:

| What the author chooses | Stored as |
| --- | --- |
| the words drawn on the map | `title` |
| the colour of those words | `marker-color` |
| the colour behind them | `fill` |
| how solid that background is | `fill-opacity` |
| small / medium / large | `marker-size` |
| that this is a Label at all | `marker-symbol: "label"` |

`marker-symbol`'s meaning in simplestyle is *what this marker shows at its point*, and "it shows its own words" is a reading of that field rather than an overload of it — the distinction this ADR draws above when it forbids overloading `stroke` for line style. `simpleStyleViolations` already accepts the value, so a Layer of Labels is conformant against this project's own conformance instrument with nothing relaxed, and it opens in geojson.io or QGIS as titled markers.

**Why not a namespaced property.** `ballastella:label` was the obvious discriminator and would have cost a second extension to this ADR, a new branch in the conformance instrument, and a property no other tool can read. It also degrades worse: a Layer of Labels elsewhere would be markers carrying a private flag rather than markers with titles.

`marker-size`'s three values in simplestyle 1.1.0 are already `small`, `medium` and `large`, which is why a Label has three text sizes and not a number.

### `marker-symbol` is not inherited by a newly drawn Annotation

`styleForNewAnnotation` copies the last Annotation's style onto the next one drawn (the amendment above). **`marker-symbol` is excluded from that copy**, because it says what kind of thing an Annotation is rather than how it looks: copied, drawing a Pin straight after a Label would produce a second Label, with the tool the author chose overridden by the previous Annotation's style. The creation path writes it instead — the Label tool writes `"label"`, every other tool writes nothing.

Colour, size and opacity continue to inherit exactly as the amendment says, including across kinds.

The accepted consequence: a `marker-symbol` from another tool (`"harbor"`, `"7"`) is no longer copied onto the next Annotation drawn. It stays on the Annotation that carries it and is still written back untouched.

### The first Label in a Layer starts on a legible pair

A Label draws `marker-color` on a chip of `fill`, and both inherit from the last Annotation drawn — which, when a Layer holds nothing to inherit from, is the palette's grey written into *both*. Grey words on a grey chip is placed, present in the file, and unreadable.

That untouched default is the whole of the defect, so it is the whole of the rule: **a new Label whose inherited `marker-color` and `fill` are both exactly the default grey starts instead on black words on a white chip** — one fixed pair, both of them among the nine colours the interface offers, so the Style face has a swatch to report. Every other combination inherits untouched: a colour a scholar set twice on purpose is kept, a Label with `fill-opacity: 0` keeps the words it was given, and a `#fff` from another tool is not touched.

**No colour arithmetic is done anywhere.** The rejected alternative measured the background's perceived brightness and substituted black or white whenever the two colours agreed. It ignored `fill-opacity`, so a deliberately transparent Label had its words decided from a background nothing paints; it mis-read the 3-digit hex that any geojson.io-authored Layer may carry; it measured the raw hex rather than what the chip composites to at `fill-opacity` over the map beneath; and its threshold chose the lower-contrast option for some of the nine. The only comparison left is equality against one constant of ours, which is also why a colour property that is not a string — which this ADR's tolerance for foreign values permits — cannot make the creation path throw.

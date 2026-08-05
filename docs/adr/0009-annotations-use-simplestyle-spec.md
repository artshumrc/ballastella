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

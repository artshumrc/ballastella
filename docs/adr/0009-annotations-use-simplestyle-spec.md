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

## Style precedence

Feature `properties` override the annotation layer's default style (ADR-0002), which overrides simplestyle's own defaults. Stated explicitly because the alternative — stamping every default onto every feature at creation time — produces much larger files that cannot be restyled in bulk.

# Display state lives in the project's layer list, never in portable documents

A Project holds an ordered list of **Layers**. A Layer is a first-class record that *references* content rather than containing it, and comes in kinds — `kind: "map"` references an Alignment, `kind: "annotation"` references a GeoJSON file. Every layer carries `id`, `name`, `kind`, `visible`, and `order`; `map` layers add `opacity` and their Alignment reference; `annotation` layers add their GeoJSON reference and default styling.

Display state is deliberately kept out of the IIIF Georeference Annotation and out of the GeoJSON files. Those two formats exist so that a scholar's work is portable to Allmaps and to other map platforms — putting `opacity` or `visible` in them would mean either polluting a standards document or inventing a private extension no other consumer reads. The layer list is therefore not a convenience; it is the only place presentation can live without breaking interoperability.

We also chose one mixed-kind layer list over separate collections for maps and annotations. The layer-list mental model is already installed by QGIS, ArcGIS, Photoshop, and Google Earth, so it costs nothing to teach; it puts visibility, ordering, and naming in exactly one place for all content types; and it makes stacking order *between* kinds expressible, which is needed immediately since labels must draw above the map image they describe. It also permits multiple annotation layers — "trade routes" separate from "parish boundaries," or one layer per student in a shared project — which separate collections would have foreclosed.

## Consequences

- `Layer` must be a discriminated union narrowed on `kind`, not one type with a bag of optional fields. The predictable failure of the latter is someone setting `opacity` on an annotation layer, observing nothing, and then "fixing" it by threading opacity through label rendering.
- The UI has per-kind controls, and call sites must narrow the union.
- Reordering, renaming, and toggling never touch the `.json` files that hold alignments or features.

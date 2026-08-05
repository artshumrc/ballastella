# Remote IIIF is referenced by default, mirrored only on explicit request

A historical map added from a remote IIIF URI is referenced in place: its tiles stay on the host. A per-image action — "make an offline copy" — mirrors it into the project instead. Local images are mirrored by definition.

Referencing is the default because it avoids silently copying rights-restricted material, keeps projects small when a whole class adds the same map, preserves the canonical citation rather than orphaning a copy, and matches Allmaps' own model, in which a Georeference Annotation points at a remote IIIF resource. That last point is what keeps our output natively interoperable rather than resolvable only by our own viewer.

Mirroring is offered because it buys durability against **link rot**, which is a real scholarly failure mode — a dissertation whose maps 404 in five years is worse than a large repository — plus offline field use and a genuinely self-contained published site. It is also cheap to build: the tiler (ADR-0003), the store layout, and the placeholder-`id` mechanism (ADR-0004) all exist for local images already.

Mirroring cost depends on the source's compliance level. A remote **level 2** service can serve `/full/max/0/default.jpg` in a single request, which then feeds the existing tiler — the local-image path reused exactly. A remote **level 0** service exposes only its own pre-cut tiles, so mirroring means pulling its entire pyramid: potentially thousands of requests against someone else's server. Warn on that case, and surface the manifest's `rights` and `requiredStatement` at the moment the user chooses to copy.

## Consequences

- **CORS must be probed at add-image time, not discovered at render time.** `@allmaps/maplibre` uploads tiles into WebGL textures, which requires cross-origin-readable responses. Most IIIF servers send `Access-Control-Allow-Origin: *`, but not all, and without it the map renders **blank with no error**. Fetch `info.json` *and one tile* under CORS before accepting the resource, and reject with a diagnostic naming the host. Mirroring is not a workaround — it also has to fetch.
- **Each layer records whether its image is referenced or mirrored**, because it changes what publishing means. A referenced image makes the published site network-dependent, and the publish step must say so rather than letting a reader on a plane discover it.

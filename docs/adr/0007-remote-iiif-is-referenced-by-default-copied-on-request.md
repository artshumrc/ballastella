# Remote IIIF is referenced by default, an Offline Copy is made only on explicit request

> **Renamed.** This ADR was recorded as "referenced by default, mirrored only on explicit request",
> and the word "mirror" ran from it through the code and into the UI. CONTEXT.md names the concept
> **Offline Copy** and lists "mirror" as the synonym to avoid; the code was brought into line, and
> this file was renamed with it so the decision and the code call the same thing by the same name.
> Nothing the ADR decided has changed.

A map image added from a remote IIIF URI is referenced in place: its tiles stay on the host. A per-image action — "make an offline copy" — fetches it into the workspace instead. Local images have their tiles here by definition.

Referencing is the default because it avoids silently copying rights-restricted material, keeps projects small when a whole class adds the same map, preserves the canonical citation rather than orphaning a copy, and matches Allmaps' own model, in which a Georeference Annotation points at a remote IIIF resource. That last point is what keeps our output natively interoperable rather than resolvable only by our own viewer.

Making an offline copy is offered because it buys durability against **link rot**, which is a real scholarly failure mode — a dissertation whose maps 404 in five years is worse than a large repository — plus offline field use and a genuinely self-contained published site. It is also cheap to build: the tiler (ADR-0003), the store layout, and the placeholder-`id` mechanism (ADR-0004) all exist for local images already.

The cost of an offline copy depends on the source's compliance level. A remote **level 2** service can serve `/full/max/0/default.jpg` in a single request, which then feeds the existing tiler — the local-image path reused exactly. A remote **level 0** service exposes only its own pre-cut tiles, so making an offline copy means pulling its entire pyramid: potentially thousands of requests against someone else's server. Warn on that case, and surface the manifest's `rights` and `requiredStatement` at the moment the user chooses to copy.

## Consequences

- **CORS must be probed at add-image time, not discovered at render time.** `@allmaps/maplibre` uploads tiles into WebGL textures, which requires cross-origin-readable responses. Most IIIF servers send `Access-Control-Allow-Origin: *`, but not all, and without it the map renders **blank with no error**. Fetch `info.json` *and one tile* under CORS before accepting the resource, and reject with a diagnostic naming the host. Making an offline copy is not a workaround — it also has to fetch.
- ~~**Each layer records whether its image is referenced or has an offline copy**~~ — **amended by [ADR-0023](./0023-map-images-and-alignments-live-in-the-workspace.md): nothing records it, because it is observable.** A map image in the workspace either has an `info.json` of ours, so its tiles are here, or only a `remote.json`, so they are on a library's server. A stored claim could disagree with the bytes on disk; a derived one cannot. What still holds is *why* the distinction matters: a referenced image makes the published site network-dependent, and the publish step must say so rather than letting a reader on a plane discover it.
- **A referenced map image can be aligned without being copied first.** `createImagePane` already accepts an absolute base URI as well as a stored image id, and the tile protocol is generic over its injected `fetch`, so the same pane aligns either source. The corollary is that a remote **level-0** service publishing no `tiles` property and supporting no arbitrary regions cannot be aligned at all — and that must be refused when the resource is *added*, in the same probe as CORS, for the same reason: discovering it at render time means a user was promised a screen that then fails.

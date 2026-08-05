# The image service base URL is resolved at load time, not baked into info.json

Each generated `info.json` is written with a deliberately unusable placeholder `id` — `https://unset.invalid/<image-id>` — and the real base is assigned to `Image#uri` at load time from the ProjectStore's own base. Publishing then offers an opt-in step that rewrites `id` to a canonical absolute URL the user supplies.

`@allmaps/iiif-parser` builds every tile URL by string-concatenating the `id` from `info.json` (`classes/image.js:280` — `` `${this.uri}/${urlRegion}/${urlSize}/0/${quality}.${format}` ``), and IIIF requires that `id` be absolute. One immutable pyramid therefore has to answer to four different bases over its life: OPFS during authoring (no URL exists at all), a local folder, a GitHub Pages *project subpath*, and a custom domain — plus a zip round-trip onto another machine. Baking the base at ingest time means every later move silently 404s every tile and the map renders blank with no error.

An override path is not a preference, it is mandatory: authoring happens in OPFS where there is no URL to bake. `Image#uri` is a plain public field, so the override is a single assignment. Given that the mechanism must exist anyway, making it the *only* mechanism is free and removes an entire class of "my published map is blank" failures.

The opt-in canonical stamp is kept because it delivers something the placeholder cannot: it turns a user's tiles into a real, citable IIIF endpoint that Allmaps, Theseus, and OpenSeadragon can consume directly. That is the interoperability promise actually paying out rather than being a claim about file formats. It is a publish-time choice, and the address is remembered in the project.

## Consequences

- The placeholder must satisfy `id: z.string().url()`. `.invalid` is reserved by RFC 2606, so DNS always fails — a forgotten override fails loudly and immediately instead of quietly fetching from the wrong host. A `urn:` would parse under some zod versions and not others; do not use one.
- Every code path that constructs an `Image` must set `uri` before requesting a tile. This is the single most important invariant in the IIIF layer.
- A project whose `id`s have been stamped for one address and is then moved still works in the app, because load-time override always wins.

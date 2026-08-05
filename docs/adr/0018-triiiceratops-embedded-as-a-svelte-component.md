# triiiceratops is embedded as a Svelte component, and only a URI crosses the parser boundary

triiiceratops is imported from its `./svelte` export as an ordinary Svelte component, not used via its web-component export.

Svelte 5 is a declared peer dependency (`peerDependencies: { svelte: '^5.0.0', react: '^19.0.0', vue: '^3.5.0' }`), so there is no version friction. More decisively, **ADR-0011 requires passing a custom OpenSeadragon `TileSource` that resolves tiles through the `ProjectStore`** — a JavaScript object or factory. That is natural as a Svelte prop and awkward as a web-component attribute, where it would mean reaching in through element properties. Web components also isolate styling, which would fight Tracy's theme (ADR-0016). The web-component export is the right choice for framework-agnostic embedding, which is not our situation. And since we maintain triiiceratops, any prop or plugin hook the integration needs is an upstream change rather than a workaround.

## Two IIIF parsers, one string between them

triiiceratops depends on **`manifesto.js`**; the alignment path uses **`@allmaps/iiif-parser`**. The bundle therefore carries two independent IIIF parsers. This is accepted — they do genuinely different jobs, manifest and collection navigation versus tile geometry and rendering — but two implementations of the same specification can interpret the same manifest differently, and that must never matter.

**The contract: triiiceratops selects; it hands over an image service URI, never a parsed object.** A user browses a manifest in triiiceratops (manifesto's reading of it), picks a canvas, and what crosses the boundary is a URI string. `@allmaps/iiif-parser` re-parses from that URI independently. No parsed structures are shared, so any disagreement between the two parsers about anything else in the manifest is invisible, because neither consumes the other's interpretation.

## Consequences

- **`dompurify` is already in triiiceratops' dependency tree**, satisfying ADR-0009's sanitisation requirement with the library we would have chosen anyway.
- triiiceratops exposes `./selectors` and `./testing` entry points, which is the intended way to read state such as the currently selected canvas rather than lifting it out by hand.
- Bundle weight includes both parsers. Accepted; the alternative is teaching one parser to do the other's job.

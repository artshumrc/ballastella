# triiiceratops is embedded as a Svelte component, and only a URI crosses the parser boundary

## Amendment, 2026-08-09 (ticket 15): this applies to the published viewer alone

**`apps/editor` no longer depends on triiiceratops.** Its "View unwarped" affordance and the `UnwarpedView.svelte` that backed it are deleted, and the dependency is out of the editor's manifest. Everything below now describes exactly one consumer, `apps/viewer/src/lib/UnwarpedView.svelte`, which is unchanged: SPEC story 101 is rescoped to the Reader, not dropped.

The editor no longer needs it for two reasons, and the second is the one that decides it:

- Since ticket 07 the alignment view deep-zooms **any** Historical Map, Workspace-held or referenced, in the same pane. "Look closely at this sheet" is answered uniformly, without a second tiling viewer on the screen.
- The editor's copy could **never** show a locally ingested pyramid. The paragraph below says ADR-0011 requires passing a custom OpenSeadragon `TileSource`, and that is still true and still unsatisfied: triiiceratops 1.0.0-rc.35 has no prop, plugin hook, or config path that accepts one. So the affordance appeared on a map fetched from a library and not on one ingested from a file, **for a reason the user could not possibly infer** — the opposite of an interface that documents itself. The object it would have been passed, `storedPyramidTileSource`, is kept in `@ballastella/core` with that gap named in its header.

**"Two IIIF parsers in one bundle" is now true of neither app, and the section below should be read as history.** Measured on the ticket-15 build, by grepping the served assets rather than the manifests:

| Bundle                                          | `manifesto.js` | `@allmaps/iiif-parser` |
| ----------------------------------------------- | -------------- | ---------------------- |
| `apps/editor/build/_app` (the editor itself)     | no             | yes                    |
| `apps/editor/build/viewer-bundle` (the viewer)   | yes            | no                     |

The editor lost `manifesto.js` with triiiceratops; the viewer never had `@allmaps/iiif-parser`, because value-importing it is how the tiler would reach a Published Site (ADR-0019, and see the note atop `apps/viewer/src/lib/unwarped-manifest.ts`). The "Bundle weight includes both parsers" consequence below therefore no longer describes anything that ships.

**The URI boundary survives its stated reason and is deliberately kept.** It was justified as a wall between two disagreeing parsers; with one parser per bundle that specific hazard is gone, but what the boundary actually forbids — the alignment path inheriting the browsing step's *reading* of a document instead of fetching and re-parsing the image service itself — is unchanged and still worth enforcing. `packages/core/src/remote-iiif/parser-boundary.ts` now says so in those terms, and its refusal message no longer claims two parsers are present. Its behaviour is untouched.

**One assertion was lost rather than moved, and this note is where it is recorded.** `editor-remote-iiif.e2e.ts` used to prove the Svelte-component import by the absence of `<triiiceratops-viewer>` from the custom-element registry after the viewer had rendered. `viewer-reader.e2e.ts` has no equivalent, and ticket 15 was explicitly not allowed to change what that spec asserts, so **no test in this repository now observes the web-component export staying unregistered in the app that still uses triiiceratops.** The editor spec asserts the registry is empty there, which guards the editor's removal and says nothing about the viewer. Whoever next touches the viewer's unwarped view should add it back on that side.

triiiceratops is imported from its `./svelte` export as an ordinary Svelte component, not used via its web-component export.

Svelte 5 is a declared peer dependency (`peerDependencies: { svelte: '^5.0.0', react: '^19.0.0', vue: '^3.5.0' }`), so there is no version friction. More decisively, **ADR-0011 requires passing a custom OpenSeadragon `TileSource` that resolves tiles through the `ProjectStore`** — a JavaScript object or factory. That is natural as a Svelte prop and awkward as a web-component attribute, where it would mean reaching in through element properties. Web components also isolate styling, which would fight Tracy's theme (ADR-0016). The web-component export is the right choice for framework-agnostic embedding, which is not our situation. And since we maintain triiiceratops, any prop or plugin hook the integration needs is an upstream change rather than a workaround.

## Two IIIF parsers, one string between them

triiiceratops depends on **`manifesto.js`**; the alignment path uses **`@allmaps/iiif-parser`**. The bundle therefore carries two independent IIIF parsers. This is accepted — they do genuinely different jobs, manifest and collection navigation versus tile geometry and rendering — but two implementations of the same specification can interpret the same manifest differently, and that must never matter.

**The contract: triiiceratops selects; it hands over an image service URI, never a parsed object.** A user browses a manifest in triiiceratops (manifesto's reading of it), picks a canvas, and what crosses the boundary is a URI string. `@allmaps/iiif-parser` re-parses from that URI independently. No parsed structures are shared, so any disagreement between the two parsers about anything else in the manifest is invisible, because neither consumes the other's interpretation.

## Consequences

- **`dompurify` is already in triiiceratops' dependency tree**, satisfying ADR-0009's sanitisation requirement with the library we would have chosen anyway. This means it costs nothing extra to install — **not** that it can be imported without declaring it, which pnpm's isolated `node_modules` prevents. It is a catalog entry and a direct dependency of both apps. Note also that sanitisation is only half a Markdown pipeline; ADR-0009 names the renderer.
- triiiceratops exposes `./selectors` and `./testing` entry points, which is the intended way to read state such as the currently selected canvas rather than lifting it out by hand.
- Bundle weight includes both parsers. Accepted; the alternative is teaching one parser to do the other's job.

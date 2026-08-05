# Ingest surface, identifiers, and the Allmaps community alignment lookup

## What a user can add

Three IIIF shapes plus local files: a **Presentation Manifest**, a **Collection**, and a bare **Image `info.json`**. All three are handled by one `@allmaps/iiif-parser` call, and triiiceratops navigates the first two — which is where its manifest and collection handling earns its place in the architecture.

Collections matter more than they appear: a library hands a scholar *one* URL for an atlas, and without Collection support they must hunt for individual manifest URLs, which is exactly the friction that makes someone give up before aligning anything. Bare `info.json` matters because many institutions expose image services without manifests.

**Deferred:** IIIF Content State, because almost nothing generates it yet. **Arbitrary non-IIIF image URLs**, because CORS fails unpredictably and the failure is indistinguishable from a broken link — the local-file path covers that need reliably.

## Identifiers

- **Remote IIIF → `generateId(uri)`** from `@allmaps/id` (SHA-1 derived, deterministic).
- **Local file → `generateRandomId()`**, since there is no URI to hash.

The remote case is not an arbitrary choice: `generateId` produces **the same identifier Allmaps itself uses**, so the identifier is meaningful outside this tool. `@allmaps/id/sync` exists for contexts where async is unavailable, such as Svelte `$derived`.

## The community alignment lookup

Because remote identifiers match Allmaps', existing community georeferences can be found with a single call: `fetchAnnotationsFromApi(parsedIiif)` from `@allmaps/stdlib`, parsed with `@allmaps/annotation`. On adding a remote resource, offer "Import existing alignment — 3 found."

This delivers the authoring-versus-importing split established early on — authoring always happens in-app, importing an existing alignment is a separate, cheap path — in roughly a dozen lines rather than as a feature.

**The lookup is disclosed and switchable, and on by default.** It is a network call to `annotations.allmaps.org` carrying a hash of what the user is looking at. For a tool whose premise is "your data stays in your folder," silently contacting a third party on every image add is a small but real contradiction, and for a scholar working on unpublished or sensitive material, *which manifests this person is examining* is not nothing. So: a one-line note at the point of use ("checking Allmaps for existing georeferences") and a setting to disable it. On by default, because most users benefit and what leaks is a hash of an already-public URL.

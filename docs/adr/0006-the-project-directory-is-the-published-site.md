# The project directory is the published site

> **Amended by [ADR-0008](./0008-projects-live-in-a-workspace.md):** the published site root is the *workspace*, and a project is a directory inside it. Everything below still holds — publishing is additive and copies no data — but `index.html` and the viewer bundle live at the workspace root and are shared by every project.
>
> **Amended again by [ADR-0023](./0023-historical-maps-and-alignments-live-in-the-workspace.md):** the directory tree below is out of date. A project directory holds `project.json` and `annotations/` only — `images/` and `alignments/` live at the **workspace** root and are shared by every project, so that one historical map has one place on the earth however many projects use it.
>
> **Amended again by [ADR-0027](./0027-no-streaming-tiler-in-v1.md):** there are no `wasm-vips` chunks. The consequence below still holds for `terra-draw` and the tiler — a separate, lean viewer build is still the mechanism, and this is still the reason for it — but the dependency it names largest is gone from the repository, and the editor's own build is 10.3 MB smaller for it.

Publishing writes an `index.html` and a read-only viewer bundle *into* the project directory, additively, alongside the data already there. Publishing is then `git push`, or uploading the folder to any static host. No data is copied.

```
my-project/
├── project.json               # layer list, base map config, canonical URL if stamped
├── images/<image-id>/
│   ├── info.json              # level 0; id is a placeholder, resolved at load time (ADR-0004)
│   ├── manifest.json          # IIIF Presentation manifest, so triiiceratops can open it
│   └── <region>/<size>/0/default.jpg
├── alignments/<image-id>.json # IIIF Georeference Annotation
├── annotations/<layer-id>.geojson
└── index.html + viewer bundle # written by publish, removable, enumerable
```

The alternative — exporting to a separate output directory containing the viewer *and a copy of the data* — was rejected on tile bytes. A single large historical map is hundreds of megabytes to gigabytes of pyramid, and copying it on every publish is slow, and slowest precisely in OPFS, which is the constrained backend. Additive publishing is what makes the "publishing is almost an accident" claim actually true rather than aspirational. Loading the viewer from a CDN was rejected because it trades the entire offline story for a few hundred kilobytes.

## Consequences

- **`paths.relative: true` in the SvelteKit config is mandatory.** `paths.base` is baked at build time, but at build time we cannot know whether a user will publish to `username.github.io/some-repo/` or to a domain root. Relative asset paths are the only way one build serves both.
- **The viewer files must be an enumerable, recorded set**, so "Export as Zip (project only)" can exclude them and hand over clean data. Without that list the two export flavours are indistinguishable.
- **The read-only viewer uses a third `ProjectStore` adapter: HTTP `fetch` over relative paths.** OPFS, File System Access, and now HTTP — the same reading code with a different adapter, which is ADR-0001's abstraction paying out a third time.
- **The viewer is a separate, lean build** from the authoring app, sharing packages in one repo. Otherwise every published site ships terra-draw, the tiler, and the `wasm-vips` chunks no reader will ever use.
- The working project directory accumulates build output, so git diffs are noisy on re-publish, and the bundle can go stale relative to the data. The viewer stamps its version so the app can notice when a re-publish is due.

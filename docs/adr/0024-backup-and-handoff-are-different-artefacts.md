# Backup and handoff are different artefacts, and neither is a zip

> **Amended by [ADR-0037](./0037-import-copies-a-project-into-the-current-workspace.md):** a Project Bundle may now be imported into the current Workspace. Import avoids the Alignment collision described below by assigning every incoming Map Image a fresh identity and remapping the Project closure. Review remains available, but Import from Review is now a third exit.

Transfer serves two unrelated purposes, and one file format was serving neither well. They are now separate:

- **Backup and restore, and moving between computers: a tar of the whole Workspace.** This is how a user on Firefox, Safari, or an iPad keeps their work safe, because File System Access — and therefore "just copy the folder" — exists on none of them.
- **Handoff: a tar of one Project, self-contained**, holding `project.json`, its Annotations, and the Map Images and Alignments its Layers reference. It can be opened **only** in a Review Workspace, never merged into the recipient's own.

## Why not a zip

`exportProjectZip` refuses above 65,535 files, because `fflate` counts zip entries in a sixteen-bit field and emits no zip64 records. Measured: 70,000 entries produced an archive whose index claimed 4,464, and `unzipSync` read back 4,464 files **with no error at all** — a plausible-looking archive missing ninety-four per cent of a pyramid. The refusal exists so that never ships.

While a zip was one Project, that ceiling was reachable. As a **whole-Workspace** backup over a shared pool of large maps, exceeding it is the normal case, so the primary backup path would refuse for precisely the users who have no other one.

Tar has no central directory and no entry count, so the ceiling does not exist. Tiles are already-compressed JPEG and the exporter already knows it — `ALREADY_COMPRESSED` skips deflating them — so compression was buying almost nothing. Tar is also **streamable in both directions**, which is what makes the restore side fixable: a zip cannot be read without the central directory at its end, so restoring meant holding the whole archive in the JS heap and a ~400 MB backup could not be restored on an iPad at all.

Writing our own zip64 central directory was rejected. It is archive-format code whose failure mode is silent data loss, which is the bug we are escaping rather than a bug worth reimplementing.

**`modern-tar`** is the intended dependency: zero-dependency, Web Streams, USTAR with PAX extensions. A WASM implementation was considered and rejected — tar is a 512-byte header layout, not a computation, and the streaming tiler stalled precisely because npm ships only a threaded `wasm-vips` build needing COOP/COEP headers a static host cannot send ([ADR-0027](./0027-no-streaming-tiler-in-v1.md)). Adding a second WASM dependency to a path that must work on a static host would repeat that.

**Paths here exceed tar's 100-character `name` field** — `<project-dir-up-to-64>/annotations/<uuid>.geojson` is about 121 characters — so USTAR `prefix` or PAX handling is load-bearing and must be asserted with a deliberately long Project name, not assumed.

## Why handoff cannot merge

A handoff bundle carries `alignments/<image-id>.json`, and under [ADR-0023](./0023-map-images-and-alignments-live-in-the-workspace.md) there is exactly one Alignment per Map Image in a Workspace. Importing a colleague's bundle into your own Workspace would therefore either overwrite an Alignment two of your own Projects depend on, or be refused — and the propagation risk ADR-0023 accepts is one a user takes on for *their own* edits, not one that should arrive inside someone else's file.

So a bundle opens into a **Review Workspace**: a named, throwaway Workspace holding exactly that one Project. Several may exist at once, named after what was opened, so a teacher marking thirty submissions can switch between them freely and two students' conflicting Alignments of the same sheet never meet.

**A reviewed Project cannot be promoted into your own Workspace.** No "keep this". That is precisely what reintroduces the collision, and there is no honest answer to it. Review is open, look, discard; a scholar who wants a colleague's map in their own research adds the map themselves.

**Review is an action, not a mode you toggle.** A setting is something a user can forget they are inside, and the failure that creates is an afternoon's real work done in a Workspace built to be thrown away. So: a button on the hub, and while a Review Workspace is open, a persistent banner saying so and carrying the only two exits — back to your own Workspace, or discard this one.

## Consequences

- **Restoring a backup creates a new named Workspace and switches to it. It never overwrites and never merges.** Both real uses need this: moving to a new computer has nothing to overwrite, and recovering from damage is the exact moment the damaged Workspace must survive — a user cannot know what the backup predates until they have looked at both. Merging is the Alignment collision again.
- **The OPFS root holds several named Workspaces rather than being one.** This amends [ADR-0001](./0001-opfs-first-project-store.md), where the Workspace *is* the OPFS root. `OpfsProjectStore` already takes a directory-handle factory, so this is a change to what is passed in, not to the store. Without it, Review Workspaces would be subdirectories *of* the user's own Workspace — invisible in the Project list, since `listProjects` matches only top-level `<dir>/project.json`, but counted in its size and swept into its own backup.
- **"Which Workspace am I in" becomes a visible, first-class thing** rather than implicit, and is the same control that carries the Review banner's exits.
- **`navigator.storage.persist()` must be requested.** It is called nowhere in the tree today, so OPFS data is best-effort and evictable under disk pressure. That was tolerable when OPFS was a starter store; it is not, now that it is the primary home for a shared pool of gigabyte pyramids. This is a latent data-loss bug independent of transfer, and it is usually granted once the app is installed, which ADR-0012 already offers.
- **A backup excludes the published viewer files.** `index.html`, `_app/`, and `ballastella-site.json` are build output that `isViewerFile` already enumerates and `exportProjectZip` already skips for its data-only flavour. Including them would bloat every backup and restore a viewer bundle possibly older than the app — which ADR-0006 already warns goes stale against its data. A restored Workspace therefore needs one re-publish to be a site again, and the restore must say so rather than letting the user find a stale site.
- **A quota check before restoring or opening a bundle.** OPFS shares the origin's storage quota, so a second Workspace can fail part way through. `navigator.storage.estimate()` is the check, and refusing legibly beforehand beats failing at eighty per cent.

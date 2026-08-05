# OPFS-first Project Store, File System Access as a capability upgrade

All project data (IIIF tiles, `info.json`, annotations, manifests) is read and written through a single narrow `ProjectStore` interface — `read(path)`, `write(path, bytes)`, `list(prefix)`, `delete(path)`. The first and default implementation targets the **Origin Private File System (OPFS)**, which is supported in every modern browser. A second adapter targets the **File System Access API** (`showDirectoryPicker`) so a user can point a project at a real folder they can back up, Dropbox-sync, or commit to git.

We chose OPFS-first rather than File System Access-first even though the visible folder is the headline feature of the design. File System Access is Chromium-desktop-only (~28.6% global; Firefox has declared it "harmful" and will not ship it; Safari desktop and iOS do not support it; Chrome Android does not support it). Had we built against the directory picker first, the abstraction would have been shaped around one backend and the cross-browser fallback would have rotted, because day-to-day development happens in Chrome. Building OPFS first forces the interface to be honest and makes import/export a first-class path from day one.

## Consequences

- The first thing built is zip import/export, before anything is visible on screen. Accepted.
- Firefox/Safari/iPad users get a fully functional authoring tool whose project lives in invisible browser-managed storage; moving data in or out is an explicit zip operation.
- Chromium desktop users additionally get "put this project in a real folder," which is what makes the git-publish and Dropbox-backup stories work.
- Persisting a chosen directory across visits requires storing the `FileSystemDirectoryHandle` in IndexedDB and calling `requestPermission()` on return; true no-prompt persistence needs Chrome 122+.

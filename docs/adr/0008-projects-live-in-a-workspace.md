# Projects live in a workspace, and the workspace is the published site

> **Amended by [ADR-0023](./0023-historical-maps-and-alignments-live-in-the-workspace.md):** the tree below is out of date. `images/` and `alignments/` sit at the workspace root, shared by every project; a project directory holds `project.json` and `annotations/`. `images`, `alignments`, and `base-map` are therefore reserved directory names and must be refused when a project is created — `toDirectoryName('Images')` produces `images`, and the existing check runs only at publish time, which is too late.
>
> **Amended by [ADR-0024](./0024-backup-and-handoff-are-different-artefacts.md):** "a project zip is one project subdirectory" no longer describes transfer. Backup is a **tar of the whole workspace**; a project bundle is a separate artefact that opens only in a throwaway Review Workspace and is never merged into the recipient's own.
>
> The shared ~1 GB budget below is *more* significant under ADR-0023, not less: the workspace can hold historical maps no project uses, and publishing is additive so it cannot exclude them. The hosting warning must name that weight.
>
> **Amended by [ADR-0032](./0032-publish-means-the-remote.md): the "hub page" below is the *Front Page*.** "Hub" was doing two jobs — this record's reader-facing published root, and `ProjectHub.svelte`, which is the *editor's* Project list. Read every "hub page" here as **Front Page**, and note that a Project is now either on it or not, which this record's `?p=` addressing already makes possible at no cost: a Project absent from the Front Page is still reachable by its query parameter, and is therefore not private.
>
> **The "one repository to set up, not N" argument below is now load-bearing for a second reason.** Publishing is a push to a **Remote** — one repository per Workspace, bound in the app — so the count of repositories a student must create is the count this record already argued down to one.

A user chooses one **workspace** directory. Projects are directories inside it. Publishing writes a single `index.html` and one shared viewer bundle at the workspace root; that root, published, is a hub page listing every project, with a project addressed by query parameter — `/?p=amsterdam-1625`.

```
workspace/
├── index.html            # hub: lists projects; also the viewer entry point
├── _app/                 # one shared viewer bundle for all projects
├── amsterdam-1625/
│   ├── project.json
│   ├── images/<image-id>/{info.json, manifest.json, <pyramid>}
│   ├── alignments/<image-id>.json
│   └── annotations/<layer-id>.geojson
└── boston-1775/
    └── ...
```

This supersedes an earlier plan of one project per directory, each its own site. The workspace model wins on four counts:

- **One permission grant covers every project.** File System Access handles are per-directory and Chrome's persistent permission is per-handle, so one-project-per-directory means a separate prompt per project. Granting the workspace once is a materially better first run, at the point where users are most likely to give up.
- **One repository to set up, not N.** Creating a repo and enabling GitHub Pages is the hardest step in the whole workflow for a student. Once per semester beats once per assignment, and that lands directly on teaching-support burden.
- **One shared viewer bundle** rather than a copy of `maplibre-gl` per project.
- **The hub page is a feature**, not scaffolding: a scholar's portfolio at one address instead of a scatter of unrelated URLs.

Query-parameter addressing was chosen over per-project directory URLs and over hash routing because it is the only option with no build-time trickery — no SPA fallback file, no post-build asset-path rewriting, and no per-project artifacts to keep in sync when a project is renamed or deleted. SvelteKit's static adapter prerenders one page; the project is selected client-side. `?p=` URLs are fully shareable and citable. Pretty `/amsterdam-1625/` URLs remain available later as a purely additive publish step.

## Consequences

- **All projects share GitHub Pages' ~1 GB published-site budget** (with a hard 100 MB per-file limit in git), where previously each project had its own. This only bites when ADR-0007's "make an offline copy" is used on several large maps, but it is a *cliff* rather than a gradual slowdown: warn as the workspace approaches the limit rather than letting `git push` fail cryptically.
- **Publishing a single project standalone becomes a second output mode** rather than falling out for free. Deferred, not abandoned.
- **Project identity is its directory name within the workspace**, never its display name — display names are user-chosen and may collide.
- **A workspace can become unreachable** — moved, renamed, deleted, or permission declined. "Workspace not reachable" is a normal state with a "locate again" affordance, not an unhandled rejection at startup.
- A project zip is one project subdirectory; importing adds a subdirectory. Cleaner than under the per-project model.

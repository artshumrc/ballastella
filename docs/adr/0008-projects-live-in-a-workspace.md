# Projects live in a workspace, and the workspace is the published site

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

# A Sync mirrors an owned namespace and preserves the rest

A Sync builds one tree and moves one ref. What goes into that tree is the decision with the worst
failure mode anywhere in the project, so it is settled here.

**Inside the owned namespace, the Remote comes to hold what the Workspace holds. Outside it, nothing
is touched.**

The owned namespace is the scholar's own files:

```
images/**
alignments/**
base-map/tiles/**
<dir>/**            for any top-level <dir> where either side has <dir>/project.json
```

and, once the Workspace has Share Links ([ADR-0045](./0045-a-repository-holds-the-work-and-a-site-is-asked-for.md)),
the generated site as well:

```
ballastella-site.json
index.html
.nojekyll
_app/**
robots.txt
base-map/           fonts, sprites and extracts — never tiles, which are the scholar's
```

That `project.json` line is load-bearing and it is not invented: a Project already *is* a top-level
directory containing `project.json` — `listProjects` matches nothing else
([ADR-0008](./0008-projects-live-in-a-workspace.md)). So a Project the scholar deleted still has its
`project.json` on the Remote, is therefore inside the namespace, and can be removed with its whole
pyramid. A `docs/` folder they added is outside it and survives.

## Why not the two simpler rules

**Additive only** — never delete — leaks at a cliff. A deleted Project's tiles stay on the Remote
forever, invisible because the Front Page reads the `ballastella-site.json` we rewrite, but still
counted. ADR-0008 calls the ~1 GB Pages budget *"a cliff rather than a gradual slowdown"*, and this
arranges for the cliff to arrive from bytes the user believes they deleted.

**Full mirror** deletes the user's `README.md`, their `LICENSE`, a workflow they added, and — the one
that actually hurts — their **`CNAME`**, which is how Pages serves a custom domain. It would silently
move a scholar's cited address back to `username.github.io`, and do it again after they fixed it.

Because everything outside the owned namespace is preserved by default, **the only thing a Sync can
destroy is other Ballastella work.** That is what lets the confirmations in
[ADR-0044](./0044-sync-is-one-act-in-two-directions.md) be specific rather than a generic "the remote
has moved."

## Base Map tiles and pyramids both travel, and are warned about on three axes

`base-map/tiles/<key>/…` is inside the owned namespace, so an offline Base Map
([ADR-0025](./0025-no-base-map-ships-offline-is-per-project-and-opt-in.md)) travels with everything
else. Excluding it was considered and rejected: it would leave `baseMapBundled` true locally and
false on the Remote, so the local folder and the Remote would disagree about whether the site has
geography, and `readPublishedSite` would have to tolerate the divergence.

Measuring and warning is the answer instead, and it is what ADR-0008 already asks for — *"warn as the
workspace approaches the limit rather than letting `git push` fail cryptically."* `workspaceSize`
already returns `{ bytes, files }`, and its own comment anticipates this: *"'3 files' and '31 000
files' are different news."*

**Three budgets, and they bind at different moments because the two kinds of content load them
oppositely.**

| Axis | Ceiling | What drives it |
| --- | --- | --- |
| Bytes | ~1 GB — `STATIC_HOSTING_LIMIT_BYTES` | Base Map tiles, at `ESTIMATED_BYTES_PER_TILE` = 152 kB each |
| Files | ~40,000 — tree truncation (ADR-0031) | Map Image pyramids |
| Requests | 5,000 per hour | New blobs on a first Sync |

Base Map tiles are **file-cheap and byte-heavy**: `OFFLINE_TILE_LIMIT` refuses above 500 tiles for one
Project, about 76 MB. Pyramids are the reverse. `MAX_INGEST_PIXELS` is 528,006,700 — the measured
browser decode ceiling, not a modest number — so **one** image at the ceiling is roughly 11,000 tiles
and 330 MB. Three exceed the byte budget; four approach the file ceiling. The expectation that a very
large sheet will be a referenced IIIF image rather than a local pyramid (ADR-0007) is a reasonable
read of behaviour and is not a constraint, so no part of this may assume it.

**The request budget is the one nobody would think to warn about**, and it is the one that surprises:
11,000 new blobs is past the hourly limit, so a first Sync of a single maximal image spans three
rate-limit windows. That is said before it starts, from the count, and not discovered at request
5,001. `api.github.com` exposes `X-RateLimit-Remaining` and `X-RateLimit-Reset` to the browser
([ADR-0031](./0031-the-broker-exchanges-a-code-never-data.md)), so the remaining budget is readable
rather than inferred.

## The Synchronization Baseline

A Sync must fetch `GET /git/trees/{branch}?recursive=1` anyway — it is the only affordable way to know
which blobs already exist, and skipping unchanged files is what makes the second Sync take seconds
rather than an hour. So every path in the owned namespace arrives with its Remote blob SHA already in
hand.

Against that we keep **a Synchronization Baseline: path → blob SHA as of the last Sync that
succeeded.** One record, three purposes — skip what has not changed, tell a change from an addition,
and decide what may be removed. It is the whole reason the Workspace can be told apart from the
Remote at all, and with none, [ADR-0044](./0044-sync-is-one-act-in-two-directions.md) removes nothing
from either side.

Comparing against a bare commit SHA was rejected: it treats *anything* moving as a divergence,
including the user's own README edit on github.com, which trains people to force.

Automatic status checks must not obtain the local side by rereading and hashing a multi-gigabyte
Workspace. A durable local-change index at the managed Workspace write and delete seam records paths
changed through Ballastella since the Baseline, and an automatic check combines it with the Remote
tree. A deliberate Sync still hashes the complete local source namespace, both as a correctness check
and because a chosen folder can be edited outside Ballastella where no write seam observes it.

## Consequences

- **The Baseline is installation-local**, keyed by Workspace and backing as the write-ahead journal
  already is. It cannot live in the tree it commits, and it is worthless to anybody else. A Sync whose
  Baseline write fails still succeeded remotely, and leaves Remote Status at **Cannot tell** rather
  than retaining stale evidence.
- **A first Sync into a populated repository is as expensive as sending one and must resume.** The
  tree call's blob SHAs let it skip anything already present locally, which is the same hashing
  utility the upload needs — one implementation, both directions.
- **Push rights are checked when a Remote is bound, not when 4,000 tiles have finished uploading.**
  "You do not have push rights" discovered after a ten-minute upload is the worst possible moment to
  learn it.
- **A Sync writes no author or committer**, so a commit carries the signed-in account and nothing
  Ballastella inferred about who a scholar is.
- **The credential lives behind its own interface, outside `ProjectStore`, and is never reachable
  through it.** What must hold for any implementation is that the token cannot reach the write-ahead
  journal, `ballastella-site.json`, a Backup tar, or a Project Bundle. `export-workspace-tar.ts` walks
  the store, so a token stored *in* the Workspace would be backed up and mailed to a colleague, and
  sent to a public repository by the next Sync.

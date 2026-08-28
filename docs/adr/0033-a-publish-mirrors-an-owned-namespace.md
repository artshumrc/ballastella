# A Publish mirrors an owned namespace and preserves the rest

> **Amended by [ADR-0038](./0038-workspace-synchronization-is-explicit-and-baseline-based.md):** the publish manifest becomes a Synchronization Baseline established by Open, Update, or Publish. Update from GitHub is the explicit inbound operation; the Remote relationship itself is local-only and is not learned from synchronized content.

A Publish builds one tree and moves one ref. What goes in that tree is the decision with the worst
failure mode anywhere in publishing, so it is settled here.

**Inside the owned namespace, the Remote becomes exactly the Workspace: additions, updates, and
deletions. Outside it, nothing is touched.**

The owned namespace is:

```
ballastella-site.json
index.html
.nojekyll
_app/**
images/**
alignments/**
base-map/**
<dir>/**            for any top-level <dir> where the Remote has <dir>/project.json
```

That last line is the load-bearing one, and it is not invented: a Project already *is* a top-level
directory containing `project.json` — `listProjects` matches nothing else
([ADR-0008](./0008-projects-live-in-a-workspace.md)'s amendment note). So a Project deleted locally
still has its `project.json` on the Remote, is therefore inside the namespace, and is removed with its
whole pyramid. A `docs/` folder the scholar added is outside it and survives.

## Why not the two simpler rules

**Additive only** — never delete — leaks at a cliff. A deleted Project's tiles stay on the Remote
forever, invisible because the Front Page reads the `ballastella-site.json` we rewrite, but still
counted. ADR-0008 calls the ~1 GB Pages budget *"a cliff rather than a gradual slowdown"*, and this
arranges for the cliff to arrive from bytes the user believes they deleted.

**Full mirror** deletes the user's `README.md`, their `LICENSE`, a workflow they added, and — the one
that actually hurts — their **`CNAME`**, which is how Pages serves a custom domain. A Publish would
silently move a scholar's cited address back to `username.github.io`, and the next Publish would do it
again after they fixed it.

Because the owned namespace is preserved-by-default outside itself, **the only thing a Publish can
destroy is other Ballastella work.** That is what lets the refusals below be specific rather than a
generic "the remote has moved."

## Base Map tiles and pyramids both travel, and are warned about on three axes

`base-map/tiles/<key>/…` is inside the owned namespace, so an offline Base Map
([ADR-0025](./0025-no-base-map-ships-offline-is-per-project-and-opt-in.md)) is published along with
everything else. Excluding it was considered and rejected: it would leave `baseMapBundled` true locally
and false on the Remote, so the local folder and the published record would disagree about whether the
site has geography, and `readPublishedSite` would have to tolerate the divergence.

Measuring and warning is the answer instead, and it is what ADR-0008 already asks for — *"warn as the
workspace approaches the limit rather than letting `git push` fail cryptically."* `workspaceSize` already
returns `{ bytes, files }`, and its own comment anticipates this: *"'3 files' and '31 000 files' are
different news."*

**Three budgets, and they bind at different moments because the two kinds of content load them
oppositely.**

| Axis | Ceiling | What drives it |
| --- | --- | --- |
| Bytes | ~1 GB — `STATIC_HOSTING_LIMIT_BYTES` | Base Map tiles, at `ESTIMATED_BYTES_PER_TILE` = 152 kB each |
| Files | ~40,000 — tree truncation (ADR-0031) | Map Image pyramids |
| Requests | 5,000 per hour | New blobs on a first Publish |

Base Map tiles are **file-cheap and byte-heavy**: `OFFLINE_TILE_LIMIT` refuses above 500 tiles for one
Project, about 76 MB. Pyramids are the reverse. `MAX_INGEST_PIXELS` is 528,006,700 — the measured
browser decode ceiling, not a modest number — so **one** image at the ceiling is roughly 11,000 tiles
and 330 MB. Three exceed the byte budget; four approach the file ceiling. The expectation that a very
large sheet will be a referenced IIIF image rather than a local pyramid (ADR-0007) is a reasonable read
of behaviour and is not a constraint, so no part of this may assume it.

**The request budget is the one nobody would think to warn about**, and it is the one that surprises:
11,000 new blobs is past the hourly limit, so a first Publish of a single maximal image spans three
rate-limit windows. That is said before it starts, from the count, and not discovered at request 5,001.
`api.github.com` exposes `X-RateLimit-Remaining` and `X-RateLimit-Reset` to the browser (ADR-0031), so
the remaining budget is readable rather than inferred.

## The publish manifest, and the two refusals

A Publish must fetch `GET /git/trees/{branch}?recursive=1` anyway — it is the only affordable way to
know which blobs already exist, and skipping unchanged files is what makes the second Publish take
seconds rather than an hour ([ADR-0031](./0031-the-broker-exchanges-a-code-never-data.md)). So every
path in the owned namespace arrives with its Remote blob SHA already in hand.

Against that we keep **a publish manifest: path → blob SHA as of the last successful Publish or
Clone.** One record, two purposes — skip what has not changed, and detect what somebody else wrote.

- **At bind.** If the Remote carries a `ballastella-site.json` listing Projects this Workspace does not
  have, **refuse to bind** and name them. The remedy is to Clone it instead. Without this, the first
  Publish from a second machine deletes work.
- **At every Publish.** For each path in the owned namespace, if the Remote's blob SHA is neither ours
  nor what the manifest last saw, somebody else wrote it. **Refuse, and name the files.** Two remedies:
  Clone the Remote into a new Workspace to see what is there, or publish anyway and replace it.

Comparing against a bare commit SHA was rejected: it refuses whenever *anything* moved, including the
user's own README edit on github.com, which trains people to force. Three-way merging `project.json`,
GeoJSON, and Alignments was rejected outright — it is the collision ADR-0024 already refuses to answer,
and there is no honest resolution for two Alignments of one sheet.

**With no manifest** — a first Publish, or one lost with browser storage — fall back to the bind check
and **say plainly that we cannot tell** whether the Remote holds newer work. Refuse if the owned
namespace on the Remote is non-empty.

## Consequences

- **The manifest is local-only**, keyed by Workspace and backing as the write-ahead journal already is.
  It cannot live in the tree it commits, and it is worthless to anybody else.
- **`remote.json` at the Workspace root holds the binding only** — owner, repository, branch —
  following `review.json`'s precedent. It is *inside* the published tree deliberately: the binding never
  changes, so it causes no churn, and a Clone learns its own Remote for free.
- **A Publish writes `.nojekyll` itself, unconditionally.** Jekyll drops every path beginning with `_`
  and the bundle lives in `_app/`, so without the file a published site serves a blank page. The site
  that needs it is the author's — the Workspace they push to a repository of their own, by hand — and a
  Publish is now that hand. `scripts/check-nojekyll.mjs` must be extended to the synced tree
  or this regresses to a blank page on a scholar's domain with the reason only in a console.
- **A Clone is as expensive as a first Publish and must resume.** The tree call's blob SHAs let it skip
  anything already present locally, which is the same hashing utility the upload needs — one
  implementation, both directions.
- **Push rights are checked when a Remote is bound, not when 4,000 tiles have finished uploading.**
  "You do not have push rights" discovered after a ten-minute upload is the worst possible moment to
  learn it.
- **The credential lives behind its own interface, outside `ProjectStore`, and is never reachable
  through it.** `sessionStorage` is the first implementation, not the contract — a durable "remember me"
  may replace it later. What must hold for any implementation is that the token cannot reach the
  write-ahead journal, `ballastella-site.json`, a Backup tar, or a Project Bundle. `export-workspace-tar.ts`
  walks the store, so a token stored *in* the Workspace would be backed up and mailed to a colleague.

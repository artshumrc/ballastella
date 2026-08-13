# A Workspace becomes a commit

## What to build

The publish engine, in `@ballastella/core`, with no UI. Given a `ProjectStore`, a token, and a Remote, it
plans a publish and then performs one: it lists the Remote's tree, uploads only blobs the Remote does not
already have, builds one tree, one commit, and moves the ref. Nothing is visible on the Remote until the
ref moves.

The plan is the interesting half. It reports what will be sent — files and bytes — and warns on **three**
budgets, because the two kinds of content load them oppositely (ADR-0033): offline Base Map tiles are
file-cheap and byte-heavy at ~152 kB each; Historical Map pyramids are the reverse. It **refuses** rather
than warns when the Remote's tree came back truncated.

The commit's tree mirrors the Workspace inside an owned namespace and preserves everything outside it, so
a scholar's `CNAME` survives and a deleted Project's pyramid is reclaimed.

## Where to start

- `packages/core/src/publish/publish.ts` — read `planPublish`, `publishSite`, `PublishPlan`,
  `PublishedSite`, and `publishedSiteStaleness`. This is the model to follow and extend, not replace: it
  already computes a plan, warns, writes, and records. The new engine sits *beside* it — local publish
  writes the viewer into the Workspace, then this uploads the Workspace.
- `packages/core/src/project/workspace-size.ts` — `workspaceSize` already returns `{ bytes, files }`, and
  its comment already anticipates this ticket: *"'3 files' and '31 000 files' are different news."*
  `STATIC_HOSTING_LIMIT_BYTES`, `crossesHostingLimit`, `hostingLimitWarning`, and `describeBytes` are all
  here and all bytes-only today.
- `packages/core/src/base-map/tile-cache.ts` — `BASE_MAP_TILE_ROOT` is `base-map/tiles/`,
  `OFFLINE_TILE_LIMIT` is 500, `ESTIMATED_BYTES_PER_TILE` is 152 000. Read `tileBudget` for the house
  pattern of "count first, refuse legibly, quote the number in the refusal."
- `packages/core/src/store/project-store.ts` — the engine reads through `list`, `read`, and `size` only,
  so it is backing-agnostic by construction. Do not branch on backing anywhere.
- `packages/core/src/transfer/viewer-files.ts` — `VIEWER_FILE_PATHS` and `isViewerFile` enumerate the
  viewer bundle. The owned namespace overlaps this; reuse the enumeration rather than re-listing it.
- ADR-0033 (`docs/adr/0033-a-publish-mirrors-an-owned-namespace.md`) is this ticket's specification.
  Read it before writing code.

## Contract

**The owned namespace.** Inside it the Remote becomes exactly the Workspace — additions, updates,
deletions. Outside it, paths present on the Remote are carried into the new tree unchanged.

```
ballastella-site.json
index.html
.nojekyll
remote.json
_app/**
images/**
alignments/**
base-map/**
<dir>/**     for any top-level <dir> where THE REMOTE has <dir>/project.json
```

The last rule is the load-bearing one and the easiest to get wrong. It is tested against **the Remote's**
tree, not the local Workspace's — that is exactly how a locally deleted Project is recognised as ours and
removed with its pyramid. A `docs/` folder or a `.github/` directory the scholar added has no
`project.json` and therefore survives. `CNAME` survives. `README.md` survives.

**`.nojekyll` is written into every commit, unconditionally**, whether or not it exists locally. See
`fork-and-publish` ticket 01: Jekyll drops every path beginning with `_`, the bundle lives in `_app/`, and
the site that needs the file is the author's. A publish is now the hand that pushes it.

**The three budgets.** The plan reports all three and says which, if any, is a problem:

| Axis | Ceiling | Behaviour |
| --- | --- | --- |
| Bytes | `STATIC_HOSTING_LIMIT_BYTES` | warn |
| Files | 40 000 | **refuse** |
| New blobs vs remaining hourly requests | read from `X-RateLimit-Remaining` | warn, naming the reset time |

**A truncated tree is a refusal, not a warning.** `GET /git/trees/{ref}?recursive=1` truncates at 100 000
entries or a 7 MB response **and returns 200 with `truncated: true`**. Proceeding would re-upload
everything and then write a commit missing most of the Workspace — ADR-0024's zip disaster in a new
costume. Refuse before any blob is posted, and quote the file count in the message.

**The publish manifest.** `path → blob SHA`, returned by a successful publish so a caller can persist it.
Used here for one purpose only: skip `POST /git/blobs` for any path whose locally computed SHA already
appears in the Remote's tree. Ticket 05 adds the second purpose.

**Rate-limit exhaustion mid-publish stops legibly**, reporting how many files were sent, that nothing is
visible on the Remote yet, and when the budget resets. It does not retry in a loop.

**Signature.** The engine takes an opaque bearer token and a `fetch` shim and **imports nothing
auth-flow-specific**:

```ts
publishToRemote(store: ProjectStore, options: {
  token: string;
  remote: { owner: string; repository: string; branch: string };
  plan: RemotePublishPlan;
  fetch?: FetchFn;
  onProgress?: (seen: { files: number; totalFiles: number; requestsRemaining: number | null }) => void;
}): Promise<{ commit: string; manifest: ReadonlyMap<string, string> }>
```

No `if (authMethod === …)` anywhere in this module or below it.

### User Stories

9, 10, 11, 12, 15, 16, 17, 18, 19, 61, 62, 63.

## Out of scope

- **No UI, no dialog, no navigation bar.** Ticket 04. The engine is driven by tests here.
- **No conflict detection.** The manifest is *produced* here and *compared* in ticket 05. Do not add the
  foreign-write check, the bind-time subset refusal, or the no-manifest fallback.
- **No `remote.json` reading or writing.** Ticket 03 owns the binding document. This engine takes the
  Remote as a parameter.
- **No front-page flag.** Ticket 06.
- **No Clone.** Ticket 07. Do not add a download path "while we're in the file".
- **Do not modify `publishSite` or `planPublish`'s existing behaviour.** Local publish keeps working
  exactly as it does. Add beside; do not refactor the existing publish into a shared abstraction — that
  is a tempting wrong turn and it puts a network concern inside a function that has none.
- **Do not delete anything from `packages/core/src/publish/` or `transfer/`.** SPEC "Out of scope" item 8.
- **No `isomorphic-git`, no tarball endpoint, no packfiles.** ADR-0031 explains why both are closed.

## Acceptance criteria

- [ ] A Workspace with one small Project publishes: the fake's tree afterwards holds every Workspace file
      at its Workspace-relative path, plus `.nojekyll`.
- [ ] Publishing the same unchanged Workspace a second time posts **zero** blobs (assert the fake's
      counter) and still moves the ref.
- [ ] Changing one Annotation and publishing again posts exactly one blob.
- [ ] A `CNAME`, a `README.md`, and a `docs/guide.md` present on the Remote but absent locally are all
      present after a publish.
- [ ] A Project directory present on the Remote with a `project.json`, absent locally, is **gone** after a
      publish, along with every file beneath it.
- [ ] A truncated tree response causes a refusal, no blob is posted, and the message quotes a file count.
- [ ] The plan warns when bytes exceed `STATIC_HOSTING_LIMIT_BYTES`, refuses above 40 000 files, and warns
      when new blobs exceed the remaining hourly requests.
- [ ] An empty repository (no ref) publishes by creating the ref.
- [ ] Rate-limit exhaustion partway through reports files sent and the reset time, and the ref has not
      moved.
- [ ] Offline Base Map tiles under `base-map/tiles/` are present on the Remote after a publish.

```
pnpm --filter @ballastella/core test
pnpm check
pnpm lint
```

Success: the new tests pass; the existing `publish.test.ts` still passes unchanged.

## Blocked by

- Ticket 01

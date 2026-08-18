# Clone a Workspace from a Remote

## What to build

Naming a public GitHub repository downloads the Workspace inside it into a **new named Workspace**, bound to
that Remote, and switches to it. It never merges into an existing Workspace and never overwrites one.

It needs **no credential at all**. Reading a public repository requires none, so a student with no GitHub
account can seed a Workspace from their instructor's Remote. This is the story the epic is most likely to be
used for and the one that costs least to deliver.

It is as expensive as a first publish — thousands of files for one Map Image — so it reports per-file
progress and **resumes** rather than restarting.

## Where to start

- `packages/core/src/transfer/restore-workspace-tar.ts` and `apps/editor/src/lib/workspace-storage.svelte.ts`'s
  `restoreFrom`. Clone's semantics are restore's semantics with a different source of bytes: create a new
  named Workspace, fill it, switch to it. Reuse that path rather than inventing a second one.
  `e2e/editor-transfer.e2e.ts` and `e2e/editor-backup.e2e.ts` are the prior art for driving it.
- `packages/core/src/store/http-project-store.ts` — `createHttpProjectStore` already reads a published
  Workspace over HTTP with an injectable `fetch` and a `resolve` for turning a store path into a URL. This is
  ADR-0006's third adapter and it is most of the read side already.
- `packages/core/src/store/opfs-workspaces.ts` — `createOpfsWorkspace`, `toWorkspaceName`,
  `MAX_WORKSPACE_NAME_LENGTH`, `WorkspaceNameExhaustedError`. Naming the new Workspace goes through here.
- ADR-0031's consequences, on `codeload`. Read it before reaching for a tarball.
- Ticket 03's `remote.json` writer, for binding the result.

## Contract

**Two hosts, both CORS-open, and neither is `codeload`.**

```
GET https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1   → the whole file list + blob SHAs
GET https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}             → the bytes
```

**Do not use the tarball endpoint.** `GET /repos/{o}/{r}/tarball/{ref}` redirects to `codeload.github.com`,
which answers `access-control-allow-origin: https://render.githubusercontent.com` — a specific origin, not
`*` — so a browser fetch is blocked. It is the obvious approach, `restore-workspace-tar.ts` already exists to
receive it, and it fails only at runtime with a CORS error. ADR-0031 records this so nobody spends a session
rediscovering it.

**Read from `raw.githubusercontent.com`, not from the Remote's Pages site.** Both would work, but raw reads
the branch tip rather than a possibly-stale Pages deploy, and needs no Pages build — so a Clone works on a
repository published thirty seconds ago.

**Refuse a truncated tree**, for exactly ticket 02's reason: a truncated list yields a Workspace missing most
of a pyramid, silently, with no error anywhere.

**Resume.** The tree call gives a blob SHA per path. Any file already present locally whose computed SHA
matches is skipped. This is ticket 01's SHA utility used a second time, in the other direction — do not write
a second hashing path.

**The result is bound.** A Clone writes `remote.json` for the repository it came from. The binding is
provenance, not permission: a Reader who cloned somebody else's Workspace gets a bound Workspace and
discovers at publish time that they cannot push, which costs nothing. This differs from a restored Backup
deliberately (ADR-0032) — with a Clone the user named that repository.

**A quota check before starting.** OPFS shares the origin's quota and a second Workspace can fail part way
through. `navigator.storage.estimate()` is the check and ADR-0024 already requires it for restore; refusing
legibly beforehand beats failing at eighty per cent.

**Public repositories only**, and the refusal says so. A private repository would work with a `Bearer` header
on both calls, but that makes a credential a prerequisite for the one operation that needs none.

### User Stories

43, 44, 45, 46, 47, 48.

## Out of scope

- **No credential, no auth header, no private repositories.** SPEC "Out of scope" item 4.
- **No tarball, no `codeload`, no `isomorphic-git`.** SPEC "Out of scope" item 2.
- **No merging into an existing Workspace, and no single-Project import into one.** Ticket 08 covers the
  one-Project case and it goes into a Review Workspace, for ADR-0024's reason.
- **No Front Page link and no `?clone=` URL parameter.** Ticket 09. This ticket's entry point is inside the
  editor.
- **Do not change `restoreFrom`'s behaviour** for tar files. Add beside it.
- **No branch selection UI.** The branch comes from the Remote's default, `main`.
- **Do not weaken the e2e network fence.** The fake from ticket 01, routed by ticket 04's support module, is
  where the bytes come from.

## Acceptance criteria

- [ ] Naming a public repository holding a published Workspace creates a new named Workspace, fills it, and
      switches to it.
- [ ] Cloning with no credential present succeeds.
- [ ] The cloned Workspace's Projects, Map Images, Alignments, and Annotations are all readable, and a
      Project opens and renders.
- [ ] The cloned Workspace is bound to the repository it came from.
- [ ] An existing Workspace with the same content is untouched — nothing is merged and nothing is
      overwritten.
- [ ] An interrupted Clone, resumed, skips the files already present and does not re-download them (assert
      the fake's request counter).
- [ ] Per-file progress is reported and announced.
- [ ] A truncated tree response is refused before any byte is written.
- [ ] Insufficient quota is refused before any byte is written, naming the shortfall.
- [ ] A name collision with an existing Workspace produces a distinct name rather than overwriting.
- [ ] No request reaches `codeload.github.com` — asserted by the fake refusing it.

```
pnpm --filter @ballastella/core test
pnpm test:e2e editor-clone-remote
pnpm test:e2e editor-transfer
pnpm check
pnpm lint
```

Success: the new spec passes and restore/backup still do.

## Blocked by

- Ticket 03

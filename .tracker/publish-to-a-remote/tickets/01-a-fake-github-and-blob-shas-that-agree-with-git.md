# A fake GitHub, and blob SHAs that agree with git

## What to build

Two pieces of foundation, both in `@ballastella/core`, both used by every later ticket in this epic.

**A blob-SHA utility.** Given bytes, produce the hex SHA-1 git would give the same bytes:
`sha1("blob " + byteLength + "\0" + bytes)`. This is the whole basis of incremental upload, conflict
detection, and a resumable Clone — three features that, if this is wrong, are wrong together, silently,
in the same direction.

**A fake GitHub**, exported as a test fixture. An in-memory object store that answers the five requests
this epic makes, behind a `FetchFn`. It is not a mock: it stores real bytes, computes real blob SHAs,
and its trees are readable back. Later tickets assert *what arrived at the Remote* by reading it.

This is a prefactor. It ships no user-facing behaviour and satisfies no user story; it exists so the ten
tickets after it can assert against one shared fake rather than ten private ones.

## Where to start

Read these three first, in this order:

- `packages/core/src/injection/store-image-fetch.ts` — `FetchFn` is the seam. It is
  `(input: Request | string | URL, init?: RequestInit) => Promise<Response>`, i.e. a `fetch` drop-in.
- `packages/core/src/store/http-project-store.ts` around `createHttpProjectStore` — the established
  pattern: `readonly fetch?: HttpFetch` on an options object, defaulting to the page's own. Copy this
  shape exactly. `packages/core/src/places/lookup.ts` does the same thing and is the second precedent.
- `e2e/support/iiif-hosts.ts` — read its header comment in full. It exists because three specs grew
  their own IIIF hosts and two of them could disagree about what a service does while both stayed
  green. That is the failure this ticket prevents in advance.

For the fixture-export convention, `packages/core/src/store/project-store-suite.ts` and
`packages/core/src/store/directory-handle-fixture.ts` are the precedents: test material lives in `src/`
and is exported from the package.

`packages/core/vitest.config.ts` defines a `node` project (`src/**/*.test.ts`) and a `browser` project
(`src/**/*.browser.test.ts`). This ticket's tests are `node`.

## Contract

**The SHA utility** takes `Uint8Array` and returns a lowercase 40-character hex string. It must work in
Node and in a browser — use `crypto.subtle.digest('SHA-1', …)`, which both have, rather than a Node-only
import. It is `async` for that reason. Do not add a synchronous variant.

**The fake** is constructed with an owner, a repository name, and optionally a starting tree, and exposes:

- a `FetchFn` to hand to the code under test;
- a way to read the current tree back as `path → bytes`;
- a way to read the current commit SHA and its parent chain;
- counters for how many blob POSTs were made, so a test can assert "the second publish uploaded nothing"
  without asserting a call order.

It answers these, and refuses anything else with a 404 so an unimplemented path fails loudly:

```
GET   /repos/{owner}/{repo}/git/trees/{ref}?recursive=1
        → { sha, tree: [{ path, mode, type, sha, size }], truncated }
POST  /repos/{owner}/{repo}/git/blobs          { content, encoding: "base64" } → { sha }
POST  /repos/{owner}/{repo}/git/trees          { tree: [{ path, mode, type, sha }] } → { sha }
POST  /repos/{owner}/{repo}/git/commits        { message, tree, parents } → { sha }
PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}  { sha, force } → { ref, object: { sha } }
POST  /repos/{owner}/{repo}/git/refs           { ref, sha } → { ref, object: { sha } }
GET   /repos/{owner}/{repo}                    → { permissions: { push, admin } }
POST  /repos/{owner}/{repo}/pages              { source: { branch, path } } → 201 | 409
GET   /{owner}/{repo}/{branch}/{path}          (raw host) → the bytes
```

It must be configurable to reproduce, on demand, each failure the engine has to handle:

- a **truncated** tree response (`truncated: true`);
- a rate-limit response with `X-RateLimit-Remaining: 0` and an `X-RateLimit-Reset` header;
- `403` on push, and `permissions.push === false`;
- a `409` from the Pages endpoint (already enabled);
- an empty repository (no ref at all, so `GET .../git/trees/{ref}` is a 404).

Rate-limit headers must be set on **every** response, because the engine reads the remaining budget as
it goes and the browser can only see them because `api.github.com` lists them in
`access-control-expose-headers`.

### User Stories

None directly. This ticket exists to make stories 9–24, 43–48, and 63 testable.

## Out of scope

- **No engine.** No publish, no plan, no upload loop, no owned-namespace logic. Ticket 02 owns all of
  that. It is tempting to write "just the upload" here; do not.
- **No Playwright support module.** The `page.route` wrapper is ticket 04's, where the first e2e spec
  needs it. Building it now means building it against no consumer.
- **No real network, ever.** `packages/core/vitest-setup/refuse-network.ts` already refuses `fetch` and
  Node's HTTP modules in the `node` project. Do not weaken it, and do not add an allowance.
- **Do not touch** `packages/core/src/store/`, `publish/`, or `transfer/`. This ticket adds files; it
  changes none.
- **No `GitProvider` abstraction.** GitHub only. See SPEC "Out of scope" item 1.

## Acceptance criteria

- [ ] The SHA utility returns git's own values for empty content, a short text blob, and a binary blob.
- [ ] The fake round-trips: bytes written through the blob/tree/commit/ref sequence are readable back at
      their paths, and the tree call reports the SHAs the utility computes for those same bytes.
- [ ] Each of the five configurable failures above can be produced and is asserted in a test.
- [ ] Every fake response carries `X-RateLimit-Remaining` and `X-RateLimit-Reset`.
- [ ] An unimplemented path returns 404 rather than succeeding vacuously.
- [ ] Both are exported from `@ballastella/core`.

The SHA values to assert against are git's, obtained with:

```
printf '' | git hash-object --stdin                    # e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
printf 'hello' | git hash-object --stdin               # b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0
printf '\x00\x01\x02\xff' | git hash-object --stdin
```

Take the third value from your own machine and inline it in the test with the command in a comment, so
a future reader can re-derive it.

```
pnpm --filter @ballastella/core test
pnpm check
pnpm lint
```

Success: the new tests pass, `tsc --noEmit` is clean, prettier and eslint are clean.

## Blocked by

None - can start immediately.

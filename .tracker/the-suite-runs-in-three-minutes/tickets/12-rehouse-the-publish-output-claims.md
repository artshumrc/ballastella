# 12 — Rehouse the Publish output claims to Seam 1

## What to build

`editor-publish.e2e.ts` is 30 tests, and twelve of them call the full ingest bootstrap. A Publish produces **a directory of files** (ADR-0006), and "these files appear, with this content, and no image bytes are duplicated" is a Seam 1 question that this file currently asks through a browser.

Rehouse the file-set claims. Keep at Seam 2 exactly what needs a served site.

## Where to start

- `e2e/editor-publish.e2e.ts` — note which tests call `start(page)` from the alignment support module; those are the twelve paying the most.
- `e2e/support/published-site.ts` and `static-site.ts` — the harness that writes a Workspace to disk and serves it at a root and a subdirectory. Its header explains why the subdirectory is the load-bearing half.
- `packages/core/src/publish/publish.ts` / `publish.test.ts` — where the file-set claims belong; some may already be there.
- `packages/core/src/remote/publish-manifest.test.ts`, `publish-to-remote.test.ts` — adjacent Seam 1 coverage of the Remote half (ADR-0032, ADR-0033).
- ADR-0006 for what a Published Site is; ADR-0004 and SPEC story 92 for the canonical-URL stamp.

## Contract

- **What stays at Seam 2, without exception**: that the site works when *served* — the viewer bundle loading, assets resolving at a domain root **and** in a subdirectory, and the absence of a return link when the publishing instance is `localhost`. ADR-0006's entire claim is about relative paths against real served files, and nothing below Seam 2 can check it.
- **What moves**: the file set that a Publish writes; that a data-only artefact excludes exactly the viewer set; that no image bytes are duplicated; that `info.json` ids are stamped with the canonical URL when one is recorded and left as the ADR-0004 placeholder when not; that a Project off the Front Page is absent from the list and still reachable by `?p=`.
- **The Front Page listing is two claims, not one.** Which Projects are *written* into the site record is Seam 1; what a Reader *sees* on the Front Page is `viewer-reader.e2e.ts`'s and is protected. Do not collapse them.
- Every retired Seam 2 test names its replacement.

### User Stories

5, 9, 31.

## Out of scope

- `viewer-reader.e2e.ts`. Protected in its entirety by this epic; it is the Reader's only seam and it is already the cheapest per test in the suite.
- The Remote flows — ticket 13.
- Changing what a Publish writes, the stamp, or the site record schema.

## Acceptance criteria

- [ ] The published file set, the data-only exclusion, and the no-duplicated-bytes claim are asserted at Seam 1.
- [ ] The canonical-URL stamp is asserted at Seam 1 in both states — stamped and placeholder.
- [ ] The served-at-two-base-paths tests are untouched at Seam 2.
- [ ] The number of tests in this file calling the ingest bootstrap is reduced, and the remaining callers are justified in the commit.
- [ ] Each moved claim is watched to fail once against a deliberate break.
- [ ] Every retired Seam 2 test is named alongside its replacement.
- [ ] `pnpm test:e2e editor-publish.e2e.ts` passes; count and wall time recorded before and after.
- [ ] `pnpm precommit lint check test` passes.

```bash
pnpm test:e2e editor-publish.e2e.ts
pnpm --filter @ballastella/core test
pnpm precommit lint check test
```

Success: the file set asserts in Node; the served site still asserts over HTTP at both base paths.

## Blocked by

- 01

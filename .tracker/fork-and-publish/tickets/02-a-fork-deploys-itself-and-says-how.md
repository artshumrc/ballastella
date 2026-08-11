# 02 — A fork deploys itself, and says how

## What to build

A GitHub Pages workflow that builds and deploys the editor, and the documentation that neither a
forker nor an author had.

**Fulfills** — [SPEC.md](../../ballastella-v1/SPEC.md) stories 99, 100, and 101, and completes the
publishing half of story 81 by documenting the part ADR-0014 deliberately left to prose.

## Where to start

[ADR-0006](../../../docs/adr/0006-the-project-directory-is-the-published-site.md) (one build serves a
domain root and a subpath), [ADR-0008](../../../docs/adr/0008-projects-live-in-a-workspace.md) (one
repository per Workspace, not per Project),
[ADR-0020](../../../docs/adr/0020-base-map-catalog-author-default-and-reader-switching.md) and
[ADR-0025](../../../docs/adr/0025-no-base-map-ships-offline-is-per-project-and-opt-in.md) (the catalog
is deployment configuration; the archive is borrowed), and
[ADR-0014](../../../docs/adr/0014-v1-scope-fences.md) (no in-app git — publishing produces files and
committing is documented prose).

Ticket 01 first: the workflow runs its fence, and the documentation describes the file it ships.

## The absence

`.github/workflows/` held `ci.yml`. Nothing built the app for a host. A fork's Pages source defaults
to *Deploy from a branch*, which serves the repository root, so a forker who enabled Pages got a
directory listing of `README.md` and `package.json` — and no error, because nothing was wrong. Every
constraint the fork story needs was satisfied; the story still could not happen.

## Contract

### The workflow

`.github/workflows/pages.yml`, on push to `main` and on `workflow_dispatch`, deploys
`apps/editor/build`. Not the viewer: the viewer is not a site anyone visits, it is bytes the editor
writes into a Workspace, and it reaches a reader from *their* host (ADR-0006). It ships here as cargo.

`actions/configure-pages` is required rather than optional. It fails **by name** when the repository's
Pages source is still a branch — the setting a fork does not inherit, and the only thing a forker must
click. Without it the run goes green and the upload goes into a void, which is the worst version of
this failure: a successful workflow and a site serving raw source.

Before uploading, against the artifact itself: the ADR-0006 absolute-path scan, because a fork is
deployed at `user.github.io/<repo>/` and so the subpath case is not a hypothetical there but the only
case; and ticket 01's `check-nojekyll.mjs`.

**`pnpm check:deployment` runs and reports; it does not gate.** Decided 2026-08-11 and recorded in the
workflow itself. It fails today by design — the Base Map reads an archive this deployment does not
control, an explicit human decision of 2026-08-07 for want of a hosting budget (ADR-0025) — so gating
would mean the workflow written to unblock forking can deploy nothing until that budget exists.
Instead a `::warning::` naming the borrowed archive lands in every deploy's summary, which is the same
discipline `check-deployment-runs.test.mjs` applies inside `pnpm test`: state the risk where somebody
is already looking. **The step must not be deleted once an archive is provisioned** — the check will
pass on its own, and the step then asserts that it still does.

It does not re-run the suite. `ci.yml` runs on the same push; duplicating the browser tests would mean
either waiting on them twice or two sources of truth. A push that fails CI and deploys anyway is the
accepted trade for a static site with no data and no migration.

### The documentation

`docs/hosting.md`, opening on the distinction the whole subject turns on: **two jobs, two people, two
sites, two repositories.** Hosting the tool is a fork built by CI; publishing your work is a folder
pushed as-is. Conflating them is what makes the workflow sound circular.

Part 1, for a forker: fork, set the Pages source to GitHub Actions, push. Then the Base Map — read
before telling anyone the instance is ready — naming the borrowed archive, the one line to change,
and `pnpm check:deployment` as the way to know. Then keeping up with upstream, including that
`formatVersion` makes a stale instance refuse newer Projects loudly (ADR-0010), which is the reason to
stay current rather than a bug.

Part 2, for an author: publish, `git init` the Workspace, push it, set Pages to a branch deploy — here
the branch deploy is what you want, because the folder *is* the site — and the `?p=` address of a
single Project. Then what `.nojekyll` is and why it must stay, because an empty file with a strange
name gets tidied away. Then size: the ~1 GB shared cliff (ADR-0008), the 100 MB git limit and the
honest note that nothing the editor writes approaches it, and Git LFS, which Pages does not resolve and
which would serve every tile as a pointer file.

A "known gaps" section, so the borrowed archive, single-Project publishing, and pretty URLs are stated
rather than discovered.

`README.md` gets a Hosting section and the file in its layout table; `CONTRIBUTING.md` gets a Deploying
section and a note on the two checks that read built output and therefore cannot live in `pnpm lint`.

## Out of scope

- **Provisioning a Base Map archive.** A budget decision. Documented, warned about, not made.
- **In-app git** (ADR-0014). Prose is the deliverable.
- **Reviewing `ballastella-v1` tickets 16 and 17**, which this workflow runs through. Named in the
  epic tracker as outstanding.

## Acceptance criteria

- [x] `pages.yml` builds and deploys `apps/editor/build` on push to `main` and on manual dispatch
- [x] It uses `actions/configure-pages`, so a fork with the wrong Pages source fails by name
- [x] It runs the ADR-0006 absolute-path scan and `check-nojekyll.mjs` against the artifact
- [x] It runs `pnpm check:deployment`, annotates a warning when that fails, and deploys regardless
- [x] `permissions`, `environment`, and a non-cancelling `concurrency` group are set as Pages requires
- [x] `docs/hosting.md` covers both halves, keeps them visibly distinct, and states the known gaps
- [x] `README.md` and `CONTRIBUTING.md` point at it; the stale "core is still empty" status and the
      stale "demo bucket" sentence are corrected

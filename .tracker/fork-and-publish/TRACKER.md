# Tracker for fork-and-publish

## Purpose

SPEC stories 99–101 — fork the tool, host it on free static hosting, no secrets — were designed for
throughout `ballastella-v1` and then could not actually happen. This epic closes the distance between
"every constraint the fork workflow needs is satisfied" and "somebody can do it."

The workflow, end to end, is: an instructor forks the repository and deploys it as a GitHub Pages
site; a scholar or student uses that instance to make Projects in a folder they own; they commit that
folder to a repository of their own and deploy it; their work is public at a citable address.

## Current status

**Completed**, 2026-08-11. Two defects, one absence, and one piece of deployment hygiene — all in the
last mile.

Ticket 03 was not planned. It came out of reading what ticket 02's workflow would actually upload,
which is the sort of thing only writing the deploy step makes anyone ask.

## What was wrong, and what was already right

The design work was sound and is untouched by this epic. `paths.relative: true` is set in both apps
and CI greps the built output to keep it that way; one build is driven at a domain root *and* under a
subdirectory prefix across seventeen e2e specs; publishing is additive and copies no tile; the Base
Map catalog is a single editable module with a fence keeping every other module from naming an entry
or an archive; no API key or secret exists in either app, asserted. **Every hard constraint the fork
story rests on was met.** What was missing was the plumbing, and the plumbing was invisible because
none of it fails on this deployment.

### 1. Nothing deployed the app (ticket 02)

`.github/workflows/` held `ci.yml` and nothing else. A fork's Pages default is *Deploy from a branch*,
which serves the repository root — so the first experience of a tool built to be forked was a
directory listing of `README.md` and `package.json`.

### 2. No `.nojekyll`, and the bundle directory is `_app/` (ticket 01)

The one that would have been reported as "the tool is broken." GitHub Pages' branch deploy runs
Jekyll, Jekyll drops every path beginning with `_`, and both apps put their entire JavaScript payload
under `_app/`. Neither build carried the marker, `adapter-static` does not write one, and nothing in
the repository created one.

**It bites hardest where we would never have seen it.** A fork deployed through the new workflow
never meets Jekyll, so fixing only the editor would have looked like fixing the bug. The site that
needs the file is the *author's* — the Workspace they push to a repository of their own, by hand,
following the Publish dialog's own instruction — and that repository holds no workflow of ours. The
failure is a blank page on a scholar's domain with the reason only in a browser console.

### 3. The artifact would have shipped the developer harness (ticket 03)

988 kB of committed test fixtures and an unlinked `/image-pane` readout page, served publicly by every
fork. Not a security problem — public-domain map, no user data, and the fixtures were already fenced
out of the precache — but not part of the application either.

The interesting part is that it could not be fixed by deleting files from `build/`: the service
worker's precache manifest is written from the routes that exist, and `cache.addAll` rejects
atomically, so a pruned artifact would mean a PWA that silently never installs again.

### 4. Nothing told anyone any of this (ticket 02)

`docs/` held ADRs. The README had no hosting section. ADR-0014 put committing out of the app's scope
as "documented in prose" and the prose was never written. The Pages source setting a fork does not
inherit, which build to deploy, whether the Workspace goes in the same repository as the fork, what
the empty file with the strange name is for — all of it was tribal knowledge.

## Deliberate choices, so they are not re-litigated

**The Pages deploy reports on `check:deployment` rather than gating on it.** The check fails today by
design: the Base Map reads an archive this deployment does not control, an explicit human decision of
2026-08-07 taken for want of a hosting budget (ADR-0025). Gating would mean the workflow written to
unblock forking deploys nothing until that budget exists. So it runs and annotates every deploy with
a warning naming the borrowed archive — the same discipline `check-deployment-runs.test.mjs` applies
in `pnpm test`. Decided 2026-08-11.

**The deploy does not re-run the suite.** `ci.yml` runs on the same push. A push that fails CI and
deploys anyway is the accepted trade for a static site with no data and no migration.

**The two sites are separate repositories.** One instance serves any number of people; each person's
Workspace is theirs. Putting a Workspace inside the fork would need the workflow to know about it and
would tie a scholar's work to a tool upgrade.

## Still open, and not this epic's to close

- **The Base Map archive.** `pnpm check:deployment` fails until somebody provisions one. That is a
  budget decision, and the fork inherits the borrowed archive until it repoints the catalog. Recorded
  in ADR-0025, surfaced in the deploy log, and named under "known gaps" in `docs/hosting.md`.
- **Review debt.** `ballastella-v1` tickets 10, 11, 14, 15, 16, 17, and 18 are merged but not
  code-reviewed, and 16 (publish) and 17 (viewer) are the two this workflow runs through. Every
  reviewed ticket in that epic yielded substantive findings.
- **Verified against the real thing.** Everything here is asserted against a static server built to
  behave like GitHub Pages, and the Jekyll behaviour is reasoned from documented behaviour rather than
  observed. The first genuine deploy is still the first genuine deploy.

## Ledger

| Number | Filename | Status | Depends On |
| --- | --- | --- | --- |
| 01 | [01-jekyll-does-not-eat-the-viewer.md](./tickets/01-jekyll-does-not-eat-the-viewer.md) | Completed | — |
| 02 | [02-a-fork-deploys-itself-and-says-how.md](./tickets/02-a-fork-deploys-itself-and-says-how.md) | Completed | 01 |
| 03 | [03-a-public-instance-ships-only-the-app.md](./tickets/03-a-public-instance-ships-only-the-app.md) | Completed | 02 |

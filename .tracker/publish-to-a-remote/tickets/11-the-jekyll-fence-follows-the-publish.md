# The Jekyll fence follows the publish, and the hosting guide catches up

## What to build

Two pieces of last-mile hygiene, both of the kind that fails silently and on somebody else's machine.

**Extend the Jekyll fence to the tree a publish writes.** `scripts/check-nojekyll.mjs` follows the chain from
this repository's build to the site a user publishes. That chain used to end in a repository we never see —
the author's, pushed by hand. It now ends in a repository *this code writes to*, so this is the last point at
which it can be checked at all.

**Rewrite `docs/hosting.md` Part 2.** Its second step is currently `git init`, `git remote add`, `git push`.
That step no longer exists. The document must describe what the tool now does, what the three states of a
Project are, and — plainly — that a Project not on the Front Page is still readable by anyone.

## Where to start

- `scripts/check-nojekyll.mjs` and `scripts/check-nojekyll.test.mjs`. Read the header. Then read
  `.tracker/fork-and-publish/tickets/01-jekyll-does-not-eat-the-viewer.md` and the tracker's section 2 — the
  failure is *"a blank page on a scholar's domain with the reason only in a browser console"*, and it bites
  hardest where we would never see it.
- `packages/core/src/transfer/viewer-files.ts` — `VIEWER_FILE_PATHS` and `isViewerFile`, the recorded,
  enumerable set. ADR-0006 requires it be exactly that.
- Ticket 02's publish engine, which writes `.nojekyll` into every commit unconditionally. This ticket asserts
  that property from the outside rather than trusting it.
- `docs/hosting.md` — read the whole thing. Part 1 (fork the tool) is untouched except by ticket 10. Part 2
  (publish your Workspace), "What `.nojekyll` is, and why it must stay", "Size, and the cliff at the end of
  it", and "Known gaps" all need revision.
- `CONTEXT.md`'s new entries — **Publish**, **Front Page**, **Remote**, **Project Bundle** — are the
  vocabulary the document must use. It currently uses none of them.
- `.github/workflows/pages.yml` runs `check-nojekyll.mjs` on every deploy with the comment *"Jekyll is off,
  here and in every site this build publishes"*. That claim must stay true.

## Contract

**The fence must cover the synced tree.** Its existing job is the built output; its new job is the property
that every commit a publish writes contains `.nojekyll` at the root. Assert it where it can actually be
observed — against ticket 01's fake, as a test of the engine's output — and keep the script's own scope to
what a script can see. Do not make the script reach the network.

**Do not weaken what the fence already checks.** It currently fails on a real, shipped defect class. If
extending it means restructuring, keep the existing assertions passing and keep the positive control: a regex
fence that matches nothing and a tree with nothing to match print the same success line.

**`docs/hosting.md` Part 2 becomes:**

1. Create an empty repository on GitHub (the tool links you to it with the name filled in).
2. Bind your Workspace to it, from the Workspace menu.
3. Press Publish.
4. Pages is turned on for you where possible; here is what to click if it is not.
5. Re-publish whenever you like.

**Three things the document must say plainly**, because nowhere else reaches the person who needs them:

- **A Project not on the Front Page is still readable by anyone with the link.** The repository is public.
  Do not put embargoed material there.
- **A first publish of a freshly tiled Map Image is slow and may span more than an hour**, because
  GitHub allows 5 000 requests an hour and a large scan is thousands of tiles. Later publishes take seconds.
- **The three limits, and which content drives which**: ~1 GB of bytes (driven by offline Base Map tiles),
  ~40 000 files (driven by pyramids), 5 000 requests an hour (driven by a first publish).

**The `.nojekyll` section stays**, and gains the sentence that the tool now writes it — but the explanation
of *why* must not be deleted. A user who deletes the file needs to be able to find out what they broke.

**"Known gaps" is updated, not emptied.** The borrowed Base Map archive (ADR-0025) and the borrowed place
lookup (ADR-0029) are both still open and still surfaced in every deploy's log.

### User Stories

56, 61.

## Out of scope

- **Do not change `.github/workflows/pages.yml`'s advisory step.** `fork-and-publish` records the decision
  deliberately: the deployment check **reports** rather than gates, because gating would mean the workflow
  written to unblock forking deploys nothing until a hosting budget exists. Its comment says explicitly *"Do
  not 'fix' this by deleting the step once the archive is provisioned."*
- **No new CI job and no new workflow.**
- **Do not rewrite Part 1** beyond what ticket 10 adds.
- **Do not delete the `.nojekyll` explanation.**
- **No changes to `viewer-files.ts`'s recorded set.**
- **Do not document repository creation by the app.** It is deferred, not decided.

## Acceptance criteria

- [ ] Every commit a publish writes contains `.nojekyll` at the tree root, asserted against the fake,
      including when the local Workspace has no such file.
- [ ] `scripts/check-nojekyll.mjs`'s existing assertions still pass, and its positive control still fails on
      known-bad input.
- [ ] `pnpm test:scripts` passes.
- [ ] `docs/hosting.md` Part 2 contains no `git init`, `git remote add`, or `git push` instruction.
- [ ] Part 2 uses **Publish**, **Front Page**, and **Remote** as `CONTEXT.md` defines them.
- [ ] The document states that a Project not on the Front Page is readable by anyone with the link.
- [ ] The document states that a first publish may span more than an hour, and why.
- [ ] The document names all three limits and what drives each.
- [ ] The `.nojekyll` explanation survives.
- [ ] "Known gaps" still names the borrowed Base Map archive and the borrowed place lookup.
- [ ] `pages.yml` is unmodified.

```
pnpm test:scripts
node scripts/check-nojekyll.mjs
pnpm --filter @ballastella/core test
pnpm lint
git diff --stat .github/workflows/pages.yml   # must be empty
```

Success: all pass, and the workflow diff is empty.

## Blocked by

- Ticket 04

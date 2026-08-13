# Tracker for publish-to-a-remote

## Purpose

This document tracks the status of all tickets in the epic.

`docs/hosting.md` Part 2 step 2 asks a scholar to `git init`, `git remote add`, and `git push`. For the
audience this tool exists for, that step is not hard — it is impossible, and everything on either side of it
already works. This epic replaces that paragraph with a button.

**Publish** comes to mean *send the Workspace's files to its **Remote***; the **Front Page** is where a Reader
arrives, and each Project is either on it or not. A Remote is also a way in: from a Published Site a visitor
can clone the whole Workspace or review one Project, neither needing a GitHub account.

See [SPEC.md](./SPEC.md). The design is recorded in ADR-0031 (the broker exchanges a code, never data),
ADR-0032 (publish means the Remote, and the Front Page is where a Reader arrives), and ADR-0033 (a publish
mirrors an owned namespace and preserves the rest), with amendment banners on ADR-0008 and ADR-0014.

## Current Status

Overall status: `Completed`

Current ticket: — all eleven are complete

Last updated: 2026-08-13

## Open question for a human: stories 38 and 50 disagree about the hub

Raised after this epic closed, by `the-suite-runs-in-three-minutes` ticket 05, and recorded in full —
reproduction, run counts, and one refuted hypothesis — as **lead 8** in
[`workspace-and-layers`'s TRACKER](../workspace-and-layers/TRACKER.md#open-leads--unclosed-and-not-to-be-absorbed-into-the-flake-budget).

Story 38 says a scholar who never publishes is never shown a sign-in prompt. Story 50's *"Review a
Project from GitHub…"* button (`ProjectHub.svelte:484`) is on the hub of a Workspace that has never
published, and `e2e/editor-remote-binding.e2e.ts:344` — which reads 38 as *nothing about GitHub is on
any screen* — sees it there. Nothing is *requested* of GitHub on a first visit; the sibling test proves
that and passes. What is offered is the question.

**Not decided here, and not decided by ticket 05 either.** The choice is between narrowing story 38's
reading to a sign-in prompt specifically, or moving the review entry point behind the same gesture the
rest of the Remote is behind. It is an ADR-0031 / ADR-0032 question and wants a human.

## Open question for a human: a rate-limited publish cannot be resumed

Raised by ticket 02's review, and left open deliberately rather than decided in an implementation ticket.

SPEC says "Exhaustion mid-publish stops legibly, naming the reset time, and **the manifest makes the
resumption cheap**." The engine cannot do that, and no ticket in this epic makes it able to. Blobs
uploaded before the stop are loose objects in no tree, and the ref never moved, so the next plan — built
from the tree at the branch's head — cannot see them. `plan.files` is deterministic and sorted, so the
next attempt re-posts the same first N paths and stops in the same place. **A Workspace whose first
publish needs more than one hour's budget never converges.** The manifest does not help: it is local, and
it is written only after a *successful* publish.

Ticket 02 was remediated to stop *claiming* resumption in its two rate-limit messages, which is the
honest fix within its scope. The underlying capability is still absent. Three ways out, none chosen:

1. Accept it, and say so where a scholar meets it — a first publish above ~5 000 new files needs a
   Workspace small enough to fit one hour's budget.
2. Have a stopped publish return what it sent so a later attempt can skip it. This is a change to
   `RemotePublishRateLimitedError` and to what the manifest means, and it touches ticket 05.
3. Move the ref to a partial commit so the uploaded blobs are reachable — which contradicts story 16
   ("nothing on my published site changes until the upload has finished") and should probably be refused.

Nothing downstream is blocked on this: tickets 03–11 are unaffected either way.

## For a human: this deployment ships with no GitHub App

Ticket 10 landed with **placeholder** App values — `https://github-broker.example.org` (RFC 2606 reserved,
so it can never be registered by anyone) and a self-evidently fake client ID. There is no broker deployed and
no GitHub App registered; `/home/dflood/repos/infrastructure/github_broker` is an empty directory.

This is a specified, tested state, not a gap: story 56 wants a fork to work with no AWS account, and ticket
10's criterion 9 — asserted end to end — is that with the broker unreachable the pasted-token path still
binds and still publishes. Until the pair is replaced, the pasted personal access token is the whole of this
deployment's auth, which is what ADR-0031 intends.

**To turn the sign-in on:** register a GitHub App, deploy the broker from the sibling repository, and replace
the two values in the one configuration module (`packages/core/src/remote/github-app.ts`). Neither is a
secret. `docs/hosting.md` §6 has the instructions, and `scripts/check-github-broker.mjs` fails the lint if
either value is ever named anywhere else. Note that a GitHub App's callback URL is registered **per app**, so
a fork at a different address needs its own.

## Open question for a human: an interrupted Clone cannot be resumed from the app

Raised by ticket 07's review. The engine resumes correctly and is tested doing so; the **application** cannot
reach that capability, because `cloneFrom` always calls `createOpfsWorkspace`. Retrying an interrupted Clone
therefore produces `atlas (2)` and downloads everything again, while `atlas` sits abandoned holding whatever
it had fetched. Repeated interruptions accumulate orphan Workspaces, and each retry's quota check is made
against a quota the previous partials are already consuming.

Ticket 07's criterion 6 is satisfied as written — it asks that a resumed Clone skip files already present and
asserts the fake's request counter, which the engine does at seam 1 with a hand-built destination. Building a
resume flow in the interface is new scope, so it was not done.

**The destructive half of this is closed**, and deliberately: a Clone writes `remote.json` last, so an
interrupted Clone leaves the Workspace *unbound* and Publish has no target. Ticket 07's remediation turned
that accident into a tested invariant. Ticket 05's bind-time subset refusal (story 23) closes the remaining
manual route, where a scholar binds a partial Workspace by hand. What is left after both is untidiness and
wasted quota, not data loss.

Two ways out, neither chosen: offer to continue into the existing partial Workspace when one exists for that
Remote (which needs a way to mark a Workspace incomplete), or discard a partial Workspace on failure and give
up resume entirely, which contradicts story 46.

## Known limitation: the bind-time subset refusal has no override

Raised by ticket 05's review and left as it stands, deliberately. Binding is refused when the Remote's
`ballastella-site.json` lists a Project this Workspace has not got, and there is no way past it — the only
remedy offered is Clone.

That is right for the case it exists for and wrong for one legitimate case: a scholar who deletes a Project
locally, unbinds, and re-binds the same repository is refused, and the refusal names the Project they
deliberately deleted. Clone does not help them; it makes a second Workspace holding the very Project they
meant to be rid of. The way through today is to publish *before* unbinding, so the Remote's record no longer
lists it.

Not fixed because an override is a switch that turns the guard off, and the guard's whole subject is a
scholar who does not yet know what is on the Remote — a second machine and a partly-cloned Workspace both
arrive at the refusal believing the deletion is deliberate. Trading a rare annoyance for the loss this epic
exists to prevent is the wrong way round. If it is revisited, the shape to look at is a remedy that
*publishes the deletion* rather than one that waives the check.

## Deferred out of ticket 05: a Clone still writes no publish manifest

SPEC says the manifest records the Remote *"as of the last successful Publish **or Clone**"*, and the Clone
half is unimplemented — `cloneFromRemote` writes none. Held back from ticket 05 deliberately: it needs
`WorkspaceClone`'s shape and `cloneFromRemote`'s loop, which ticket 08 is working in, and a Clone reads a
*tree* at a branch and so never learns a commit SHA for `PublishManifest.commit`. The intended shape is that
the Clone learn its commit from `GET /git/ref/heads/{branch}` — one extra request, which the publish engine
already makes — rather than the field being made optional; and that the record be built from the paths the
Clone **wrote**, never from the ones the tree listed, because a partial download recording the whole listing
would make ticket 05's check bless the deletion of every un-fetched path.

Until it lands, the first publish from a cloned Workspace meets ticket 05's no-manifest refusal. That is
safe and is the specified fallback: it says plainly that it cannot tell, says that a just-cloned Workspace
is the ordinary case for it, and offers "publish anyway".

## Sequencing, and why it is risk-ordered

The order below is not dependency order alone. **Everything is buildable and testable against a pasted
personal access token before any infrastructure exists**, because `api.github.com` answers
`access-control-allow-origin: *` — the browser talks to GitHub's data plane directly, and the broker is only
needed for the code-for-token exchange (ADR-0031). So the parts that can be *subtly wrong* come first:
ticket 01's shared fake and its blob SHAs, ticket 02's incremental upload and owned-namespace rules, and
ticket 05's conflict refusal. The GitHub App and the broker come last, when they add a front door to a
working feature rather than a prerequisite for one.

Ticket 01 is a prefactor and delivers no user-facing behaviour. It exists so the ten tickets after it assert
against one shared fake rather than ten private ones — the `e2e/support/iiif-hosts.ts` lesson applied before
the fact rather than after.

## This epic spans two repositories

The broker's SAM template, IAM, and deployment live in `/home/dflood/repos/infrastructure/github_broker` and
are tracked there. **No SAM template, AWS configuration, IAM policy, or broker deploy workflow belongs in this
repository** — ticket 10 carries the contract, the configuration module, the lint fence, the callback, and the
docs, and nothing else.

## Ledger

| Number | Filename | Status | Depends On |
| --- | --- | --- | --- |
| 01 | [01-a-fake-github-and-blob-shas-that-agree-with-git.md](./tickets/01-a-fake-github-and-blob-shas-that-agree-with-git.md) | Completed | — |
| 02 | [02-a-workspace-becomes-a-commit.md](./tickets/02-a-workspace-becomes-a-commit.md) | Completed | 01 |
| 03 | [03-a-workspace-is-bound-to-a-remote.md](./tickets/03-a-workspace-is-bound-to-a-remote.md) | Completed | 02 |
| 04 | [04-publish-from-the-navigation-bar.md](./tickets/04-publish-from-the-navigation-bar.md) | Completed | 03 |
| 05 | [05-a-publish-refuses-to-overwrite-another-machine.md](./tickets/05-a-publish-refuses-to-overwrite-another-machine.md) | Completed | 04 |
| 06 | [06-a-project-chooses-whether-it-is-on-the-front-page.md](./tickets/06-a-project-chooses-whether-it-is-on-the-front-page.md) | Completed | 02 |
| 07 | [07-clone-a-workspace-from-a-remote.md](./tickets/07-clone-a-workspace-from-a-remote.md) | Completed | 03 |
| 08 | [08-review-a-project-from-a-remote.md](./tickets/08-review-a-project-from-a-remote.md) | Completed | 07 |
| 09 | [09-the-front-page-leads-back-to-the-editor.md](./tickets/09-the-front-page-leads-back-to-the-editor.md) | Completed | 06, 08 |
| 10 | [10-a-github-app-and-the-broker.md](./tickets/10-a-github-app-and-the-broker.md) | Completed | 03 |
| 11 | [11-the-jekyll-fence-follows-the-publish.md](./tickets/11-the-jekyll-fence-follows-the-publish.md) | Completed | 04 |

Tickets 06, 07, and 10 are independent of one another once 03 lands, and 06 needs only 02 — three parallel
branches after the engine and the binding are in.

## Story coverage

Every one of SPEC's 63 user stories is claimed by a ticket:

| Ticket | Stories |
| --- | --- |
| 01 | — (prefactor) |
| 02 | 9–12, 15–19, 61–63 |
| 03 | 4–8, 30, 31, 34–42 |
| 04 | 1–3, 9–14, 59–62 |
| 05 | 20–24 |
| 06 | 25–29, 52–54 |
| 07 | 43–48 |
| 08 | 39, 40, 50 |
| 09 | 49–51, 55 |
| 10 | 32, 33, 56–58, 63 |
| 11 | 56, 61 |

Stories 9–12 and 61–62 appear twice deliberately: the engine computes and refuses (02), the interface shows
and announces (04). Stories 39–40 likewise: the refusals are written in 03 and asserted again at the route
that creates the Workspace they protect against (08).

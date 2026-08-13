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

Overall status: `In Progress`

Current ticket: 03 and 06, in parallel

Last updated: 2026-08-12

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
| 03 | [03-a-workspace-is-bound-to-a-remote.md](./tickets/03-a-workspace-is-bound-to-a-remote.md) | Not Started | 02 |
| 04 | [04-publish-from-the-navigation-bar.md](./tickets/04-publish-from-the-navigation-bar.md) | Not Started | 03 |
| 05 | [05-a-publish-refuses-to-overwrite-another-machine.md](./tickets/05-a-publish-refuses-to-overwrite-another-machine.md) | Not Started | 04 |
| 06 | [06-a-project-chooses-whether-it-is-on-the-front-page.md](./tickets/06-a-project-chooses-whether-it-is-on-the-front-page.md) | Not Started | 02 |
| 07 | [07-clone-a-workspace-from-a-remote.md](./tickets/07-clone-a-workspace-from-a-remote.md) | Not Started | 03 |
| 08 | [08-review-a-project-from-a-remote.md](./tickets/08-review-a-project-from-a-remote.md) | Not Started | 07 |
| 09 | [09-the-front-page-leads-back-to-the-editor.md](./tickets/09-the-front-page-leads-back-to-the-editor.md) | Not Started | 06, 08 |
| 10 | [10-a-github-app-and-the-broker.md](./tickets/10-a-github-app-and-the-broker.md) | Not Started | 03 |
| 11 | [11-the-jekyll-fence-follows-the-publish.md](./tickets/11-the-jekyll-fence-follows-the-publish.md) | Not Started | 04 |

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

# The Front Page leads back to the editor

## What to build

The loop closes. A Published Site records which instance of the editor published it, and its Front Page
carries a link back: **"Open this Workspace in Ballastella"**, which lands in that instance offering to Clone
the Remote. A Project's page carries **"Review this Project in Ballastella"**, which lands offering to open a
Review Workspace.

A Reader who was given nothing but a URL can take the work onto their own machine, with no account, no file,
and nothing typed.

## Where to start

- `packages/core/src/publish/publish.ts` — `PublishedSite` is where the instance address is recorded, beside
  `viewerVersion` and `publishedAt`. `parsePublishedSite` is the tolerant reader; a record without the field
  must simply show no link.
- `apps/viewer/src/routes/+page.svelte` — the Front Page around line 891 and the Project screen around line
  967. Line 912 already carries an outbound link to the GitHub README, which is the pattern and the place.
- `apps/editor/.deploy/routes/+page.svelte` and `apps/editor/src/routes/+page.svelte` — read the comment on
  `pageTitle` explaining that **SvelteKit throws on `url.searchParams` while prerendering**, and that the
  `session === null` guard is load-bearing rather than defensive. The new parameters are read under the same
  guard.
- `apps/editor/src/lib/editor-session.svelte.ts`'s `stampCanonicalUrl` — prior art for "the editor writes an
  address into the published data at publish time."
- Tickets 07 and 08's Clone and Review entry points, which this ticket routes into.
- `e2e/support/published-site.ts` and `e2e/viewer-reader.e2e.ts` — the Reader half is asserted here, at a
  domain root **and** a subdirectory.

## Contract

**The editor stamps its own address at publish time.** It knows `location.origin` plus its base path;
nothing is configured and nothing is asked. The record therefore says which instance made the site, which is
useful provenance independent of the link.

**Two URLs, landing on the editor's single route:**

```
{instance}/?clone=owner/repo
{instance}/?review=owner/repo&p=<project-directory>
```

**They offer, they do not act.** Landing on either shows what would happen and waits for a press. A URL that
silently creates a Workspace and switches to it is a link anyone can send that rearranges a stranger's
editor. Neither parameter may do anything before a user confirms.

**Read them under the existing prerender guard.** `url.searchParams` throws during prerender, and this route
is prerendered. Read them where `?p=` is already read, inside the `session !== null` guard, and strip them
from the URL once handled so a reload does not re-offer.

**They compose with `?p=`, and `?p=` wins for display.** The single route is already both the hub and a
Project screen. A URL carrying both should not fight itself; decide and state which the user sees first.

**The links degrade to nothing.** A record with no instance address shows no link — not a broken one, not a
guess at the canonical deployment. An older viewer bundle meeting a newer record ignores the field.

**Cross-origin, and that is expected.** Under ADR-0032's topology the Published Site and the editor instance
are different origins. Use a plain link. No `postMessage`, no embedded iframe, no attempt to hand state
across.

### User Stories

49, 50 (its Reader half), 51, 55.

## Out of scope

- **No auto-clone, no auto-review.** Confirmation is mandatory.
- **No credential handling on these links.** Both operations are unauthenticated by design.
- **No new viewer dependency.** `scripts/check-viewer-deps.mjs` fences the viewer against `terra-draw` and
  the tiler and runs in `pnpm lint`; a link needs neither.
- **No editing affordance in the viewer.** The link leaves for the editor. The Front Page stays read-only.
  SPEC story 53.
- **No deep-linking into an alignment, a Layer, or a Control Point.**
- **Do not change `?p=`'s meaning or addressing.** ADR-0008 chose it for reasons that still hold.
- **No `postMessage` bridge or shared storage between the two origins.**

## Acceptance criteria

- [ ] A publish records the instance address in the published-site record.
- [ ] The Front Page shows "Open this Workspace in Ballastella" pointing at that instance with
      `?clone=owner/repo`.
- [ ] A Project's page shows "Review this Project in Ballastella" with `?review=owner/repo&p=<dir>`.
- [ ] Both links work with the site served at a domain root **and** under a subdirectory prefix.
- [ ] Landing on `?clone=…` offers a Clone and does nothing until confirmed; confirming performs ticket 07's
      Clone.
- [ ] Landing on `?review=…&p=…` offers a Review and does nothing until confirmed; confirming performs ticket
      08's Review.
- [ ] The parameter is stripped after handling, and a reload does not re-offer.
- [ ] A published-site record with no instance address renders no link and no error.
- [ ] `pnpm -r build` still prerenders both apps — no route reads `searchParams` outside the guard.
- [ ] The links read well at a 375 px viewport.

```
pnpm -r build
pnpm test:e2e viewer-reader
pnpm test:e2e editor-clone-remote
pnpm test:e2e editor-review-remote
pnpm check
pnpm lint
```

A build failure of `500 /` means a `searchParams` read escaped the guard. Success: the build is clean and all
three specs pass.

## Blocked by

- Ticket 06
- Ticket 08

# A GitHub App and the broker

## What to build

The nicer front door. Instead of pasting a token, a scholar presses a button, authorises on GitHub's own
screen, chooses which repositories the app may touch, and comes back signed in.

This needs one server-side thing and one only: `github.com/login/oauth/access_token` sends no CORS headers,
so a browser cannot exchange an authorisation code for a token itself. The **broker** does that and nothing
else. It never sees a byte of repository data — every other request in this epic goes from the browser to
`api.github.com` directly, which answers `access-control-allow-origin: *`.

The broker's code and deployment live in `/home/dflood/repos/infrastructure/github_broker`. **This ticket
adds none of it to this repository.** What lands here is the second implementation behind ticket 03's
credential interface, one deployment-configuration module, a lint fence, the contract document, and the
docs.

## Where to start

- `docs/adr/0031-the-broker-exchanges-a-code-never-data.md` — this ticket's specification, including the
  measured CORS facts and why `isomorphic-git` through the broker is impossible.
- `packages/core/src/places/service.ts` — read the boxed header in full. This is the deployment-configuration
  pattern, twice used: one module owns the address, a boxed comment says "change this file and nothing else",
  and `scripts/check-place-service.mjs` fails `pnpm lint` on any other module naming it. Note the subtlety
  its header records: the fence scans for **the address**, not the service's name, because a fence that
  failed on documentation would offer "delete the paragraph" as its remedy.
- `scripts/check-place-service.mjs` and `scripts/check-place-service.test.mjs` — including the
  `KNOWN_BAD` / `KNOWN_GOOD` positive control. A regex fence's way of dying is silent: a pattern that
  matches nothing and a tree with nothing to match print the same success line.
- `packages/core/src/base-map/deployment-assets.ts` and `scripts/check-base-map-catalog.mjs` — the second
  instance of the same pattern.
- Ticket 03's credential interface. This is a second implementation behind it, not a change to it.
- `apps/editor/src/routes/+page.svelte` and `apps/editor/.deploy/routes/+page.svelte` — the prerender guard
  comment on `pageTitle`. The callback's parameters are read under the same guard, as ticket 09's are.
- `docs/hosting.md` Part 1 — where a forker is told what to configure.

## Contract

**The broker's two endpoints.** This repository holds the contract so the two repositories cannot drift:

```
POST {broker}/github/token    { client_id, code, redirect_uri }  → GitHub's token JSON verbatim,
                                                                   or { error, error_description }
POST {broker}/github/refresh  { client_id, refresh_token }       → the same shape
```

The secret is looked up **by `client_id`**, and the request's `Origin` is validated against an allowlist
stored beside that secret — which is what makes one deployment serve several unrelated projects without any
of them minting tokens against another's app. It logs no code, no token, and no secret.

**One deployment-configuration module** holds the broker URL and the GitHub App's `client_id`, with a boxed
header in the house style and `scripts/check-github-broker.mjs` wired into `pnpm lint` failing on any other
module naming either. Neither value is a secret; a client ID is public by design. Include the positive
control.

The header must state the thing a forker most needs to know: **a GitHub App's callback URL is registered per
app, so a fork at a different address needs its own app and its own client ID — and until it has one, the
pasted token is the whole of that fork's auth.**

**The callback lands on the editor's single route** with `?code=` and `?state=`. `state` is generated before
the redirect, stored in session storage, and verified on return; a mismatch or absence is a refusal, not a
retry. The parameters are stripped without disturbing the open Workspace. Read them under the existing
prerender guard.

GitHub OAuth apps do not support PKCE, so `state` plus the redirect-URI allowlist plus the broker's origin
allowlist are the whole of the protection. Do not add a PKCE challenge that GitHub will ignore.

**Token expiry is handled, not avoided.** A GitHub App's user token expires after eight hours and refresh
needs the secret, hence the second endpoint. An expired token surfaces as "sign in again", never as a
publish that fails partway through — check before starting, not during.

**Both acquisition paths stay indistinguishable below the interface.** The engine still receives an opaque
bearer token. No `if (authMethod === …)` below the UI layer. If the broker is unreachable, the pasted-token
path must still work — a fork with no infrastructure is fully functional, not degraded.

**The e2e fake grows.** Ticket 04's support module gains the authorize redirect and the broker response,
because `scripts/check-e2e-network-fence.mjs` forbids reaching either. No test may talk to GitHub or to a
real broker.

**`docs/hosting.md` Part 1 gains a section** on registering an app, pointing the module at it, and what to do
instead if you would rather not.

### User Stories

32, 33, 56, 57, 58, 63.

## Out of scope

- **No SAM template, AWS configuration, IAM policy, or broker deploy workflow in this repository.** SPEC
  "Out of scope" item 11. A helpful implementer will offer to add `template.yaml` "since we're here". It
  belongs in `infrastructure/github_broker` and is tracked there.
- **No repository data through the broker, ever.** ADR-0031 is named for this.
- **No removal or deprecation of the pasted-token path.** It is what keeps a fork whole.
- **No `localStorage` or IndexedDB.** SPEC "Out of scope" item 9.
- **No changes to the credential interface's shape** beyond adding an implementation. If the interface needs
  changing, that is a signal ticket 03 got it wrong — say so rather than widening it here.
- **No `Administration: write` and no repository creation.** SPEC "Out of scope" item 5.
- **No PKCE.**
- **No device flow** as a third path.

## Acceptance criteria

- [ ] The deployment-configuration module holds the broker URL and client ID, and nothing else in the tree
      names either — enforced by the new fence in `pnpm lint`.
- [ ] The fence has a positive control: known-bad and known-good samples checked before the scan, and its own
      `node --test` file.
- [ ] The authorisation flow completes against the faked authorize redirect and faked broker: pressing sign
      in, returning, and arriving signed in with the identity shown.
- [ ] A `state` mismatch is refused, and no token is stored.
- [ ] A missing `state` is refused.
- [ ] The callback's parameters are stripped, and the open Workspace is unchanged across the redirect.
- [ ] An expired token surfaces as "sign in again" **before** a publish starts, not during one.
- [ ] A refresh is attempted through the broker's refresh endpoint and its failure surfaces as sign-in.
- [ ] With the broker unreachable, the pasted-token path still binds and still publishes.
- [ ] No test reaches `github.com`, `api.github.com`, or a real broker — `pnpm lint`'s network fence check
      passes and the suite runs offline.
- [ ] `pnpm -r build` still prerenders both apps.
- [ ] `docs/hosting.md` Part 1 tells a forker how to register an app, where to point the module, and what
      happens if they do not.

```
pnpm lint
pnpm test:scripts
pnpm -r build
pnpm test:e2e editor-github-signin
pnpm test:e2e editor-publish
pnpm check
```

Success: the fence passes and fails correctly on its known-bad sample; the sign-in spec passes offline.

## Blocked by

- Ticket 03

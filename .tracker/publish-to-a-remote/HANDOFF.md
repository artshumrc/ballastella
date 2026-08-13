# What is left for a human, and in what order

The epic is complete and merged. **Nothing below is required to use it.** This is the list of things
only you can decide or do, ordered so that the cheapest and most valuable come first.

## 0. What works today, with no action from you

A scholar can bind a Workspace to a GitHub repository, paste a fine-grained personal access token,
press **Publish**, and have their work on the web. Clone and Review both work and need no credential
at all. `docs/hosting.md` Part 2 no longer asks anyone to run `git`.

The only thing missing is the **Sign in with GitHub** button, which is a convenience over the token
paste, not a capability. See §3.

## 1. Two decisions, no code required

Both are recorded in full in [TRACKER.md](./TRACKER.md); this is the short form.

### 1a. A publish that needs more than one hour's requests never finishes

GitHub allows 5 000 requests an hour. A publish needing more **stops**, and because nothing resumes,
the next attempt re-uploads the same files and stops in the same place. One Historical Map at the
largest size the editor accepts is roughly 11 000 tiles, and that does not divide — so **a Workspace
holding one may not be publishable to GitHub at all.**

`docs/hosting.md` now says this plainly, so doing nothing is a defensible choice. The alternatives are
in TRACKER.md under *"a rate-limited publish cannot be resumed"*. If you want one built, say which.

### 1b. An interrupted Clone cannot be resumed from the interface

The engine resumes and is tested doing so; the app always creates a new Workspace, so a retry
re-downloads everything and the half-finished one sits there consuming quota. **No data can be lost**
— an interrupted Clone is left unbound, which is a tested invariant, and ticket 05's bind-time refusal
closes the manual route. This is untidiness, not risk.

## 2. Optional code work, ready to pick up

**A Clone writes no publish manifest.** SPEC says the manifest records the Remote "as of the last
successful Publish **or Clone**"; the Clone half was deferred out of ticket 05 because it needed a file
ticket 08 was editing. The consequence is small: the first publish from a cloned Workspace meets the
"we cannot tell" refusal and the scholar presses *Publish anyway*. The intended shape is recorded in
TRACKER.md. It is now unblocked — ask and I will do it.

## 3. Turning on *Sign in with GitHub*

**This is the only item with real work in it, and the work is not where you might expect.**

> **The handler is written; the packaging is not.** `/home/dflood/repos/infrastructure/github_broker/`
> now holds `index.mjs`, `index.test.mjs` (17 tests, `node --test`, no dependencies) and a `README.md`
> recording the contract. What is missing is `template.yaml` and a deploy — see step 2.

Do these in order; each is independently verifiable.

### Step 1 — Register the GitHub App

On your account or organisation. `docs/hosting.md` §6 *"Turning it on for your fork"* has the details.
The two that bite:

- **The callback URL must be spelled the way people actually reach the editor.** The editor sends the
  address the browser is at, so if they arrive at `…/editor/index.html`, a callback registered as
  `…/editor/` is refused with `redirect_uri_mismatch`. (This was a real bug caught in review.)
- Permissions: **Contents: Read and write** and **Pages: Read and write**; enable user-to-server
  tokens with expiry.

Keep the **client ID** (public) and the **client secret** (never leaves the broker).

### Step 2 — Package and deploy the broker

**The handler is done.** `infrastructure/github_broker/index.mjs` implements both endpoints, and
`index.test.mjs` pins them to the shapes `github-sign-in.ts` actually parses — including the three
properties that are easy to get wrong and impossible to notice: a refusal comes back in the body with
a 200, GitHub's answer is passed through unchanged, and the CORS preflight is answered (without it,
`fetch` rejects and the editor reports the broker as unreachable rather than as refusing).

What is left is packaging: a `template.yaml` with one function and two routes, `sam build`,
`sam deploy`, and `GITHUB_BROKER_APPS` set to the JSON in that README. Nothing in the handler needs to
change to deploy it.

For reference, the two endpoints it serves — no repository data passes through either:

```
POST {broker}/github/token    { client_id, code, redirect_uri }  → GitHub's token JSON verbatim,
                                                                   or { error, error_description }
POST {broker}/github/refresh  { client_id, refresh_token }       → the same shape
```

Requirements, from ADR-0031 and the ticket-10 contract:

- Look the secret up **by `client_id`**, and validate the request's `Origin` against an allowlist
  stored beside it. That is what lets one deployment serve several unrelated projects without any of
  them minting tokens against another's App.
- **Log no code, no token, and no secret.**
- It is stateless. It exists only because `github.com/login/oauth/access_token` sends no CORS headers;
  every other request goes from the browser straight to `api.github.com`.

**Build it with SAM**, as SPEC.md and TRACKER.md say — `template.yaml`, `sam build`, `sam deploy`.
The other services in `infrastructure/` are CDK; the broker is not, and does not need to be. It shares
nothing with them: no VPC, no database, no shared resource. It is one stateless function and an
endpoint, which is what SAM is for.

`infrastructure/emailer/` is still worth reading for the **shape** rather than the tooling — a Lambda
behind API Gateway that validates an inbound header before doing anything — but do not copy its CDK
layout.

Verify before going on: `POST {broker}/github/token` with a junk code should answer GitHub's error
JSON shape, and a request from a disallowed `Origin` should be refused.

### Step 3 — Point the editor at it

Edit **one file**, `packages/core/src/remote/github-app.ts`:

```ts
export const GITHUB_APP: GitHubApp = {
	brokerOrigin: 'https://broker.your-institution.edu',
	clientId: 'Iv1.your-real-client-id'
};
```

Neither value is a secret. Set **both, or neither** — `pnpm lint` refuses a half-configured pair, and
`scripts/check-github-broker.mjs` fails the lint if any other module names either value.

Then run `pnpm lint` (the fence should report the containment scan rather than
`NO GITHUB APP CONFIGURED`), `pnpm test:e2e editor-github-signin`, and try the button by hand.

### If you decide not to

Set both values to `''`. The button disappears entirely rather than sitting there leading nowhere, and
the pasted token becomes your fork's whole auth again. That is a supported, tested state — not a
degraded one.

## 4. Known limitation, recorded rather than fixed

The bind-time subset refusal has no override: delete a Project locally, unbind, then re-bind the same
repository, and the bind is refused naming the Project you deliberately deleted. The workaround is to
publish the deletion *before* unbinding. Full note in TRACKER.md.

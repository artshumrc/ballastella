# The broker exchanges a code, never data

Publishing a Workspace to GitHub needs one server-side thing and one only: the exchange of an OAuth
authorisation code for a token. Every other request — the tree listing, every blob, the commit, the
ref update, every byte of a Clone — goes from the browser to GitHub directly.

This is a measured property rather than a hope:

```
$ curl -D- -H 'Origin: https://example.github.io' https://api.github.com/rate_limit
HTTP/2 200
access-control-allow-origin: *
access-control-expose-headers: …, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, …

$ curl -D- -X POST -H 'Origin: https://example.github.io' https://github.com/login/oauth/access_token
HTTP/2 404
(no access-control headers at all)
```

`api.github.com` is `*` and **exposes the rate-limit headers**, which is what lets a progress line in
the browser say how much budget is left. `github.com/login/oauth/access_token` sends no CORS headers,
and that single asymmetry is the entire reason a server exists in this design.

So the broker is a stateless code-for-token exchange, deployed from
`infrastructure/github_broker`, and **it is not on any data path**. Two endpoints:

- `POST {broker}/github/token` — `{ client_id, code, redirect_uri }` → GitHub's token JSON verbatim,
  or `{ error, error_description }`.
- `POST {broker}/github/refresh` — `{ client_id, refresh_token }` → the same shape.

It looks the client secret up **by `client_id`** and validates the request's `Origin` against an
allowlist stored beside that secret, so one deployment serves several unrelated projects without any
of them being able to mint tokens against another's App. It logs no code, no token, and no secret.

## Why not a real `git push`

`isomorphic-git` in the browser is what a reader who knows git will assume, and it is closed off
twice over.

GitHub sends no CORS headers on its git transport endpoints, so a browser push needs a proxy —
`cors.isomorphic-git.org` exists for precisely this. And **Lambda's synchronous invocation payload
limit is 6 MB on the request**, through API Gateway and through a Function URL alike. Response
streaming raises response sizes; there is no request streaming. A single 15,000 × 12,000 scan is
about 3,700 tiles and 110 MB of packfile, so the proxy this design would need cannot be the thing
being provisioned. It would have to be a Cloudflare Worker or a container, and reuse across projects
would then mean routing every project's repository data through one function.

Blob-by-blob through the Git Data API is slower on the first Publish and needs its own ceiling
(see [ADR-0033](./0033-a-publish-mirrors-an-owned-namespace.md)), and it buys the property this
record is named for.

## Why the ceiling is the API's and not ours

`POST /git/blobs` is one request per file, because the tree API's inline `content` field is UTF-8 only
and tiles are JPEG. A user token gets 5,000 REST requests an hour, so a first Publish of one 48 MP map
is roughly 1,020 requests and a large one roughly 3,700 — front-loaded once per Historical Map, not
once per save, because subsequent Publishes touch only the documents that changed.

`GET /git/trees/{ref}?recursive=1` **truncates at 100,000 entries or a 7 MB response**, which for this
tree shape lands near 40,000 files, and it truncates *without erroring*. That is the shape of the
failure [ADR-0024](./0024-backup-and-handoff-are-different-artefacts.md) was written about — a
plausible-looking archive missing most of a pyramid — so the file-count ceiling is refused up front,
before a byte is uploaded, rather than discovered as a commit with most of the Workspace absent.

## Consequences

- **A fork with no infrastructure is fully functional, not degraded.** A pasted fine-grained personal
  access token skips the broker entirely, because the code exchange is the only thing the broker was
  for. The engine, its speed, and its data path are identical either way. This is what keeps
  `docs/hosting.md` Part 1 — "fork this repository" — a complete story rather than one that now ends
  at an AWS account.
- **The broker being down does not stop anyone publishing.** It stops the nicer front door.
- **The sync engine receives an opaque bearer token and must not import anything auth-flow-specific.**
  It is handed `{ token, repo: { owner, name }, branch }`. No `if (authMethod === …)` below the UI.
- **`codeload.github.com` is unusable from a browser**, and this is the trap worth naming: the
  tarball endpoint is the obvious way to Clone, and `restore-workspace-tar.ts` already exists to
  receive it. But `codeload` answers `access-control-allow-origin: https://render.githubusercontent.com`
  — a specific origin, not `*` — so the fetch fails only at runtime, in a browser, as a CORS error.
  Clone therefore reads the file list from one `git/trees?recursive=1` call and the bytes from
  `raw.githubusercontent.com`, which is `*`.
- **A GitHub App's callback URL is registered per App.** A fork at a different address needs its own
  App and its own client ID, and until it has one the token-paste path is the whole of its auth. The
  broker URL and client ID live in one deployment-configuration module with a `pnpm lint` fence, the
  same shape as the Base Map catalog (ADR-0020) and the place lookup (ADR-0029).
- **No SAM template, AWS configuration, IAM policy, or broker deploy workflow belongs in this
  repository.** The contract above is what the two repositories share, and it is here so they cannot
  drift silently.

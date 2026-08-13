# Publish to a Remote

## Problem Statement

A scholar can make a Workspace full of Projects and cannot get it onto the web.

`docs/hosting.md` Part 2 is the whole of the current answer, and its second step asks the user to
create a repository, `git init`, `git remote add`, and `git push`. For the audience this tool exists
for — a humanities student on a Chromebook, a scholar who has never opened a terminal — that step is
not hard, it is impossible. Everything on either side of it works: publishing writes a viewer into the
Workspace additively and copies no tile (ADR-0006), one build serves a domain root and a subdirectory
(ADR-0006), a Workspace is already a hub of Projects addressed by `?p=` (ADR-0008), and the Reader's
site is already read-only and responsive. The tool is one impossible step short of doing what it
promises.

Three consequences follow from that gap, and each is felt as a separate complaint:

- **"Publish" publishes nothing.** The button writes files into a folder. A scholar presses it,
  nothing is on the web, and the word has lied to them.
- **There is nowhere to keep work but this browser.** A Workspace lives in browser storage, which is
  one laptop and one profile. Moving to another machine means exporting a tar and carrying it. A
  scholar who wants their maps on their office machine and their laptop has no route that does not
  involve a USB stick.
- **A Project cannot be handed to somebody who does not already have it.** A colleague can be sent a
  Project Bundle by mail. A student who is given a URL and told "start from my example" has to be sent
  a file first.

## Solution

**Publish means the Remote.** A Workspace can be bound to one GitHub repository — its **Remote** — and
one button sends the Workspace's files there, where GitHub Pages serves them as the Published Site. The
navigation bar reads **"Saved locally"** beside a **Publish** button, so the two facts a scholar wants
are never conflated: their edit is safe on this machine the moment they make it, and it is on the web
when they say so.

**The Front Page is where a Reader arrives**, listing the Projects offered to them. Each Project is
either on the Front Page or not — a per-Project choice made on the Workspace hub. Not being on the
Front Page means *absent from that list* and nothing else: the repository is public, the files are
fetchable, and `?p=` opens the Project for anyone who knows the name.

**A Remote is also a way in.** From a Published Site's Front Page a visitor can open the whole
Workspace in the editor, which clones it into a new named Workspace bound to that Remote; from a
Project's page they can review that one Project, which opens a Review Workspace. Neither needs a GitHub
account, because reading a public repository needs no credential.

Authorisation lives entirely at the push. Anyone may use the editor; only someone holding a token with
push rights to a given repository can put a Workspace into it. The token is a fine-grained personal
access token pasted into the app, or one obtained through a GitHub App via a stateless code-for-token
broker — and the two are indistinguishable below the interface, because the browser talks to GitHub's
data plane directly in both cases (ADR-0031).

## User Stories

1. As a scholar, I want a Publish button in the navigation bar, so that getting my work onto the web is
   one press rather than a page of terminal instructions.
2. As a scholar, I want the bar to say "Saved locally" rather than "Saved", so that I can tell the
   difference between my edit being safe on this machine and my edit being on the web.
3. As a scholar, I want my work never to be sent anywhere unless I press the button, so that a tool
   which saves continuously does not publish continuously.
4. As a scholar, I want to bind my Workspace to a GitHub repository once, so that publishing afterwards
   never asks me where.
5. As a scholar, I want to be told at the moment I bind whether I can actually push to that repository,
   so that I do not learn I cannot after four thousand tiles have uploaded.
6. As a scholar, I want Pages turned on for me when the tool is permitted to, so that a repository full
   of correct files is not a site that serves nothing.
7. As a scholar, I want to be told exactly what to click on GitHub when the tool cannot turn Pages on
   itself, so that the instruction reaches me when I need it rather than in a document.
8. As a scholar, I want to create the repository on GitHub myself with a link that prefills its name,
   so that the one step the tool does not do is still a short one.
9. As a scholar, I want to see how many files and how many bytes publishing will send before it starts,
   so that I can decide whether to wait.
10. As a scholar, I want to be warned as my Workspace approaches the hosting size limit, so that I find
    out from the tool rather than from a failed push.
11. As a scholar, I want to be warned when publishing will need more requests than GitHub allows in an
    hour, so that a first publish spanning several hours is something I chose.
12. As a scholar, I want publishing to be refused legibly when my Workspace holds more files than the
    API can list, so that I am never given a site with most of a Historical Map silently missing.
13. As a scholar, I want per-file progress while publishing, so that a long upload is visibly working
    rather than apparently hung.
14. As a scholar, I want to know how much of GitHub's hourly budget is left as it runs, so that a stop
    partway through is explained.
15. As a scholar, I want a second publish to take seconds, so that fixing a typo in an Annotation does
    not re-upload a pyramid.
16. As a scholar, I want nothing on my published site to change until the upload has finished, so that
    an interrupted publish leaves the site as it was rather than half replaced.
17. As a scholar, I want my `README.md`, `LICENSE`, and `CNAME` left alone, so that publishing does not
    silently move my cited address back to a `github.io` URL.
18. As a scholar, I want a Project I deleted to disappear from my published site along with its tiles,
    so that bytes I believe I removed are not still counted against my hosting limit.
19. As a scholar, I want a Historical Map I deleted to have its pyramid removed from the Remote, so that
    the shared pool of maps is reclaimed there as it is here.
20. As a scholar, I want publishing refused when the Remote holds a change I have never seen, so that my
    other machine's work is not overwritten without a word.
21. As a scholar, I want that refusal to name the files, so that I can judge what is at stake rather than
    guess.
22. As a scholar, I want the refusal to offer me both cloning the Remote and replacing it, so that I am
    not stuck between an error and a force.
23. As a scholar, I want binding refused when the Remote already holds Projects I do not have, so that
    the first publish from a second machine cannot delete them.
24. As a scholar, I want to be told plainly when the tool cannot tell whether the Remote holds newer
    work, so that it refuses rather than guesses.
25. As a scholar, I want to choose whether each Project appears on my Front Page, so that a Workspace can
    hold work in progress alongside work I am showing.
26. As a scholar, I want the control for that to say "not on the front page" rather than "unpublished", so
    that I am not misled into thinking the files are private.
27. As a scholar, I want to be told in the same breath that a Project not on the Front Page is still
    readable by anyone with the link, so that I do not put embargoed material there.
28. As a scholar, I want Projects to be on the Front Page by default, so that publishing behaves the way
    it did before and nothing vanishes on upgrade.
29. As a scholar working in an older fork, I want a Project carrying a front-page choice I have never
    heard of to open normally and keep that choice, so that a colleague's setting is neither refused nor
    silently discarded.
30. As a scholar, I want to paste a personal access token, so that publishing works without any service
    beyond GitHub.
31. As a scholar, I want the token accepted and validated immediately, so that a mistyped paste is caught
    before I press Publish.
32. As a scholar, I want to sign in to GitHub through a normal authorisation screen, so that I do not have
    to visit a settings page and generate a token by hand.
33. As a scholar, I want to install the app on only the repositories I choose, so that publishing one map
    project does not grant write access to everything I own.
34. As a scholar, I want my credential forgotten when I close the tab, so that a shared or lab machine
    does not keep a push credential.
35. As a scholar, I want my credential to survive a page reload, so that a long publish is not lost to an
    accidental refresh.
36. As a scholar, I want to see which GitHub account I am signed in as and which Remote I am bound to, so
    that I know where the button will send my work.
37. As a scholar, I want a way to sign out, so that I can hand my machine to somebody.
38. As a scholar who never publishes, I want never to be shown a sign-in prompt, so that a local-first
    tool stays local-first.
39. As a teacher reviewing a student's Project, I want publishing and binding refused entirely, so that
    somebody else's work cannot be published to my address.
40. As a teacher reviewing a student's Project, I want no credential readable while that Review Workspace
    is open, so that opening a submission cannot reach my token.
41. As a scholar, I want a restored Backup to arrive unbound, so that recovering an old state does not
    hand me a Publish button aimed at my live site.
42. As a scholar, I want an opened Project Bundle to arrive unbound, so that a colleague's file cannot
    point at their repository from my machine.
43. As a scholar moving to a new machine, I want to clone my Workspace from its Remote, so that I can
    carry on without a USB stick.
44. As a scholar, I want a clone to arrive as a new named Workspace rather than merged into an existing
    one, so that nothing I have is overwritten.
45. As a scholar, I want a clone bound to the Remote it came from, so that publishing from the new machine
    needs no setup.
46. As a scholar, I want a clone to resume rather than restart when it is interrupted, so that a large
    Workspace is not an all-or-nothing download.
47. As a scholar, I want per-file progress while cloning, so that a long download is visibly working.
48. As a student with no GitHub account, I want to clone my instructor's Workspace, so that I can start
    from their example without being asked to sign up.
49. As a Reader, I want a link on the Front Page that opens the whole Workspace in the editor, so that I
    can take the work further on my own machine.
50. As a Reader, I want a link on a Project's page that opens just that Project for review, so that I can
    look at one piece of work without taking all of it.
51. As a Reader, I want that link to reach the instance that made the site, so that I am not asked which
    copy of the tool to use.
52. As a Reader, I want the Front Page to list only the Projects put on it, so that a Workspace can carry
    more than it shows.
53. As a Reader, I want the Front Page to stay clean and read-only with no editing controls, so that
    somebody else's scholarship is what I meet rather than a tool.
54. As a Reader on a phone, I want the Front Page and a Project to read well, so that a published site
    works where readers are.
55. As a scholar, I want my published site to record which instance published it, so that a site can say
    where it came from.
56. As an instructor forking the tool, I want publishing to work in my fork with no AWS account, so that
    hosting my own instance stays a fork and a settings toggle.
57. As an instructor forking the tool, I want the broker address and client identifier in one file, so
    that repointing them is one edit and no infrastructure knowledge.
58. As an instructor forking the tool, I want to be told that a GitHub App's callback is registered per
    app, so that I know why the token paste is my fork's whole auth until I register one.
59. As a screen-reader user, I want the publish state, its progress, and its outcome announced, so that a
    long operation is not silent.
60. As a keyboard user, I want focus never dropped to the document while publishing runs, so that a long
    operation does not cost me my place.
61. As a scholar, I want `.nojekyll` written for me, so that my site is not a blank page for a reason
    visible only in a browser console.
62. As a scholar with an Offline Copy or an offline Base Map, I want those tiles published too, so that my
    site works the way I set it up to.
63. As a maintainer, I want the browser never to send repository data through our own server, so that the
    broker stays small, cheap, and reusable across unrelated projects.

## Implementation Decisions

### Publish is the act; the Front Page is the Reader's entry

The user-facing verb **Publish** means *send the Workspace's files to its Remote*. The viewer bundle is
written into the Workspace as part of it whenever it is missing or stale — the staleness computation
already exists — so there is no separate "publish this Workspace as a website" action. The existing
publish dialog's two decisions survive and move into this flow: the Base Map display-assets choice, and
the canonical URL, which must still be settled **before** any upload begins for the reason its current
comment gives — a refused address after a site has been written makes "nothing has been changed" false.

No files are deleted for this. The viewer build, the viewer-file enumeration, the staleness computation,
the published-site record reader, and the Jekyll fence are all load-bearing for Publish. The local
static site stops being a product; its machinery stays.

### A Remote is bound to a Workspace, not a backing

`WorkspaceBacking` stays a two-member union and gains no third member. A Remote is orthogonal: a
Workspace in browser storage and a Workspace in a folder may each have one. A Review Workspace may never
have one, enforced as a refusal in the domain package with a test, not as an absent menu item.

The binding is a Workspace-root document, following the review mark's precedent, and holds the binding
only:

```jsonc
// remote.json
{ "formatVersion": 1, "owner": "…", "repository": "…", "branch": "main" }
```

It is *inside* the published tree deliberately — the binding never changes, so it causes no churn, and a
clone learns its own Remote for free. A restored Backup and an opened Project Bundle both drop it.

### The front-page choice, and no format-version bump

A boolean on the Project document, absent meaning **on the Front Page**. `CURRENT_FORMAT_VERSION` is
**not** bumped: ADR-0010 refuses a newer version outright, and this epic multiplies the version skew that
ADR names by making one repository readable by several instances at several versions. An older build
carries the field through its unknown-fields channel and writes it back untouched.

The published-site record gains the same fact per Project, and the viewer's Front Page filters on it.
The record's reader stays tolerant, so an older viewer bundle meeting the field lists everything rather
than nothing.

### The transport: blob, tree, commit, ref

The browser talks to GitHub's data plane directly. Per publish:

1. `GET /git/trees/{branch}?recursive=1` — the current tree with blob SHAs. **Refuse if truncated.**
2. For each file, compute its git blob SHA locally (`sha1("blob " + length + "\0" + bytes)`) and
   `POST /git/blobs` only what the Remote does not already have.
3. `POST /git/trees`, `POST /git/commits`, then `PATCH /git/refs/heads/{branch}`.

Nothing is visible until the ref moves. An empty repository has no ref and gets one created.

The engine receives `{ token, repo: { owner, name }, branch }` and a `fetch` shim, and **must not import
anything auth-flow-specific**. No provider abstraction: GitHub only.

### The owned namespace

Inside it the Remote becomes exactly the Workspace — additions, updates, deletions. Outside it nothing
is touched.

```
ballastella-site.json
index.html
.nojekyll
remote.json
_app/**
images/**
alignments/**
base-map/**
<dir>/**     for any top-level <dir> where the Remote has <dir>/project.json
```

The last rule is why a deleted Project's tiles are reclaimed and a `CNAME` survives. See ADR-0033.

### The publish manifest

Path → blob SHA as of the last successful Publish or Clone, kept **local only**, keyed by Workspace and
backing as the write-ahead journal is. Two purposes: skip unchanged blobs, and detect a foreign write.

At every publish, for each path in the owned namespace, if the Remote's blob SHA is neither ours nor what
the manifest last saw, refuse and name the files. With no manifest, fall back to the bind-time check and
say plainly that we cannot tell.

### Three budgets, warned separately

The Workspace-size computation already returns bytes *and* files. Publishing warns on three axes because
the two kinds of content load them oppositely (ADR-0033):

| Axis | Ceiling | Driven by |
| --- | --- | --- |
| Bytes | `STATIC_HOSTING_LIMIT_BYTES` | offline Base Map tiles, ~152 kB each |
| Files | ~40,000, tree truncation | Historical Map pyramids |
| Requests | 5,000/hour | new blobs on a first publish |

The rate-limit headers are exposed to the browser, so the remaining budget is read rather than inferred.
Exhaustion mid-publish stops legibly, naming the reset time, and the manifest makes the resumption cheap.

### Credentials

Behind an interface, outside the store, never reachable through it. `sessionStorage` is the first
implementation, not the contract. Two acquisition paths below one interface:

- A pasted fine-grained token, validated on entry.
- A GitHub App user-to-server token, obtained by redirect and exchanged through the broker.

Rights are checked when a Remote is bound. Pages enablement is attempted with `Pages: write`; failing
that, the instruction is shown.

### The broker contract, and the fence

The broker lives in the sibling `infrastructure/github_broker` and is deployed from there. **This
repository holds no SAM template, AWS configuration, IAM policy, or broker deploy workflow.** It holds
the contract, so the two cannot drift:

```
POST {broker}/github/token    { client_id, code, redirect_uri }  → GitHub's token JSON, or { error, error_description }
POST {broker}/github/refresh  { client_id, refresh_token }       → the same shape
```

The secret is looked up by `client_id`; the request `Origin` is validated against an allowlist stored
beside it. No code, token, or secret is logged.

The broker URL and client identifier live in **one deployment-configuration module** with a lint fence
failing on any other module naming either — the third instance of the pattern the Base Map catalog and
the place lookup already use. Neither value is a secret.

### The OAuth callback in a prerendered static app

GitHub redirects to the editor with `?code=` and `?state=`, arriving on the single route that `?p=`
already addresses. `state` is generated before the redirect, verified against session storage on return,
and the parameters are stripped without disturbing the open Workspace. The existing guard against reading
search parameters during prerender is load-bearing here too.

### Import: two operations, both unauthenticated

The file list comes from one `GET /git/trees/{branch}?recursive=1`; the bytes come from
`raw.githubusercontent.com`. The tarball endpoint is unusable from a browser and must not be attempted
(ADR-0031). Public repositories only.

- **Clone a Workspace from a Remote** → a new named Workspace, bound. Restore's semantics: never
  overwrites, never merges, creates and switches. Resumable via the tree's blob SHAs.
- **Review a Project from a Remote** → a Review Workspace, unbound, unpublishable. The bundle-opening
  semantics.

Importing one Project into an existing Workspace stays refused, for ADR-0024's reason.

### The Front Page's return links

The editor stamps its own address into the published-site record at publish time. The Front Page then
carries **"Open this Workspace in Ballastella"** → `?clone=owner/repo`, and a Project page carries
**"Review this Project in Ballastella"** → `?review=owner/repo&p=<dir>`.

### `.nojekyll`

Written by every publish, unconditionally. The Jekyll fence must be extended to cover the synced tree —
the chain it follows now ends in a repository this repository writes to, which is the last point at which
it can be checked at all.

## Testing Decisions

**A good test here asserts what arrived at the Remote, not which calls were made.** Every failure mode in
this epic is silent and plausible: a truncated tree yields a commit missing most of a pyramid; an
off-by-one in the owned namespace deletes a `CNAME`; a manifest compared the wrong way round overwrites
another machine's Annotation. A test that counts requests or asserts a call order passes over all three.
The assertions are on the resulting tree — which paths exist, which blobs they point at, which paths are
gone, and which were left alone.

**No test may reach the network.** Already enforced on both sides: the domain package's setup refuses
fetch and Node's HTTP modules, and end-to-end specs must take their `test` from the composed network
fence, which a lint check verifies. The remedy is a fixture, never a stubbed global.

**One fake GitHub, two drivers, and no new kind of seam.** This is the `iiif-hosts` lesson applied before
the fact rather than after: three specs once grew their own IIIF hosts, and two specs could disagree about
what a service does while both stayed green. So a single fake — an in-memory object store that computes
**real** git blob SHAs and implements the tree, blob, commit, and ref endpoints — is written once in the
domain package and exported as a fixture, in the same spirit as the store conformance suite and the
directory-handle fixture. Everything else drives that one fake:

- **Seam 1 — the domain package, against the fake through an injected `fetch`.** The engine takes a
  `fetch` shim defaulting to the page's own, exactly as the HTTP store and the place lookup already do,
  so no bespoke client interface is invented. This is where the correctness lives: incremental upload
  (second publish sends nothing when nothing changed), the owned-namespace rules (a deleted Project's
  directory removed, a `CNAME` and a `docs/` folder preserved), the truncation refusal, the three budget
  warnings, the conflict refusal and its no-manifest fallback, blob-SHA agreement with real git, and the
  clone's resume.
- **Seam 2 — the end-to-end suite, against the same fake through Playwright routes.** A support module
  installs `page.route` handlers for the GitHub hosts before the context fence sees them, the shape
  `iiif-hosts` established. This is where the *experience* lives: the navigation bar's states, the bind
  flow and its rights refusal, the front-page toggle and its wording, progress and its announcements,
  the refusal dialogs and their remedies, clone and review arriving as the right kind of Workspace, and
  the credential's absence while a Review Workspace is open. The authorisation redirect and the broker
  response are faked by the same module, since neither may be reached.
- **Seam 3 — a lint fence** on the deployment-configuration module, with the positive-control discipline
  the existing fences use: known-bad and known-good samples checked before the scan, because a regex
  fence that matches nothing and a tree with nothing to match print the same success line.

**The Reader half reuses the existing published-site harness.** A Published Site assembled on disk from
the real built viewer and served at a domain root *and* a subdirectory already exists, and the Front
Page's filtering and its two return links are asserted there rather than by publishing through the editor
— the same division the current publish and reader specs already draw.

**Blob SHAs are asserted against real git, once.** The incremental upload, the conflict detection, and the
clone's resume all rest on the browser computing the same SHA git would. A single fixture test comparing
computed SHAs to known values for empty, text, and binary content is what stops all three being subtly
and consistently wrong together.

## Out of Scope

1. **No provider abstraction.** GitHub only. No `GitProvider` interface, no GitLab, no Gitea.
2. **No `isomorphic-git`, and no repository data through the broker**, ever.
3. **No branches, pull requests, merges, diffs, history browsing, or revert.** One branch, one commit per
   publish.
4. **No private repositories**, for publishing or cloning.
5. **No repository creation by the app.** Deferred — it may be revisited — not argued against.
6. **No background, automatic, or debounced publish.** Autosave semantics stop at local storage.
7. **No `formatVersion` bump.**
8. **No files deleted from the publish module.** "The local static site is no longer a product" is not
   licence to delete it.
9. **No credential in `localStorage` or IndexedDB.** A durable "remember me" is deferred; the interface
   exists so it stays a swap.
10. **No gating of the editor.** It is static files on a public URL; there is nothing to gate.
11. **No SAM template, AWS configuration, IAM policy, or broker deploy workflow in this repository.**
12. **No promoting a reviewed Project, and no single-Project publish.** ADR-0024 and ADR-0008 already
    refuse both; a new transport does not reopen them.
13. **No Git LFS.**
14. **Collaboration and multi-user editing remain out** (ADR-0014 fence 1). A shared Remote is not
    collaboration: a publish that would overwrite another machine's work is refused, not merged.

## Further Notes

**Records written during design.** ADR-0031 (the broker exchanges a code, never data), ADR-0032 (publish
means the Remote, and the Front Page is where a Reader arrives), ADR-0033 (a publish mirrors an owned
namespace and preserves the rest). ADR-0014 carries an amendment banner noting its fences 2 and 3 are
reversed and its fence 1 is not; ADR-0008 carries one replacing "hub page" with **Front Page**.
`CONTEXT.md` gained **Publish**, **Front Page**, **Remote**, and **Project Bundle**, and its **Published
Site** entry was rescoped.

**This epic spans two repositories.** The broker's template, IAM, and deployment are tracked in
`infrastructure/github_broker`. The tickets here cover the contract, the configuration module, the
callback handling, and the code path. Sequencing inside the epic is risk-ordered rather than
dependency-ordered: the fake GitHub first, then the engine against a pasted token, then the interface,
then clone and review, then the Front Page's links, and the GitHub App and broker last — because the
parts that can be subtly wrong are all testable before an app is registered.

**Measured facts this design rests on**, so they are not re-derived. `api.github.com` answers
`access-control-allow-origin: *` and exposes the rate-limit headers; `github.com/login/oauth/access_token`
sends no CORS headers, which is the entire reason a server exists; `codeload.github.com` answers a
specific origin and is therefore unusable from a browser; `raw.githubusercontent.com` answers `*`.
Lambda's synchronous request payload limit is 6 MB in both invocation styles, and there is no request
streaming, which is what closes off a browser `git push` through the broker. A recursive tree call
truncates at 100,000 entries or 7 MB **without erroring**.

**Three questions left at spec level.** Where bind and unbind sit — the Workspace menu or Workspace
settings. The exact state set for the Publish control: unbound, no credential, nothing changed, in
flight, refused, rate-limited. And whether the Base Map display-assets choice remains a checkbox now that
it carries a network cost rather than a disk one.

**One glossary nit deliberately left.** The **Library** entry lists "repository" among the words to avoid,
which predates "repository" having a live meaning here. The senses do not clash — that entry is about not
blurring an institution with a store — but a reader may hesitate.

# Hosting Ballastella, and publishing what you make with it

There are two different jobs here, done by two different people, and they produce two different
sites. Keeping them apart is most of understanding this document.

| | **Hosting the tool** | **Publishing your work** |
| --- | --- | --- |
| Who | An instructor or department who wants their own instance | Any scholar or student using one |
| What is served | The editor — the authoring application | A Workspace — your Projects, as a website |
| Where it comes from | A fork of this repository, built by CI | Your Workspace folder, sent by the editor |
| How often it changes | When you pull upstream changes | Every time you publish |

They are **separate repositories**, deliberately. One instance of the tool serves any number of
people, and each person's work lives in a repository they own. See
[ADR-0008](adr/0008-projects-live-in-a-workspace.md) for why a Workspace is one repository rather
than one per Project.

---

## Part 1 — Hosting your own instance

You need no server, no account with anyone, and no API key or secret of any kind. That is a
requirement rather than a happy accident, and CI asserts it: no `*_KEY`, `*_TOKEN`, or `*_SECRET`
appears in either app, and the build runs with no project-specific environment variables set.

### 1. Fork this repository

Nothing to configure in the fork itself. `.github/workflows/pages.yml` is already there.

### 2. Set the Pages source to GitHub Actions

In your fork: **Settings → Pages → Build and deployment → Source → GitHub Actions**.

**This is the one step you must not skip, and a fork does not inherit it.** The default is *Deploy
from a branch*, which serves the repository root — so visitors would get `README.md` and
`package.json` rather than an application. The workflow calls `actions/configure-pages`, which fails
by name if the source is still set to a branch, rather than reporting a successful deploy of
nothing.

### 3. Push, or run the workflow by hand

The workflow runs on every push to `main`, and can be triggered from **Actions → Pages → Run
workflow**. It builds `@ballastella/core`, the viewer, and the editor, checks the artifact, and
deploys.

It runs `pnpm build:deploy` rather than `pnpm build`. The two differ in one way: a deployment build
reads a filtered source tree, so a public instance ships neither the `/image-pane` developer harness
route nor the ~1 MB of test fixtures it reads. Both stay in the repository — a browser test suite
drives them — and it is the published artifact that leaves them out. If you build by hand for another
host, use `pnpm build:deploy` for the same reason, and `node scripts/check-deploy-artifact.mjs` will
tell you whether you got the build you meant.

Your instance is then at `https://<your-name>.github.io/<your-fork>/`.

That address is a *subdirectory*, not a domain root, and everything in both apps is built for it:
asset paths are relative, and CI greps the built output to keep them that way
([ADR-0006](adr/0006-the-project-directory-is-the-published-site.md)). A custom domain works the
same way with no reconfiguration — set it under **Settings → Pages → Custom domain** and rebuild.

### 4. Decide about the Base Map

**Read this before you tell anyone the instance is ready.**

Out of the box, your instance draws its reference map from
`https://data.source.coop/protomaps/openstreetmap/v4.pmtiles` — Protomaps' daily planet build,
mirrored on Source Cooperative. It works, keylessly, and it is **somebody else's bandwidth with no
promise to you**. Source Cooperative say in as many words that they do not recommend cross-origin
hotlinking to their URLs. Your deploy log says so too: the Pages workflow runs
`pnpm check:deployment` and annotates every run with a warning naming the borrowed archive.

To point at an archive you control, edit **one file** —
[`packages/core/src/base-map/catalog.ts`](../packages/core/src/base-map/catalog.ts) — and change
`REMOTE_ARCHIVE`. Nothing else in the repository needs to know:
`scripts/check-base-map-catalog.mjs` fails `pnpm lint` if any module outside the catalog names an
entry id or an archive, so that property is enforced rather than hoped for
([ADR-0020](adr/0020-base-map-catalog-author-default-and-reader-switching.md)).

Then run:

```sh
pnpm check:deployment
```

That command runs every deployment check there is, so it also reports on the place lookup below; the
archive is the half that blocks. It passes once the catalog reads an archive on a host the check does
not recognise as borrowed, and fails while it does not. It is deliberately *not* part of `pnpm lint`
— see
[CONTRIBUTING.md](../CONTRIBUTING.md) — because this repository's own deployment knowingly runs on
the borrowed archive for want of a hosting budget
([ADR-0025](adr/0025-no-base-map-ships-offline-is-per-project-and-opt-in.md)).

You can also add entries, relabel them, or offer several archives; the switcher in both apps reads
whatever the catalog holds.

### 5. Decide about the place lookup

The editor's search box — type a place name, and the map goes there or drops a Pin — asks a
geocoding service. Out of the box that is
[Nominatim](https://operations.osmfoundation.org/policies/nominatim/), OpenStreetMap's own, and it
is **borrowed** in exactly the sense the Base Map archive above is: keyless, working, and somebody
else's hardware with no promise to you.

To point at a service you run, edit **one file** —
[`packages/core/src/places/service.ts`](../packages/core/src/places/service.ts) — and change
`PLACE_SERVICE`. Its URL and its attribution sit in the same value deliberately, so repointing the
service moves the credit shown beside the candidate list with it; a fork that changed the archive
and not the lookup would otherwise display one organisation's credit over another's data. Nothing
else in the repository needs to know: `scripts/check-place-service.mjs` fails `pnpm lint` if any
module outside that file names the service's host
([ADR-0029](adr/0029-place-lookup-is-a-warned-service-that-leaves-nothing-behind.md)).

One caveat on "one file". A service running the same software as the default answers the same
document, and the address is the whole change. A service answering a *different* document also needs
`readPlace` in `packages/core/src/places/lookup.ts` taught to read it — the four fields the
application depends on are a display name, a latitude, a longitude, and a bounding box.

**`pnpm check:deployment` warns about the default service and does not fail on it**, which is the
opposite of what it does about a borrowed Base Map archive. That difference is deliberate. Repointing
an archive means putting a file in a bucket you control, which an instructor can do in an afternoon.
Repointing this means running a planet-scale geocoder: a planet import is days of compute, hundreds
of gigabytes, and permanent replication of the diffs after it. Almost nobody forking this repository
can do that, and a check that fails with a remedy nobody can take is a check people learn to route
around — taking the Base Map check standing beside it down with it, which *is* satisfiable and is the
one that must stay sharp.

Using the default is not a violation. Nominatim's usage policy permits this use and names its
conditions, and the application meets them: searches happen on submit and never as you type, no more
than one a second, with attribution displayed while candidates are on screen.

To find out whether the service you configured actually answers:

```sh
pnpm check:places
```

It issues **one** query and reports whether the answer still carries the fields the application
reads. It is the only **check** in this repository that reaches the network — `pnpm test:e2e`
downloads a browser before it runs, and nothing else goes out — and it is deliberately in
no gate — not `pnpm lint`, not `pnpm test`, not CI — because a check in a gate hands a stranger's
uptime the power to turn your repository red. Run it by hand after repointing, and again if search
stops working.

### 6. Decide about the GitHub sign-in

Publishing needs a GitHub credential, and there are two ways for a scholar to give the editor one.

**The paste always works, and needs nothing from you.** A scholar makes a fine-grained personal
access token on GitHub, pastes it into the Remote dialog, and publishes. No server is involved, no
configuration, and no account of yours. **If you do nothing at all in this section, this is your
fork's whole authentication and everything still works** — the publish path, its speed, and where the
data goes are identical either way.

**The nicer front door** is a button: press *Sign in with GitHub*, authorise on GitHub's own screen,
choose which repositories the app may touch, and come back signed in. This is the one part of
Ballastella that needs a server, and it needs one for a single reason:
`github.com/login/oauth/access_token` sends no CORS headers, so a browser cannot exchange an
authorisation code for a token by itself. Every other request — the file list, every blob, the
commit, every byte of a Clone — goes from the browser straight to `api.github.com`, which does
([ADR-0031](adr/0031-the-broker-exchanges-a-code-never-data.md)).

That server is called the **broker**, and it does that exchange and nothing else. **No repository
data ever passes through it.** Its code and its deployment live in a separate repository and are not
part of this one.

#### What ships today

**This repository's own deployment has an App and a broker, and they work.** The sign-in button on
`artshumrc.github.io/ballastella/` completes.

**A fork cannot use them**, and this is not a policy but a mechanism: the App's callback URL is
`https://artshumrc.github.io/ballastella/`, so GitHub will redirect there and nowhere else, and the
broker answers only requests whose `Origin` is on its allowlist. A fork therefore inherits a button
that fails with a sentence telling the scholar to paste a token, until it does the two steps below.

#### Turning it on for your fork

**You cannot borrow anyone else's App.** A GitHub App's callback URL is registered *on the App*, so
an App registered for one address will not redirect to yours. A fork at a different address needs its
own App and its own client ID — and until it has them, the pasted token is the whole of its auth.

1. Register a GitHub App on your account or organisation. Set its **callback URL** to the address
   your editor is served from — the same URL you would type into a browser to open it, spelled the
   same way. The editor sends the address the browser is actually at, so if people reach it as
   `…/editor/index.html` that is what GitHub is asked to match, and a callback registered as
   `…/editor/` will be refused with `redirect_uri_mismatch`. Give it **Contents: Read and write** and
   **Pages: Read and write**, and enable user-to-server tokens with expiry.
2. Deploy a broker that implements the two endpoints below, holding your App's client **secret**.
   The contract is fixed so the two repositories cannot drift:

   ```
   POST {broker}/github/token    { client_id, code, redirect_uri }  → GitHub's token JSON verbatim,
                                                                      or { error, error_description }
   POST {broker}/github/refresh  { client_id, refresh_token }       → the same shape
   ```

   It looks the secret up **by `client_id`** and validates the request's `Origin` against an
   allowlist stored beside that secret, which is what lets one deployment serve several unrelated
   projects without any of them minting tokens against another's App. It logs no code, no token, and
   no secret.
3. Edit **one file** —
   [`packages/core/src/remote/github-app.ts`](../packages/core/src/remote/github-app.ts) — and set
   the two values on `GITHUB_APP`:

   ```ts
   export const GITHUB_APP: GitHubApp = {
   	brokerOrigin: 'https://broker.your-institution.edu',
   	clientId: 'Iv1.your-real-client-id'
   };
   ```

   **Neither is a secret.** A client ID is public by design — it travels in the authorize URL, in
   front of the user. The client secret never leaves your broker.

Nothing else in the repository needs to know: `scripts/check-github-broker.mjs` fails `pnpm lint` if
any module outside that file names your broker's host or your client ID, which is what keeps
"repoint it in one edit" true rather than merely intended.

#### Turning it off

Set both values to the empty string. The button disappears entirely — rather than sitting there
leading somewhere that cannot work — and the pasted token becomes your fork's whole auth again.
`pnpm lint` then reports `NO GITHUB APP CONFIGURED` instead of a containment scan, which is a
deliberately different line: a fence with nothing to look for must not print the same success message
as a fence that looked and found nothing.

Set **both, or neither**. A broker with no client ID has nothing to look a secret up by, and a client
ID with no broker has nowhere to exchange a code, so `pnpm lint` refuses a half-configured pair.

### 7. Keeping up with upstream

Pull from this repository and push; the workflow redeploys. The editor is a PWA with an explicit
update prompt, so a user with the old version open is told rather than silently switched
([ADR-0012](adr/0012-pwa-with-explicit-update-prompt.md)).

One thing to know before pulling: a Project file records an integer `formatVersion`, and an app that
meets a *higher* one stops and names the remedy rather than dropping fields it does not recognise
([ADR-0010](adr/0010-integer-format-version-with-forward-only-migrations.md)). So an instance left
far behind upstream refuses newer Projects loudly. That is the intended behaviour, and it is the
reason to keep the fork current.

---

## Part 2 — Publishing your Workspace

Your Workspace is a folder on your computer holding your Projects. To **Publish** is to send that
folder's files to its **Remote** — the one GitHub repository the Workspace is bound to — so that the
**Published Site** at that address becomes your work as it now stands. There is no `git` to learn and
nothing to install: the editor talks to GitHub from the browser.

Publishing **adds** files to that same folder and copies none of your data, not one tile
([ADR-0006](adr/0006-the-project-directory-is-the-published-site.md)). It is never automatic: your
edits are saved to your own disk as you make them; nothing reaches the Remote until you press the
button ([ADR-0032](adr/0032-publish-means-the-remote.md)).

### Read this before your first publish: everything there is public

The Remote is a public repository, and everything in it can be read by anyone who has the address —
every Project, every Historical Map, every annotation.

**A Project you keep off the Front Page is still readable by anyone with the link.** The Front Page
is the site's front door, listing the Projects a Reader arriving there is offered; taking a Project
off it is an editorial decision about that list and nothing more. It is not a lock, not a password,
and not an embargo. Do not put material there that is under embargo, under licence, or otherwise not
yet yours to hand to a stranger.

### 1. Make an empty repository on GitHub

The editor offers you a link to `github.com/new` with the name already filled in from your Workspace.
Choose **Public**, add nothing to it — no README, no `.gitignore`, no licence — and create it. A
repository with nothing in it is what a first Publish expects.

One repository for the whole Workspace, not one per Project.

### 2. Bind your Workspace to it

In the editor: **Workspace menu → Remote repository…**. Paste the repository's address, and give the
editor a credential.

**A pasted token always works, on any instance.** Make a fine-grained personal access token on
GitHub — **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate
new token**, or go straight to
[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
([GitHub's own instructions](https://docs.github.com/en/authentication/keeping-your-account-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)).
Four things on that form matter:

- **Resource owner.** The account or organisation that owns the repository you made in step 1. If
  you created it under an organisation and leave this as your own account, you will get a token that
  cannot see it — and the symptom is a repository that appears not to exist.
- **Repository access.** Choose *Only select repositories*, and select that one repository.
- **Permissions → Repository permissions.** Two rows in a long list: set **Contents** to *Read and
  write*, and **Pages** to *Read and write*. Everything else can stay at *No access*.
- **Expiration.** Whatever you are comfortable with. When it expires, publishing says so and you make
  another one.

Copy the token on the screen that follows — that is the only time GitHub shows it — and paste it into
the dialog.

**There may also be a *Sign in with GitHub* button, and its being there does not mean it works.** The
button appears whenever the instance has App values configured, and a fork inherits the ones it was
forked from — which name an App that will only ever redirect to the instance those values belong to.
So on a fork the button is on screen and the attempt fails with a sentence telling you to paste a
token instead. Only an instance that registered its own GitHub App and deployed a broker can complete
that sign-in (part 1, step 6). If you do not know which kind of instance you are on, paste a token:
it is the same publish either way.

**The credential is forgotten when you close the tab.** It is kept in the browser tab's own storage,
never in your Workspace — a token in the Workspace would leave your machine inside the next publish,
or inside an archive you sent a colleague. Reloading the page keeps it; closing the tab, or coming
back tomorrow, means pasting it again.

The **binding** is the part that persists. Binding checks that the credential can actually write to
that repository before it keeps anything, so a mistyped address or a token without the rights is
refused there and then rather than half way through an upload. A Workspace has at most one Remote,
and the binding is recorded in a `remote.json` in the Workspace itself, so it travels with the folder
— copy the Workspace to another machine and it still knows where it publishes, and still asks you for
a credential.

### 3. Press Publish

**Publish…**, on the navigation bar. The dialog tells you how many files and how many bytes it is
about to send, how many Projects the Published Site will carry and how many of those the Front Page
lists, and warns you about anything that would disappoint a Reader — a Project that references
images from a Library, for instance, which a Reader with no network will not see.

The editor writes the read-only viewer, the Front Page, and `.nojekyll` in beside your Projects, and
sends the whole Workspace as a single commit. Nothing on your **Published Site** changes until that
commit lands, so a publish that fails half way through leaves it exactly as the last one left it.

Afterwards your Workspace holds these entries beside your Projects:

```
workspace/
├── index.html              ← the Front Page, listing the Projects you put on it
├── _app/                   ← the read-only viewer
├── ballastella-site.json   ← the Project list, and the Base Map settings the site was published with
├── remote.json             ← which repository this Workspace publishes to
├── .nojekyll               ← see below; do not delete it
├── amsterdam-1625/         ← your work, untouched
└── boston-1775/            ← your work, untouched
```

You can delete every one of them and each Project directory is still complete and readable, in
standard formats, with no proprietary index left behind.

### 4. Turn Pages on by hand

**Following the steps above, you will do this yourself.** Binding asks GitHub to turn Pages on for
you, but binding happens in step 2, when the repository is still the empty one step 1 told you to
make — and GitHub cannot point Pages at a branch that does not exist yet. So the request is refused,
and the editor says so in words and tells you what to click. The automatic path is for the case where
the repository already has a branch: binding a second machine, or re-binding, to a repository you have
published from before.

The editor asks GitHub that question only at the moment of binding. Re-opening **Workspace menu →
Remote repository…** afterwards offers to unbind, not to try Pages again, so there is nothing to press
a second time — do it on GitHub.

Once your first publish has landed, it is one setting, done once: **Settings → Pages → Source →
Deploy from a branch**, branch `main`, folder `/ (root)`.

Here you *do* want the branch deploy, because the site is already built — what was sent is the
website. There is nothing to compile.

Your Published Site is then at `https://<your-name>.github.io/<your-repository>/`, and a single
Project is at `…/?p=amsterdam-1625`. Those URLs are stable and citable; send them to anyone.

### 5. Publish again whenever you like

Press **Publish** again. Only what changed is uploaded — files the Remote already holds are not sent
a second time — so an ordinary publish after an afternoon's work takes seconds.

A Project deleted from your Workspace is removed from the Remote, with the tiles only it used. Files
you put in the repository yourself and the editor knows nothing about — a `CNAME`, a `README.md`, a
`docs/` folder — are left alone
([ADR-0033](adr/0033-a-publish-mirrors-an-owned-namespace.md)). This is the
one-repository-per-semester workflow: set hosting up once, publish all term. The one thing you do
repeat is the credential — it goes when the tab closes, so a publish in a fresh tab asks you to paste
your token again (step 2). The Remote, the Pages setting, and everything already on the Published
Site are untouched by that.

### The hourly request budget, and the publish it will not fit

GitHub allows an account **5 000 requests an hour**, and a publish spends roughly one on every file it
has not sent before, plus a few to write the commit. This is a ceiling rather than a throttle: a
publish that fits inside it runs at full speed and is done in minutes, and every publish after the
first sends only what changed and takes seconds.

What it is not is something to wait out. If the budget runs out part way through, publishing **stops**
and names the time it resets; nothing has been published, because the branch has not moved and your
Published Site is exactly as it was. **Publishing again starts the upload from the beginning.**
Nothing resumes: what was sent before the stop is in no commit, so the next attempt cannot see it and
sends it again. A publish therefore either finishes inside one hour's budget or it does not finish at
all — and the editor tells you which before it sends a byte.

Publishing in stages — adding and publishing part of your work at a time — helps only where each
stage fits inside the budget on its own.

**There is a case that has no answer today.** The smallest thing you can add is one Historical Map,
and a freshly tiled one is thousands of tiles: an image at the largest size the editor will take is
roughly 11 000 of them. A single Historical Map that large is more than one hour's budget in one
indivisible step, and no order of publishing makes it smaller — so **a Workspace holding one may not
be publishable to GitHub at all as things stand.** This is a known, recorded gap awaiting a decision
rather than something to work around; see "Known gaps" below.

### The three limits, and what drives each

| Limit | Roughly | Driven by |
| --- | --- | --- |
| Total bytes | **1 GB** for the whole site | offline Base Map tiles, ~150 kB each |
| Total files | **40 000** | Historical Map pyramids, which are thousands of small tiles each |
| Requests an hour | **5 000** | a first publish, which sends every file once |

The first two are properties of your Workspace; the third is a property of the hour you are in. You
are told about all three before anything is uploaded rather than by a failure part way through: about
bytes at the two moments that matter — before making an Offline Copy of a large map, and at publish
([ADR-0008](adr/0008-projects-live-in-a-workspace.md)) — and about requests when you press Publish. A
Workspace past the file ceiling is refused outright, because a publish over it is one GitHub would
silently truncate.

Two further notes if you are working near the limits:

- Git refuses any single file over **100 MB**. Nothing the editor writes into a Workspace comes near
  it — a map tile is a few kilobytes — so this only bites if you add something large by hand.
- **Do not put a Workspace in Git LFS.** Pages does not resolve LFS pointers; it would serve the
  pointer files, and every tile and every page would be a few lines of text instead of the thing it
  stands for.

### What `.nojekyll` is, and why it must stay

GitHub Pages, when deploying from a branch, runs your files through Jekyll — and Jekyll ignores
every path beginning with `_`. The viewer lives in `_app/`. Without an empty `.nojekyll` file at the
root of your site, GitHub would serve your Front Page and then refuse to serve any of the JavaScript
in it: **a blank page, with the reason visible only in a browser's developer console.**

It is empty, and publishing writes it directly rather than copying it from anywhere — there are no
bytes in it to copy, and a file fetched over the network is a file that can 404.

Publishing writes the file for you, into your Workspace and into **every** commit it sends to your
Remote, whether or not your Workspace holds a copy — so in normal use you will never think about it.
It is mentioned here because it is an empty file with a strange name, and empty files with strange
names get tidied away.

### Other hosts

A published Workspace is a directory of static files with no server-side anything, and it works at a
domain root or in a subdirectory from the same bytes. Publish goes to GitHub, but the folder does not
have to stay there: copy the Workspace to anywhere that serves files and the site works. `.nojekyll`
is inert everywhere else — harmless, and worth keeping in case the folder later goes to Pages.

---

## Known gaps

- **This repository's own deployment runs on a borrowed Base Map archive** (part 1, step 4).
  `pnpm check:deployment` fails until an archive is provisioned, and the Pages workflow reports it as
  a warning on every deploy rather than blocking. That is a recorded human decision
  ([ADR-0025](adr/0025-no-base-map-ships-offline-is-per-project-and-opt-in.md)), not an oversight,
  and a fork inherits it until it repoints the catalog.
- **This repository's own deployment uses a borrowed place lookup service** (part 1, step 5). The
  editor's search box asks OpenStreetMap's Nominatim, which no deployment here runs.
  `pnpm check:deployment` **warns** about it and does not fail, unlike the archive above, and the
  Pages workflow annotates every deploy with that warning. Why it warns rather than fails is part 1,
  step 5, and [ADR-0029](adr/0029-place-lookup-is-a-warned-service-that-leaves-nothing-behind.md). The use is
  within that service's published policy, and a fork inherits it until it repoints
  `packages/core/src/places/service.ts`.
- **A publish stopped by the hourly request budget starts again from the beginning, and a large
  Historical Map may therefore not be publishable at all** (part 2, "The hourly request budget").
  What was uploaded before the stop is in no commit, so the next attempt sends it again and nothing
  resumes. Publishing in stages is the remedy where the work divides into stages that each fit inside
  5 000 requests; a single freshly tiled Historical Map is roughly 11 000 tiles at the largest size
  the editor accepts, does not divide, and has no path to a GitHub Remote today. That is an open
  question awaiting a human decision in this epic's tracker, not an oversight — and the alternative,
  moving the branch to a half-uploaded commit, would break the promise that a Published Site never
  changes until a publish has wholly arrived.
- **Publishing a single Project standalone** is not implemented. The Workspace is the site; a
  per-Project output is a deferred second mode (ADR-0008).
- **Pretty per-Project URLs** (`/amsterdam-1625/` rather than `?p=amsterdam-1625`) are deferred, and
  additive when they arrive (ADR-0008).

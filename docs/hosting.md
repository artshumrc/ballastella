# Hosting Ballastella, and sharing what you make with it

There are two different jobs here, done by two different people, and they produce two different
sites. Keeping them apart is most of understanding this document.

| | **Hosting the tool** | **Keeping and sharing your work** |
| --- | --- | --- |
| Who | An instructor or department who wants their own instance | Any scholar or student using one |
| What is served | The editor — the authoring application | A Workspace — your Projects, and optionally a site |
| Where it comes from | A fork of this repository, built by CI | Your Workspace folder, sent by the editor |
| How often it changes | When you pull upstream changes | Every time you sync |

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
([ADR-0045](adr/0045-a-repository-holds-the-work-and-a-site-is-asked-for.md)). A custom domain works
the same way with no reconfiguration — set it under **Settings → Pages → Custom domain** and rebuild.

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

Sending work to GitHub needs a credential, and there are two ways for a scholar to give the editor one.

**The paste always works, and needs nothing from you.** A scholar makes a fine-grained personal
access token on GitHub, pastes it behind *Sync with GitHub* on the editor's bar, and syncs. No
server is involved, no configuration, and no account of yours. **If you do nothing at all in this
section, this is your fork's whole authentication and everything still works** — the sync path,
its speed, and where the data goes are identical either way.

**It is the door offered where there is no App, and only there.** The three values below decide which
of the two a scholar is shown, and they are never shown both: a person asked to choose between two
credentials has no way to tell which one is meant for them, and one of the two sends them off to
generate a secret. So where an App is configured, *Sync with GitHub* leads to the sign-in and no
token field appears anywhere on the screen a student meets. The one exception is a disclosure on the
door itself — *Signing in will not work for me* — which starts closed and puts nothing in the page
until it is pressed. That is the way back in for an instructor whose App installation has broken
mid-class, and it is worded for somebody who already knows what they are asking for. Where the three
values are empty, *Sync with GitHub* leads straight to the paste, with the guidance a fork's author
needs, and no sign-in button is shown at all.

**The nicer front door** is a button: press *Sign in with GitHub*, install the App and authorise it
on GitHub's own screen, choose which repositories the app may touch, and come back signed in — one
trip, because the App asks for user authorisation *during* installation. This is the one part of
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

   Then tick **Request user authorization (OAuth) during installation**. This is what makes a
   first-time author's trip one screen instead of two: GitHub installs the App and issues the
   authorisation code together, and returns to the callback URL above carrying `code` and `state`.
   Without it, somebody signing in for the first time comes back holding a credential against no
   installation, and Ballastella can only show them a list of no repositories.

   **Register no Setup URL.** Ballastella never reads `setup_action`, which is undocumented across
   the whole of GitHub's documentation, and a Setup URL would take the author somewhere the
   application is not.
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
   the three values on `GITHUB_APP`:

   ```ts
   export const GITHUB_APP: GitHubApp = {
   	brokerOrigin: 'https://broker.your-institution.edu',
   	clientId: 'Iv1.your-real-client-id',
   	appSlug: 'your-app-slug'
   };
   ```

   `appSlug` is the last segment of **Public link** on your App's settings page — the address
   `https://github.com/apps/…` points at. It is *not* the App's display name: GitHub lowercases and
   hyphenates that to make the slug, and the two can differ. It is what the install screen a
   first-time author is sent to hangs off, so a wrong one sends them to somebody else's App or to a
   404.

   **None of the three is a secret.** A client ID is public by design — it travels in the authorize
   URL, in front of the user — and the slug is a public link GitHub prints for you. The client secret
   never leaves your broker.

Nothing else in the repository needs to know: `scripts/check-github-broker.mjs` fails `pnpm lint` if
any module outside that file names your broker's host, your client ID, or `github.com/apps/<your
slug>`, which is what keeps "repoint it in one edit" true rather than merely intended. The slug is
fenced as that address rather than as a bare word, because an App is usually named after the project
it belongs to and a fence on the word alone would refuse the project's own package names.

#### Turning it off

Set all three values to the empty string. The button disappears entirely — rather than sitting there
leading somewhere that cannot work — and the pasted token becomes your fork's whole auth again, and
the front door of the guided sequence: *Sync with GitHub* opens on the repository address and the
token rather than on a sign-in nobody can complete.
`pnpm lint` then reports `NO GITHUB APP CONFIGURED` instead of a containment scan, which is a
deliberately different line: a fence with nothing to look for must not print the same success message
as a fence that looked and found nothing.

Set **all three, or none**. A broker with no client ID has nothing to look a secret up by, a client
ID with no broker has nowhere to exchange a code, and a missing slug is an install screen nobody can
be sent to, so `pnpm lint` refuses a part-configured App.

#### What owning the App means you can reach

Read this before a class uses your deployment, and tell whoever is responsible for your institution's
records that it is true.

**A student's own sign-in reaches only what that student granted.** The App issues a *user access
token*, which acts as that person and is confined to the repositories they chose when they authorised
it. No student's sign-in can touch another student's repositories, and the broker never sees a token
that could — it exchanges a code for one and forgets it.

**The App's private key is a different thing entirely.** Whoever owns the App holds a key that can
mint *installation* tokens for every account the App is installed on, within the permissions the App
was granted — which for this one is Contents and Pages, read and write. So the organisation that owns
the App has latent read and write access to every repository any of its users granted it, without
anybody signing in and without any further consent at the moment of use.

That is inherent to owning a GitHub App and is not a weakness in the broker, which never holds the
private key and could not mint such a token if it wanted to. It is stated here because it is the sort
of thing an institution has to have decided about *before* thirty students grant an App access to
their coursework, and because the alternative — hosting no App — is a supported configuration rather
than a lesser one. Its cost is the paste, and its benefit is that nobody holds a key to anybody's
work.

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

## Part 2 — Syncing your Workspace, and sharing what is in it

Your Workspace is a folder on your computer holding your Projects. To **Sync** is to bring that folder
and its **Remote** — the one GitHub repository your Workspace is connected to — into agreement, in
whichever direction the difference lies. There is no `git` to learn and nothing to install: the editor
talks to GitHub from the browser.

Syncing moves your files and nothing else. Whether your work also answers at a web address is a
separate question with a separate answer, and part 2 reaches it at step 5.

### 1. Make a repository on GitHub

The editor offers you a link to `github.com/new` with the name already filled in from your Workspace.
Add nothing to it — no README, no `.gitignore`, no licence — and create it.

One repository for the whole Workspace, not one per Project.

**Public or private is your choice, and it decides one thing.** A private repository syncs exactly
like a public one. What it costs you is that **Share Links** need GitHub Pages, and Pages on a private
repository requires a paid GitHub plan; on a free account it is available on public repositories only.
It also means nobody can take a copy of your Workspace from the repository without being signed in and
given access, which for a class or a collaborator is sometimes what you want and sometimes the thing
in the way.

**A public repository is public from the moment you sync to it**, whether or not you ever turn Share
Links on — every Project, every Map Image, every annotation, readable by anyone who has the address.
Do not put material there that is under embargo, under licence, or otherwise not yet yours to hand to
a stranger.

### 2. Connect your Workspace to it

In the editor: **Sync with GitHub** on the bar. What that opens depends on the instance. Where a GitHub
App is configured it walks you through signing in and then lists the repositories you have given the
app access to, and connecting is pressing the one you want. Where none is, it asks for the
repository's address and a token.

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
  write*, and **Pages** to *Read and write*. Everything else can stay at *No access*. Contents is all
  a Sync needs; Pages matters only at step 5.
- **Expiration.** Whatever you are comfortable with. When it expires, the editor says so and you make
  another one.

Copy the token on the screen that follows — that is the only time GitHub shows it — and paste it into
the field the editor asks for it in.

**Where there is a *Sign in with GitHub* button, its being there does not mean it works.** The button
appears whenever the instance has all three App values filled in, and a fork inherits the ones it was
forked from — which name an App that will only ever redirect to the instance those values belong to.
So on such a fork the button is on screen and the attempt fails with a sentence telling you to paste a
token instead. Only an instance that registered its own GitHub App and deployed a broker can complete
that sign-in (part 1, step 6). If you do not know which kind of instance you are on, paste a token: it
is the same Sync either way, and where the button is there the paste is behind *Signing in will not
work for me* on the same screen.

**Getting needs no credential; sending does.** If all you want is a copy of somebody's public
Workspace — an instructor's, say — make an empty Workspace, connect it to their repository by
address, and get. No GitHub account is involved. A credential is needed to send, and to touch a
private repository at all.

**A pasted token is forgotten when you close the tab.** It is kept in the browser tab's own storage,
never in your Workspace — a token in the Workspace would leave your machine inside the next Sync, or
inside an archive you sent a colleague. Reloading the page keeps it; closing the tab, or coming back
tomorrow, means pasting it again. There is no way to keep one longer, because a pasted token has no
renewable half.

**A sign-in is forgotten when you close the tab too, unless the person using it asks otherwise.** The
sign-in screen carries *Keep me signed in on this computer*, unticked until somebody ticks it, so a
shared or library machine keeps nothing unless the person at it says otherwise. Where it is ticked,
this installation keeps the part that renews the sign-in and never the part that writes, in storage no
Backup packs and no Sync uploads.

**The connection is the part that persists, and it stays on this computer.** Connecting checks that
the credential can actually write to that repository before it keeps anything, so a mistyped address
or a token without the rights is refused there and then rather than half way through an upload. A
Workspace has at most one Remote, and which repository that is, is remembered by this browser rather
than written into the folder — so a Workspace copied to another machine arrives unconnected, and you
connect it there. That is deliberate: a copied or forked repository cannot silently claim a Workspace
that was never sent to it.

### 3. Sync

**Sync**, on the navigation bar. It never sends or fetches anything on the press: it reads both sides
and opens on what it found, in two columns —

- **To get**, listing what is on GitHub that your Workspace has not got.
- **To send**, listing what your Workspace has that GitHub has not got.

— with, under each, exactly what would be *removed* from that side, named. Then four choices:

| | |
| --- | --- |
| **Get changes** | Bring GitHub's side in. Nothing of yours leaves. |
| **Send changes** | Send your side out. Nothing comes in. |
| **Get and send** | Both. |
| **Overwrite the repository** | Make the repository match your Workspace exactly, deleting whatever it has that you have not. |

**Send never deletes work you have not seen.** It removes from the repository only files that were
there the last time the two sides agreed and that you have since deleted. Something a collaborator, or
your other laptop, added after that is left alone and comes down on your next *get*. The first sync of
a Workspace deletes nothing at all in either direction, because there is no record of a previous
agreement to judge a deletion against.

**Overwrite is the one that can lose somebody else's work**, which is why it is set apart, why it
names the files it would remove before it will do it, and why it insists on a confirmation where the
repository is not solely yours. What it replaces stays in the repository's Git history, which is a
consolation rather than a plan.

Everything goes as a single commit. Nothing on GitHub changes until that commit lands, so a Sync that
fails half way through leaves the repository exactly as the last one left it.

**When the same file has changed on both sides**, the Sync does not stop. Everything that can be moved
safely moves, and the contested file becomes a second copy so that you can look at both and delete
one: a contested set of annotations arrives as another Layer, `… (from GitHub)`; a contested Project
arrives as another Project. The copy goes to both sides, so your other machine sees the pair too.
Ballastella never merges the two and never picks between them.

**An Alignment is the exception.** There is one Alignment per Map Image, so a second file would be a
copy you could never look at. There the editor asks you directly — keep yours, or take the one from
GitHub — showing how many control points each has and when each was made.

### 4. Syncing again

Press **Sync** again. Only what changed moves — files the other side already holds are not sent or
fetched a second time — so an ordinary sync after an afternoon's work takes seconds.

A Project deleted from your Workspace is removed from the repository on your next send, with the tiles
only it used. Files you put in the repository yourself and the editor knows nothing about — a `CNAME`,
a `README.md`, a `docs/` folder — are left alone
([ADR-0033](adr/0033-a-sync-mirrors-an-owned-namespace.md)). This is the one-repository-per-semester
workflow: connect once, sync all term. The one thing you do repeat is the credential — it goes when
the tab closes, so a send in a fresh tab asks you to paste your token again (step 2).

The bar tells you where things stand without your asking, and names your repository only when the two
sides actually agree: *in sync with `you/your-repo`*, or *changes to send*, *changes to get*, *changes
both ways*.

### 5. Share Links: giving your work an address

Everything so far has moved files. **Share Links** is what gives them a web address, so that a Project
can be opened by a link. It is optional, it is asked for once, and it lives in your Workspace's own
settings — or it offers itself the first time you press **Share Project** on a Project without it.

**Read this before you turn it on.** With Share Links your repository also serves a website, and
anything in the repository can be fetched from it. A Project you keep off the Front Page is still
readable by anyone with its link: the Front Page is the site's front door, listing the Projects a
Reader arriving there is offered, and taking a Project off it is an editorial decision about that list
and nothing more. It is not a lock, not a password, and not an embargo.

Turning it on does two things: it adds the read-only viewer to your repository — written in beside
your Projects, copying none of your data, not one tile — and it asks GitHub to turn Pages on.

**GitHub will often refuse that second part, and the refusal is not about anything you did wrong.**
GitHub requires **Pages: Read and write** *and* **Administration: Read and write** together to turn a
site on for you, and Ballastella's GitHub App asks for the first and never the second — it will not
ask for the right to rename, transfer, or delete your repositories
([ADR-0040](adr/0040-one-installation-chosen-wide-and-no-repository-administration.md)). A pasted
token can carry both if you grant them; a sign-in never can.

So where GitHub refuses, the editor hands you the one setting and waits: **Settings → Pages → Source →
Deploy from a branch**, branch `main`, folder `/ (root)`. Set it, come back, and press **Check
again** — the editor keeps asking GitHub until the site answers and then carries on by itself. It
needs a branch to point at, so if your repository is still empty, sync once first; that is what makes
the branch. You want the branch deploy here, because the site is already built. There is nothing to
compile.

Your site is then at `https://<your-name>.github.io/<your-repository>/`, and a single Project is at
`…/?p=amsterdam-1625`. Those URLs are stable and citable.

Afterwards your Workspace holds these entries beside your Projects:

```
workspace/
├── index.html              ← the Front Page, listing the Projects you put on it
├── _app/                   ← the read-only viewer
├── ballastella-site.json   ← the Project list, and the Base Map settings the site was built with
├── .nojekyll               ← see below; do not delete it
├── amsterdam-1625/         ← your work, untouched
└── boston-1775/            ← your work, untouched
```

You can delete every one of them and each Project directory is still complete and readable, in
standard formats, with no proprietary index left behind. Until you turn Share Links on, none of them
exists and the repository holds your Projects and your Map Images and nothing else.

**Turning Share Links off** takes the viewer out of the repository on your next sync and asks GitHub
to turn the site off. It cannot undo what is already out: every link you have given anybody stops
working, the address may keep answering from a cache for a while, and anything already fetched,
forked, or archived is beyond reach. Your repository and your work are untouched. It is not a way to
unpublish.

### 6. The Front Page, and sharing one Project

**A Project is on the Front Page only because you put it there.** New Projects are not, and nothing
appears there by default. Open a Project's settings and turn on **Show on Front Page**; that is the
only place it is set, and you can set it before you have Share Links at all, in which case it takes
effect when you turn them on.

**Share Project**, in the same settings, hands you that Project's link. It works whether or not the
Project is on the Front Page — the Front Page is discovery, not permission. If that Project has work
you have not sent yet, the editor offers to sync first, because a link that quietly serves last
week's work is worse than a moment's wait.

A Front Page with nothing on it shows nothing at all.

### The hourly request budget, and the sync it will not fit

GitHub allows an account **5 000 requests an hour**, and a sync spends roughly one on every file it has
not moved before, plus a few to write the commit. This is a ceiling rather than a throttle: a sync that
fits inside it runs at full speed and is done in minutes, and every sync after the first moves only
what changed and takes seconds.

What it is not is something to wait out. If the budget runs out part way through, the sync **stops**
and names the time it resets; nothing has been sent, because the branch has not moved. **Syncing again
starts the upload from the beginning.** Nothing resumes: what was sent before the stop is in no commit,
so the next attempt cannot see it and sends it again. A sync therefore either finishes inside one
hour's budget or it does not finish at all — and the editor tells you which before it sends a byte.

Syncing in stages — adding and sending part of your work at a time — helps only where each stage fits
inside the budget on its own.

**There is a case that has no answer today.** The smallest thing you can add is one Map Image, and a
freshly tiled one is thousands of tiles: an image at the largest size the editor will take is roughly
11 000 of them. A single Map Image that large is more than one hour's budget in one indivisible step,
and no order of syncing makes it smaller — so **a Workspace holding one may not reach GitHub at all as
things stand.** This is a known, recorded gap awaiting a decision rather than something to work
around; see "Known gaps" below.

### The three limits, and what drives each

| Limit | Roughly | Driven by |
| --- | --- | --- |
| Total bytes | **1 GB** for the whole repository | offline Base Map tiles, ~150 kB each |
| Total files | **40 000** | Map Image pyramids, which are thousands of small tiles each |
| Requests an hour | **5 000** | a first sync, which moves every file once |

The first two are properties of your Workspace; the third is a property of the hour you are in. You
are told about all three before anything is uploaded rather than by a failure part way through: about
bytes at the two moments that matter — before making an Offline Copy of a large map, and when you sync
([ADR-0008](adr/0008-projects-live-in-a-workspace.md)) — and about requests when you press Sync. A
Workspace past the file ceiling is refused outright, because a tree over it is one GitHub would
silently truncate.

Two further notes if you are working near the limits:

- Git refuses any single file over **100 MB**. Nothing the editor writes into a Workspace comes near
  it — a map tile is a few kilobytes — so this only bites if you add something large by hand.
- **Do not put a Workspace in Git LFS.** Pages does not resolve LFS pointers; it would serve the
  pointer files, and every tile and every page would be a few lines of text instead of the thing it
  stands for.

### What `.nojekyll` is, and why it must stay

GitHub Pages, when deploying from a branch, runs your files through Jekyll — and Jekyll ignores every
path beginning with `_`. The viewer lives in `_app/`. Without an empty `.nojekyll` file at the root of
your site, GitHub would serve your Front Page and then refuse to serve any of the JavaScript in it:
**a blank page, with the reason visible only in a browser's developer console.**

It is empty, and the editor writes it directly rather than copying it from anywhere — there are no
bytes in it to copy, and a file fetched over the network is a file that can 404.

It is written for you into every commit that carries a site, whether or not your Workspace holds a
copy, so in normal use you will never think about it. It is mentioned here because it is an empty file
with a strange name, and empty files with strange names get tidied away.

### Other hosts

A Workspace with Share Links is a directory of static files with no server-side anything, and it works
at a domain root or in a subdirectory from the same bytes. A Sync goes to GitHub, but the folder does
not have to stay there: copy the Workspace to anywhere that serves files and the site works.
`.nojekyll` is inert everywhere else — harmless, and worth keeping in case the folder later goes to
Pages.

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
- **A sync stopped by the hourly request budget starts again from the beginning, and a large
  Map Image may therefore never reach GitHub** (part 2, "The hourly request budget").
  What was uploaded before the stop is in no commit, so the next attempt sends it again and nothing
  resumes. Syncing in stages is the remedy where the work divides into stages that each fit inside
  5 000 requests; a single freshly tiled Map Image is roughly 11 000 tiles at the largest size
  the editor accepts, does not divide, and has no path to a GitHub Remote today. That is an open
  question awaiting a human decision, not an oversight — and the alternative, moving the branch to a
  half-uploaded commit, would break the promise that a repository never changes until a sync has
  wholly arrived.
- **A site holding a single Project alone** is not implemented. The Workspace is the site; a
  per-Project output is a deferred second mode (ADR-0008).
- **Pretty per-Project URLs** (`/amsterdam-1625/` rather than `?p=amsterdam-1625`) are deferred, and
  additive when they arrive (ADR-0008).

# A repository holds the work, and a site is asked for separately

Putting a Workspace on GitHub and putting it on the web are two different wishes, and a scholar has
the first one far more often than the second. Somebody who wants their work off one machine, or on two
machines, or simply somewhere other than a laptop that can be stolen, is not asking to be read by
strangers, and a design that grants both at once makes them buy the second to get the first.

**A Sync moves the scholar's own files and nothing else.** What lands in the repository is what they
would recognise if they browsed it on github.com:

```
images/**
alignments/**
base-map/tiles/**
<project>/project.json
<project>/annotations/**
```

No `index.html`, no `_app/**`, no `robots.txt`, no `ballastella-site.json`, and no record of the
binding: the relationship between a Workspace and its Remote is installation-local
([ADR-0044](./0044-sync-is-one-act-in-two-directions.md)), so a file in the tree describing it would
be a second copy that can disagree with the first. The one exception is a zero-byte `.nojekyll`, used
to seed a repository with no commits because `PUT /contents/` is the only endpoint that will write to
one.

## Share Links

**Share Links** is what an author asks for when they want an address, once, in the Workspace's own
settings. It turns GitHub Pages on for the Remote and adds the read-only viewer to the tree, and every
Sync afterwards keeps that viewer current — there is no separate act that rebuilds a site, and no
staleness a scholar has to notice and answer.

The viewer is written *into* the Workspace directory, additively, alongside the data already there.
No data is copied. The alternative — exporting to a separate output directory containing the viewer
*and a copy of the data* — was rejected on tile bytes: a single large Map Image is hundreds of
megabytes to gigabytes of pyramid, and copying it on every Sync is slow, and slowest precisely in
OPFS, which is the constrained backend.

Three consequences of that mechanism are load-bearing and easy to undo by accident:

- **`paths.relative: true` in the viewer's SvelteKit config is mandatory.** `paths.base` is baked at
  build time, and at build time we cannot know whether a scholar will land at
  `username.github.io/some-repo/` or at a domain root. Relative asset paths are the only way one build
  serves both.
- **The viewer files are an enumerable, recorded set** (`VIEWER_FILE_PATHS`, `isViewerFile`), so a
  Project Bundle and a Backup can exclude them and hand over clean data. Without that list the two
  export flavours are indistinguishable, and a Sync cannot tell what it may remove when Share Links
  are withdrawn.
- **The viewer is a separate, lean build** from the editor, sharing packages in one repo, and it reads
  through a third `ProjectStore` adapter: HTTP `fetch` over relative paths. Otherwise every site ships
  the tiler and terra-draw to readers who will never use them.

### Ballastella asks GitHub, and asks the author only when GitHub refuses

Enabling Pages is attempted on the author's behalf: `POST /repos/{owner}/{repo}/pages` with the branch
and `/` as the source, where `409` — already enabled — is success.

**It will often be refused, and that is a deliberate cost.** GitHub requires `Pages: write` **and**
`Administration: write` together to turn a site on, and Ballastella's App asks for the first and never
the second ([ADR-0040](./0040-one-installation-chosen-wide-and-no-repository-administration.md)).
Asking for `Administration: write` would buy one click at the price of holding the right to rename,
transfer, change the visibility of, and delete every repository a scholar owns, and would put a
re-approval prompt in front of every existing installation. It is not worth it.

So the refusal is a step in the flow rather than an error at the end of it: the deep link to
**Settings → Pages**, the two values to set (the branch, and `/ (root)`), and a **Check again** button
that polls `GET /repos/{owner}/{repo}/pages` until the site answers and then carries on by itself. The
author does one thing on github.com; the waiting and the verifying are ours. A repository with no
branch yet is reported as exactly that and not as a permission problem — `422` from that endpoint
means Pages has no branch to point at, which is the ordinary state of a repository made at
`github.com/new`, and reporting it as a bad token sends the author to fix something that is fine.

A private repository is offered Share Links on the same terms. Pages on one requires a paid GitHub
plan, which cannot be read reliably from the App's token, so guessing would lock out authors who have
paid; GitHub's refusal is handled like any other refusal.

**Withdrawing Share Links** removes the viewer files on the next Sync and attempts
`DELETE /repos/{owner}/{repo}/pages`, and says plainly what it cannot promise: every link already
given out stops working, the address may keep answering from cache for a while, and anything already
fetched or forked is beyond reach. The repository and the data are untouched. It is not a way to
unpublish, and it is never presented as one.

**Whether a Workspace has Share Links is observed from the bytes; whether the author wants them gone
is recorded.** Having them is carrying the viewer file set, on either side — a site first reaches a
Remote from a Workspace, and a Workspace that has just got one from a Remote carries none of it,
because a get brings the source namespace and nothing else. So the two facts a Sync can read are *the
Remote has a site* and *this Workspace does not*, and they are true of two opposite situations: an
author who withdrew, and an author on their second machine. Read as one, a Sync from the second
machine takes down a live site with every link handed out.

The asking is what separates them, so the asking is what is kept: a **withdrawal request**,
installation-local beside the Synchronization Baseline, naming the repository it is about, cleared by
the Sync that carries it out. It is an instruction with a lifetime, never a claim about which files
exist — nothing here can come to disagree with the tree. Every other Sync writes the viewer into the
Workspace before it sends, which is what keeps a site current from whichever machine the author is
sitting at.

## A Project is on the Front Page because somebody put it there

**`onFrontPage` defaults to off**, is set one Project at a time in that Project's own settings, and is
set nowhere else. A list of every Project with checkboxes, offered at the moment a site is created,
was rejected: two places to set one flag is how a scholar ends up unsure which one won, and the flag
belongs beside the Project it describes.

Absence of the field means off, and `true` is written explicitly. The flag goes into `project.json`
**without bumping `CURRENT_FORMAT_VERSION`** — [ADR-0010](./0010-integer-format-version-with-forward-only-migrations.md)
refuses a `formatVersion` higher than the build understands, and this project explicitly invites people
to fork and host their own instance, which keeps old builds alive in the wild. An older build drops the
flag into `unknownFields` and writes it back untouched. Where it does not, the failure is that a
Project falls *off* a front page, which is the conservative direction and changes nothing about who can
read it.

**Being on the Front Page is discovery, never permission.** The repository is readable, the files are
fetchable, and `?p=<directory>` opens a Project for anyone who has the link. This is why the flag is
called *on the Front Page* and is never called published, unpublished, private, draft, or hidden.
"Unpublished" needs a warning sentence bolted on to stop it being read as "unseen"; "not on the front
page" needs none. A scholar with an embargoed archival photograph, a manuscript under a library's
publication restriction, or a student's unmarked coursework will act on the reading the word invites,
and the invited reading has to be the true one.

**Share Project** hands over that link. It needs Share Links, and offers to set them up where they are
absent rather than failing. It also needs that Project's work to have reached the Remote: where it has
not, the primary action becomes *Sync and copy the link*, with *Copy the link anyway* beside it and one
sentence about what a reader would see, because a link that quietly serves yesterday's work is worse
than a wait.

## An empty Front Page says nothing

A Front Page with no Projects on it renders **blank** — and so does a site with no Projects at all.
Two different messages for the two states would make the difference between them the leak: a reader
who knows the tool sees the "none on the front page" wording and has learned that something unlisted
is there. For the same reason the Workspace return link is dropped from a blank Front Page, where it
would be the only thing on the page and would read as a signal. A Project's own page keeps its return
link, since whoever is looking at it already has the link.

The cost is real and is accepted: a reader who mistypes an address cannot tell an empty site from a
broken one. Nothing else on the page is worth what the alternative gives away.

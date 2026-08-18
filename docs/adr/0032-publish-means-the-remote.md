# Publish means the Remote, and the Front Page is where a Reader arrives

"Publish" used to mean *write `index.html` and a viewer bundle into the Workspace directory*. That is
[ADR-0006](./0006-the-project-directory-is-the-published-site.md)'s additive trick, and it is a good
mechanism — it is why publishing copies no tile. But it is a mechanism, and no scholar should have to
know it. A Publish button that puts nothing on the web was a wart the design carried only because
there was nowhere to put things.

Now there is. **Publish** means: the Workspace's files go to its **Remote**, and the Published Site at
that address becomes the work as it now stands. One act, one word, one button. The viewer bundle is
written locally as part of it whenever it is missing or stale — `publishedSiteStaleness` already
computes exactly that — so there is no separate "publish this Workspace as a website" action.

A **Remote** is the one GitHub repository a Workspace can be bound to. It is *orthogonal to backing*:
`WorkspaceBacking` stays `'browser' | 'folder'` and gains no third member, because a third member
would mean a new case in `#adopt`, in the journal keys, in the switcher, in `reopenable`, in
`canChooseFolder`, and in `discard` — six sites where a mistake in the journal key is silent.

## The three states, and the one that is dangerous

A Project is now in one of three states, and the middle one is the reason this section exists.

1. **Local only.** Never published.
2. **Published, but not on the Front Page.**
3. **Published, and on the Front Page.**

State 2 **is not private.** The repository is public, the files are fetchable, and `?p=<directory>`
opens the Project for anyone who knows or guesses the name. It means *absent from the Front Page* and
nothing else.

This is why the per-Project state is called **"on the Front Page" / "not on the Front Page"** and is
never called published, unpublished, private, draft, or hidden. "Unpublished" needs a warning sentence
bolted on to stop it being read as "unseen"; "not on the front page" needs none. A scholar with an
embargoed archival photograph, a manuscript under a library's publication restriction, or a student's
unmarked coursework will act on the reading the word invites, and the invited reading has to be the
true one.

Absent means **on the Front Page**, which preserves today's behaviour — every Project appears on a
Published Site. And the flag goes into `project.json` **without bumping `CURRENT_FORMAT_VERSION`**.
[ADR-0010](./0010-integer-format-version-with-forward-only-migrations.md) refuses a `formatVersion`
higher than the build understands, and names this epic's exact situation as the reason it exists:
*"the project explicitly invites people to fork and host their own instance, which guarantees old app
versions stay alive in the wild."* A shared repository is a far busier version of that. An older build
drops the flag into `unknownFields` and writes it back untouched, so a fork that has never heard of the
flag cannot silently take a colleague's Project off their own front page.

## What is retired, and what is not

**The local static site stops being a product.** Nothing advertises it, and a user with no GitHub
account is not offered one.

**No files are deleted for this.** The viewer build, `viewer-bundle-source.ts`, `isViewerFile`,
`publishedSiteStaleness`, `readPublishedSite`, and `scripts/check-nojekyll.mjs` are all load-bearing
for Publish, and a folder Workspace still ends up with a working local site as a side effect of one.
This is stated because "we are removing the static-site download" reads, to an implementer who was not
here, as licence to delete `apps/editor/src/lib/publish/`.

**Nothing about transfer changes.** [ADR-0024](./0024-backup-and-handoff-are-different-artefacts.md)'s
two artefacts stand and already exclude the viewer files by default: a **Backup** is a tar of the whole
Workspace, for yourself, and it remains the only private one; a **Project Bundle** is a tar of one
Project, exported to be sent to somebody, opening only into a Review Workspace.

## Consequences

- **Import is the two existing artefacts over a new transport, and needs no authentication.** Reading
  a public repository requires no credential at all, so a student can seed a Workspace from an
  instructor's Remote without a GitHub account. **Clone a Workspace from a Remote** creates a new named
  Workspace bound to it — `restore-workspace-tar`'s semantics, which never overwrite and never merge.
  **Review a Project from a Remote** creates a Review Workspace — `openBundle`'s semantics.
- **Importing one Project into your own Workspace is refused**, for ADR-0024's reason unchanged: an
  Alignment is Workspace-shared, one per Map Image (ADR-0023), so it would either overwrite an
  Alignment two of your own Projects depend on, or be refused. A new transport does not make the
  collision go away.
- **A Review Workspace can never be bound to a Remote, and no credential is read or written while one
  is open.** Publishing somebody else's Project to your own address is promotion by another route, and
  a worse one. This is a hard refusal with a test, not an absent menu item.
- **A Clone is bound to the Remote it came from; a restored Backup and an opened Project Bundle are
  not.** With a Clone you named that repository deliberately, so the binding is what you asked for and
  is useful provenance even without push rights. With a restore you did not, and an inherited binding
  would leave a Publish button pointing at a live, cited address.
- **The editor stamps its own address into `ballastella-site.json` at Publish time**, so a Published
  Site records which instance made it and its Front Page can carry a link back — `?clone=owner/repo`
  at the Workspace level, `?review=owner/repo&p=<dir>` on a Project. Nothing to configure; the editor
  knows its own origin.
- **"Hub" was overloaded and is now retired for the reader-facing page.** `ProjectHub.svelte` is the
  *editor's* Project list; ADR-0008's "hub page" is the *published* root. The second is the **Front
  Page**.
- **`export` belongs to a Project Bundle and a Backup.** Publishing is never an export, and
  `CONTEXT.md`'s **Published Site** entry says so, because "Export" is a shipped button.

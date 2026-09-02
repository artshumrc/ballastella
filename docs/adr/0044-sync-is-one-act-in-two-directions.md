# Sync is one act in two directions, and it opens on the facts

A Workspace and its Remote hold the same work in two places, and the scholar's question about them is
always the same one: *are these the same?* **Sync** is the single word and the single control that
answers it, in whichever direction the answer requires.

Two separate outbound and inbound gestures were tried and are refused. They read as symmetrically
dangerous when they are not, they make the author choose a direction before they have been told which
direction has anything in it, and they have no honest answer for the most ordinary case there is: a
scholar who worked on a desktop yesterday, opens a laptop today, and has both something to get and
something to send. Asking them to know which to press first is asking them to do the comparison the
tool exists to do.

## The press opens a modal; it never moves a byte

**Sync never acts on the press.** It reads both sides and opens on what it found: two columns, **To
get** and **To send**, naming changed Projects and Map Images with counts, and under each a headed
**Removals** line naming exactly what would disappear from that side. Raw paths are not shown — they
mean nothing to a scholar and run to thousands for one pyramid.

There is deliberately no separate confirmation anywhere else, and in particular no second modal for
inbound deletions. A deletion discovered *after* a press is the failure this shape exists to prevent,
so every deletion either side would suffer is on the screen the author is already reading.

Four choices sit below:

| | What it does |
| --- | --- |
| **Get changes** | The Remote's side of the Baseline comes in. Nothing leaves. |
| **Send changes** | The Workspace's side goes out. Nothing comes in. |
| **Get and send** | Both. |
| **Overwrite the repository** | Inside the owned namespace, the Remote becomes exactly the Workspace. |

**Send removes from the Remote only what the Synchronization Baseline recorded and the Workspace no
longer has.** A path that appeared on the Remote since the Baseline is work this Workspace has never
seen, and a scholar who has not looked at something cannot have decided to delete it. It survives, and
arrives on the next get. The corollary is the property that makes a first connection safe: **with no
Baseline, a Sync removes nothing at all**, in either direction.

**Overwrite is the exception**, and the only control here whose blast radius is somebody else's
afternoon. It is set apart in the modal, it names the files it would remove before it will proceed,
and where the Remote is not solely the author's — its owner is not the signed-in account, or GitHub
reports other contributors — that naming is a confirmation the author must answer
([ADR-0033](./0033-a-sync-mirrors-an-owned-namespace.md) is what bounds the damage to Ballastella's
own files). It says, accurately, that what it replaces stays in the repository's history; it does not
present that as a remedy, because recovering a colleague's work from a dangling commit through the
GitHub web interface is not something to route people to lightly.

Where one file changed on both sides, [ADR-0046](./0046-a-conflict-becomes-a-copy-except-an-alignment.md)
governs, and the Sync proceeds around it.

## One repository, reached one way

A Workspace has one **Remote**, and the relationship is installation-local: it is never learned from
repository content, so opening a copied or forked repository cannot silently bind a Workspace to the
repository it was copied from. A restored Backup arrives unbound. A Review Workspace can never be
bound at all, and no credential is read or written while one is open — putting somebody else's Project
at your own address is promotion by another route, and a worse one. That is a hard refusal with a
test, not an absent menu item.

**There is no separate way to open a Workspace from a repository, because Sync is that way.** Make a
Workspace, connect it, get. A second entry point would be the same three requests behind a different
noun, and it would still have to explain itself to an author whose local Workspace already had
content.

This makes the first connection to a populated repository ordinary rather than exceptional. Connecting
is not refused because the Remote holds Projects the Workspace has not got: that is simply a large
**To get** column. The refusal such a rule would express — *your first send will delete work* — is not
true under the send rule above.

**Getting needs no credential; sending does.** A public repository is readable by anyone, so
connecting to one by address and getting from it works signed out, and the story most worth protecting
survives: a student seeding a Workspace from their instructor's repository, with no GitHub account at
all. Sign-in is required to send, and to touch a private repository at all.

**The address is resolved by asking GitHub, not by parsing.** A Pages address, a GitHub address and
`owner/repository` are all accepted and resolved to a candidate list, because `ada.github.io/atlas` is
`ada/atlas` or a folder inside `ada/ada.github.io` and no parser can tell which. The identified
repository is confirmed before a download that may run to gigabytes. A custom domain is refused with
the reason, since nothing can say which repository serves it.

**A Remote may be private.** Nothing about sending changes — it is already an authenticated Git Data
API call with `Contents: write` — and the two halves that assume public are narrowed rather than
rebuilt: the door requires sign-in before it will open a private repository, and an anonymous status
check against one is reported as **Cannot tell** rather than as agreement. Share Links remain offered
on a private repository; GitHub's own plan requirement is a refusal like any other and is handled where
refusals are handled ([ADR-0045](./0045-a-repository-holds-the-work-and-a-site-is-asked-for.md)).

**A shared Remote needs nothing built to allow it.** GitHub documents that an App acting for a user
reaches the intersection of what the App may touch and what the user may touch, so a write
collaborator signs in, the repository is simply in their list, and they sync with `Contents: write` and
no admin. Bringing a repository into an installation is an admin-only act; *using* one is not. So the
onboarding difficulty [ADR-0040](./0040-one-installation-chosen-wide-and-no-repository-administration.md)
is about is confined to the first person to bring a given repository in. A repository missing from an
author's listing branches on whether they are its admin: an admin is offered the preselect deep link,
and a non-admin is told to ask the repository's admin rather than being sent to a screen where they
can accomplish nothing. The per-repository `permissions` the listing returns decides whether a send
affordance is offered at all, so a read-only collaborator never presses a button that will refuse them.

**The limit on collaboration is stated rather than met as a Conflict.** Collaborators work comfortably
on different Projects in one Workspace and cannot both align the same Map Image; the second one meets
the Alignment case of ADR-0046. That is the boundary of what collaboration means here, and it belongs
in what the interface says up front, not in a refusal discovered at the end of an afternoon.

## One badge, two clauses, and the repository named only when it is earned

Conflating local save state with Remote state is how a scholar comes to believe a saved edit is one
that reached GitHub, so the badge always says both, in one control rather than two side by side.

| | |
| --- | --- |
| No Remote | *(no badge; the bar offers **Sync with GitHub**)* |
| Everything replicated | Saved here · in sync with `owner/repo` |
| Only local changes | Saved here · changes to send |
| Only remote changes | Saved here · changes to get |
| Both directions | Saved here · changes both ways |
| No trustworthy Baseline | Saved here · can't tell what's on GitHub |
| Not checked this session | Saved here · not checked yet |

**The repository is named only in the first row.** A name beside a state that is not agreement reports
an intention rather than a fact, and the fact is the only thing worth a badge. Git's ahead/behind
vocabulary is not used, and neither is *connected*: being connected is not an achievement and does not
tell a scholar whether their work is anywhere but this machine.

The determination's own name, the file counts per direction, the timestamp and the Baseline's commit
sit behind the disclosure the badge already carries. Ballastella checks automatically only while the
author is authenticated, with bounded frequency; a signed-out author may check a public Remote
explicitly.

## Where the gestures live

**Once connected, the bar's control is Sync and opens the modal directly.** There is nothing between
the press and the facts — no landing screen, no panel of six controls about one question. A scholar
syncs constantly and changes repositories approximately never, so the bar carries the first and the
Workspace's own settings carry the rest: which repository this Workspace syncs with, changing it,
disconnecting, and Share Links.

The guided sequence survives only for a Workspace that has no Remote yet: sign in, choose or create a
repository or type an address, connect. Its landing step is gone with the panel it hosted.

**A credential may be kept past the tab, and only if the author asks.** `sessionStorage` is the
default, so the beneficiary of that rule — a scholar on a shared or lab machine, whose credential must
not outlive their tab — keeps it untouched. What may persist is the refresh token and its expiry,
never the eight-hour access token, and it lives outside every Workspace directory, for the reason
ADR-0033's last consequence gives.

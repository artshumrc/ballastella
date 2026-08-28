# One installation, chosen wide, and no repository administration

A GitHub App is two things wearing one name, and until now this repository documented only the first.
It is an **identity** — the client ID and the registered callback URL that decide which static site may
ask GitHub for a token, which is what [`github-app.ts`](../../packages/core/src/remote/github-app.ts)
describes — and it is an **installation**, a grant held on the author's own account carrying the list of
repositories the App may touch. Nothing in the editor named the second one, so an author who installed
with *Only select repositories* and then made a repository met a wall the interface had never mentioned:
`readGrantedRepositories` cannot see the new repository, and the sequence told them to go and add it to
a list they did not know they had chosen. The installation is therefore a thing the sequence **teaches**
rather than a mechanism it hides, and the first install steers to *All repositories* — GitHub's own
install screen promises that covers "all current *and* future repositories owned by the resource
owner", which is the whole of the trap removed at its source. Because that promise is in GitHub's
product UI rather than in their documented contract, `repository_selection` is read back at runtime and
the narrower path is still built.

**The App does not request `Administration: write`, and so Ballastella creates no repository and turns
no Pages site on by itself.** Both would be possible: `POST /user/repos` and
`POST /repos/{owner}/{repo}/pages` are documented for GitHub App user access tokens, the latter needing
`Pages: write` *and* `Administration: write` together — which is also why the Pages instruction in
`bind-remote.ts` had been naming the wrong permission. The reason not to is that GitHub excludes exactly
this permission from what a repository admin may self-install: "Repository admins can install GitHub
Apps in the organization that owns the repository **if the app does not request any organization
permissions nor the 'repository administration' permission**." Asking for it would take a scholar who
has admin on a departmental repository but does not own the organisation and leave them emailing an
organisation owner, with no callback and no in-app status — and it would put "can delete your
repositories" in front of every student on the consent screen. Onboarding smoothness for the
personal-account majority is bought instead by *All repositories*, which costs one radio button, and the
one press at `github.com/new` that remains was never the painful step. The choice is registration-wide:
there is no optional, per-installation or incremental permission for a repository permission, so this
cannot be had for some authors and not others. It is, however, reversible — a permission added later
takes effect per installation on approval and breaks nothing in the meantime.

**Pages leaves onboarding with it.** A Remote is a backup and a way between devices before it is a
Published Site, and enabling Pages while an author is still working out where their files are meant to
go produced a paragraph about a permission in answer to a question nobody had asked. Turning a site on
is offered afterwards, once, as its own act.

**Sign-in becomes install-first.** The sequence sends a new author to the App's own install URL with
authorization-during-install, so one screen on GitHub both installs the App and issues the code — rather
than to the bare authorize endpoint, which grants a token against no installation and lands a
blameless first-time author on "you have given Ballastella access to no repository yet". That setting
takes the Setup URL away, and nothing here needs it: with *All repositories* there is no later grant
step to be redirected home from. Where an installation is `selected`, the hand-off is the App's own
install screen with the repository preselected, never the list of every App the author has ever
installed. The App's slug is a third deployment value beside the broker origin and the client ID, and
`isGitHubAppConfigured` demands all three.

# 18 - Import or Review Published Projects

## What to build

Turn a Published Project's single **Open in Ballastella** link into a safe editor offer with two
deliberate outcomes: **Import into “Workspace name”** or **Open a review copy**. Public Import and
Review require no authentication, the offer transfers nothing until chosen, and neither path imports
published Remote-binding metadata.

Keep Workspace-level Published Site navigation separate: it offers **Open a Workspace from GitHub**.
Preserve compatibility with already-published sites and the shipped invitation query parameters.

## Where to start

- Ticket 03's Published GitHub Project source adapter and tickets 04 through 08's shared Import engine.
- Ticket 13's current-Workspace Import orchestration and ticket 17's bound-Workspace guards.
- `packages/core/src/remote/return-link.ts`: `ReturnLink`, `returnLinkUrl`, `readReturnLink`, and
  `withoutReturnLink`. The `clone` and `review` parameter spellings are compatibility contracts.
- `apps/viewer/src/routes/+page.svelte`: `cloneLink`, `reviewLink`, the current legacy
  `remote.json` read, and the return-link slot assignment.
- `apps/viewer/src/lib/SiteBar.svelte`: one rendered return link in wide and narrow navigation states.
- `apps/editor/src/routes/+page.svelte`: the one query-parameter parser/cleanup effect and the offer
  lifecycle.
- `apps/editor/src/lib/components/ReturnLinkOffer.svelte`: currently one accept operation; extend the
  Project invitation to two explicit choices without creating a second offer component.
- `packages/core/src/publish/publish.ts`: `ballastella-site.json` generation. New publishes record the
  repository address needed for return links as Published Site metadata, not as local binding state.
- `e2e/viewer-reader.e2e.ts` and `e2e/editor-review-remote.e2e.ts`: extend these existing Published
  Site and invitation workflows.

## Contract

Keep these URL shapes unchanged:

```text
?clone=owner/repository
?review=owner/repository&p=project-directory
```

Their user-facing meanings are now:

- `clone`: offer **Open a Workspace from GitHub** for the whole repository.
- `review` plus `p`: offer either detached Import of that Published Project into the named current
  ordinary Workspace or opening it in an isolated Review Workspace.

Do not add `?import=`, rename parameters, or fork builder/parser/cleanup logic. The existing parser
continues validating repository coordinates, and the invitation parameters are removed from the
address through `withoutReturnLink` as soon as the offer is raised. Preserve unrelated query
parameters exactly.

A Published Project page renders one navbar link labelled **Open in Ballastella**, not separate Import
and Review links. Following it renders an in-document offer before any tree, manifest, or file request.
The offer names the current ordinary Workspace for Import, offers Review separately, and has a decline
action. Declining removes the offer, restores the editor's ordinary landing state, and transfers or
changes nothing.

Both Project choices read a public repository anonymously and must not prompt for, read, or send a
credential. Import uses the shared GitHub source and transaction; Review uses the existing isolated
Review destination. An opened Published Site's `remote.json`, repository metadata, or Project content
never establishes the destination Workspace's local Remote relationship.

Publish writes repository coordinates and editor address needed by new return links into generated
Published Site metadata. The viewer reads that new metadata first and uses legacy root repository
metadata only as compatibility evidence for older sites. A copied or forked site can build an
invitation to its recorded publication source, but opening or importing it cannot bind a local
Workspace. Whole-Workspace Open uses the repository the reader selected under its own dependency
contract.

The existing GitHub source refusals remain: malformed or unsupported content, truncated trees,
missing closure paths, and byte/SHA disagreement all refuse before installation.

## User Stories

- **4.** As an author, I want to choose a published GitHub Project as an Import source, so that I can keep public scholarly work without downloading and re-uploading it manually.
- **5.** As a reader, I want to import a public GitHub Project without authenticating, so that receiving public work does not require a GitHub account.
- **6.** As an unauthenticated author, I want Import and Review to avoid prompting for GitHub credentials, so that identity is requested only for an operation that needs it.
- **72.** As a reader, I want one Open in Ballastella link on a Published Project, so that the navbar does not present competing editor links.
- **73.** As a reader, I want following Open in Ballastella to show an offer before downloading, so that a URL cannot rearrange my editor automatically.
- **74.** As a reader, I want the offer to provide Import into my named current Workspace, so that I can keep the Project deliberately.
- **75.** As a reader, I want the offer to provide Open in a review copy, so that I can inspect the Project without adding it.
- **76.** As a reader, I want declining the offer to download nothing and change nothing, so that following a link remains safe.
- **77.** As a reader, I want a Workspace-level Published Site link to offer Open a Workspace from GitHub, so that whole-Workspace synchronization is distinct from Project Import.
- **78.** As a reader of an older Published Site, I want its existing editor return links still understood, so that already-published work does not lose its route back to Ballastella.
- **79.** As a publisher, I want Publish to generate the repository address required by new return links, so that copied repository content cannot choose my local Remote.
- **80.** As an author, I want opening published content never to import its embedded Remote binding, so that a copied or forked repository cannot silently rebind my Workspace.
- **165.** As a reader, I want the shipped `clone` and `review` invitation URLs retained with their new Open and Import-or-Review meanings, so that one URL builder and parser serve old and new Published Sites.

## Out of scope

- Do not add private unpublished repository Project Import.
- Do not redesign OAuth, the credential broker, or GitHub transport.
- Do not add a second Published Project navbar link or a parallel Import URL vocabulary.
- Do not bind a Workspace from Published Site metadata, `remote.json`, provenance, or Project content.
- Do not implement Review-current-state Import; ticket 19 owns the Review banner route.
- Do not change own-Remote policy; call ticket 17's guard.
- Do not broaden Import to arbitrary repositories that are not recognizable Published Sites.

## Acceptance criteria

- [ ] A newly published Project page has exactly one **Open in Ballastella** navbar destination, and
      the Front Page has the distinct Workspace-level Open invitation.
- [ ] The unchanged Project invitation parameter raises an offer naming the current Workspace with
      separate Import, Review, and decline controls before any GitHub content request.
- [ ] Decline cleans up only the invitation parameters, transfers no bytes, changes no Workspace, and
      leaves no offer on reload.
- [ ] Anonymous Import commits a complete detached Project into the current Workspace; anonymous Review
      opens the same source in an isolated Review Workspace; neither reads or sends a credential.
- [ ] New Published Site metadata carries repository evidence, while an older fixture using the legacy
      metadata still builds a working invitation.
- [ ] Import, Review, and whole-Workspace Open never adopt embedded binding metadata from published
      content.
- [ ] Builder, parser, and cleanup tests assert the exact `clone` and `review` parameter shapes and
      preservation of unrelated parameters.
- [ ] Browser coverage remains in `viewer-reader` and `editor-review-remote`; any Seam 2 ceiling rise
      has the mandated dated explanation.

```bash
pnpm --filter @ballastella/core test -- return-link
pnpm --filter @ballastella/core test -- project-import-source
node scripts/check-seam-2-size.mjs
pnpm test:e2e viewer-reader
pnpm test:e2e editor-review-remote
pnpm precommit
```

Success: all six commands pass; request logs prove the offer and decline transfer nothing, both
anonymous choices work through the unchanged invitation parser, and new plus legacy Published Site
fixtures produce the correct single links without binding local state.

## Blocked by

- 02
- 03
- 04
- 05
- 06
- 07
- 08
- 11
- 13
- 17

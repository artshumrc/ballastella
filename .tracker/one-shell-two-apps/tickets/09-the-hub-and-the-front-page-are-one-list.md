# The Hub and the Front Page are one list

## Parent

[SPEC.md](../SPEC.md)

## What to build

The editor's Hub and the viewer's Front Page render the same list of Projects, from one component.
They already use the same daisyUI card markup, written twice. Make it once, and let each app supply
the controls that belong to it: New Project, the per-Project menu and Publish on the Hub; the return
link and the site's own sentence on the Front Page.

This is independent of the rest of the epic and can be picked up as soon as the shared package
exists.

## Where to start

- `apps/editor/src/lib/components/ProjectHub.svelte` — the editor's list. Its cards are
  `card bg-base-100 card-border` with a `card-body flex-row flex-wrap items-center justify-between`.
- `apps/viewer/src/routes/+page.svelte` — the Front Page branch, `{#each frontPage as project}`. Its
  cards are the same classes. Read the comments around the project name: it is interpolated as text
  and never as markup, because a display name is untrusted content and this site runs on the author's
  own domain (ADR-0009).
- `apps/editor/src/lib/components/project-hub.dom.test.ts` and `ProjectHubHarness.svelte` — the Seam
  3 home; these move with the component.
- `e2e/editor-workspace.e2e.ts`, `e2e/viewer.e2e.ts`, `e2e/editor-publish.e2e.ts` — the assertions.

## Contract

**The shared component owns the card and the list.** Each entry carries a name, its folder, and a
line of facts about it. Everything else is a snippet the consumer supplies:

- the Hub adds last-saved, offline availability, Open, and the per-Project menu;
- the Front Page adds nothing per card and links the name to `?p=<directory>`.

**A Project's display name is interpolated as text in both apps.** Never `{@html}`, never a computed
`href` built from it without encoding. Both `editor-publish.e2e.ts` and `viewer.e2e.ts` already
assert both halves — that the real name is on the page and that no element arrived with it — and both
must keep passing.

**The two empty states are different sentences and must stay different** (ADR-0032). "This site has
no Projects on it yet" is true of a site nothing has been published to. "None of this site's Projects
are on the front page — they are still published, and anyone with a link can open one" is true of an
author who made a choice. Reading them as one would send that author looking for work that is exactly
where they left it.

**The Front Page's own paragraph about itself stays ordinary markup**, not a pseudo-Annotation put
through the shared renderer. There is no `{@html}` in the viewer and this ticket must not add one.

**Nothing about publishing, Project creation, deletion or export changes.**

### User Stories

8, 52, 53, 54, 55, 56

## Out of scope

- **Do not touch the Workspace switcher, Workspace settings, or the transfer flows.**
- **Do not change the Hub's Historical Maps section** or anything below the Project list.
- **Do not change what publishing writes.**
- **Do not add a Project detail pane.** That was Ledger's idea and Ledger was not chosen.
- **Do not reorder or re-sort the Projects.**

## Acceptance criteria

- [ ] One Project card component in `packages/ui`; both apps render it and neither holds a copy.
- [ ] The Hub shows New Project, Publish, the per-Project menu and each Project's last-saved line.
- [ ] The Front Page shows none of those and shows the return link and the site's own paragraph.
- [ ] A Project display name carrying markup renders as text in both apps, with no element created.
- [ ] A site with no Projects and a site with none on the Front Page say two different things.
- [ ] `project-hub.dom.test.ts` runs from `packages/ui` and passes.
- [ ] A component test asserts the Hub-only controls are present with the Hub's props and absent with
      the Front Page's, in the same file.
- [ ] There is no `{@html}` anywhere in the viewer's source.

```bash
pnpm lint
pnpm check
pnpm test
pnpm --filter @ballastella/ui test

pnpm test:e2e editor-workspace
pnpm test:e2e editor-publish
pnpm test:e2e viewer

grep -rc "@html" apps/viewer/src --include=*.svelte
```

Success: everything exits 0 and the grep reports no `{@html}` in the viewer.

**Mutation check:** pass the Hub's control snippets to the Front Page and show the absence assertion
goes red; interpolate a name as markup and show the XSS assertion goes red.

## Blocked by

- 02 — a shared UI package, proved by the Base Map switcher

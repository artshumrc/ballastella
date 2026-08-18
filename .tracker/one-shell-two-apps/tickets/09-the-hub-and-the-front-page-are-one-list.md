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
- **Do not change the Hub's Map Images section** or anything below the Project list.
- **Do not change what publishing writes.**
- **Do not add a Project detail pane.** That was Ledger's idea and Ledger was not chosen.
- **Do not reorder or re-sort the Projects.**

## Acceptance criteria

- [x] One Project card component in `packages/ui`; both apps render it and neither holds a copy.
- [x] The Hub shows New Project, Publish, the per-Project menu and each Project's last-saved line.
- [x] The Front Page shows none of those and shows the return link and the site's own paragraph.
- [x] A Project display name carrying markup renders as text in both apps, with no element created.
- [x] A site with no Projects and a site with none on the Front Page say two different things.
- [ ] `project-hub.dom.test.ts` runs from `packages/ui` and passes. — **not as written; see the note.**
- [x] A component test asserts the Hub-only controls are present with the Hub's props and absent with
      the Front Page's, in the same file.
- [x] There is no `{@html}` anywhere in the viewer's source.

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

## Done

`packages/ui/src/ProjectCardList.svelte` is the one list, rendered by
`apps/editor/src/lib/components/ProjectHub.svelte` and by `apps/viewer/src/routes/+page.svelte`, and
neither app holds a card of its own any more. The Hub passes three snippets — its last-saved line,
its Front Page choice with the ADR-0032 caution, and its Rename / Duplicate / Export / Delete row —
and the Front Page passes none of them and links the name to `?p=<directory>`. There is no
`readOnly`, `mode` or `editable` prop; the card lays itself out as one column rather than two when
no `actions` snippet arrives, so a Reader's card is not the Hub's with a gap where the buttons were.
The `href` is composed and encoded by each app from the **folder**, never from the display name, and
the name is interpolated as text by the shared card.

The Front Page's own paragraph regained the reassurance that was deleted with the return-link
paragraph in ticket 03 — "You do not need an account, and nothing published here is changed" — as
ordinary markup, on `data-testid="no-account-needed"`. **It is gated on `cloneLink`, the same
expression the bar's return link is built from**, because the sentence describes what "Opening this
Workspace in Ballastella" costs and that control is offered only when the site records both an
instance and a repository. A site published into a folder, and every site published before this
epic, has neither — so the sentence is not said there. The claim is a pair across two existing specs
in `e2e/viewer-reader.e2e.ts`: present in `leads back to the editor that published it`, absent in
`serves the hub and one Project over plain HTTP`, whose fixture has no return link.

**Both of ADR-0032's empty states are now asserted**, in the one spec that reads them:
`says which of the two empty Front Pages a Reader is looking at` serves a site whose Projects are all
off the Front Page and then a site with no Projects at all, and asserts each says its own sentence
and not the other's. "This site has no Projects on it yet" carries `data-testid="no-projects-yet"`
for it.

**The Front Page's card is swept, not only its snippets.** The absent half of
`packages/ui/src/project-card-list.dom.test.ts`'s paired test named three testids that exist nowhere
but that file, so a control or a line of editor prose written into `ProjectCardList.svelte` itself
would have satisfied all three. It now asserts the name link is the card's only interactive element
and that the card's words are the name and the folder and nothing more.

**Mutation checks, all red as required.** Handing the Front Page's mount the Hub's three snippets
turned the paired test red (`expected document not to contain element, found <span …>`);
`{@html project.name}` in the card turned the Seam 3 XSS test red
(`expected 'Amsterdam 1625alert(1)' to be 'Amsterdam <img src=x onerror=…'`) **and**
`viewer-reader.e2e.ts`'s `never markup` test red against a real built site.

Ungating the reassurance turned the absence half red (`no-account-needed`, expected 0 received 1) and
deleting it turned the presence half red; collapsing the two empty states turned the pair red in both
directions; a `<button>Open</button>` in the shared card turned the sweep red (`expected […] to have
a length of 1 but got 2`) and a hint line turned the prose assertion red
(`'Amsterdam 1625 folder amsterdam-1625 Rename this Project from the Hub.'`). Every one was reverted.

**Seam 2 is unchanged at 630 of 630.** No browser test was added; the one new browser claim is an
assertion folded into an existing spec.

**The viewer's bundle** (`du -sb apps/viewer/build`): 2 838 124 bytes before, 2 841 843 after — 3 719
bytes, which is the shared card plus the restored paragraph.

### Three things a reader of this ticket should know

**`apps/editor/src/lib/components/project-hub.dom.test.ts` did not move**, and the box above is left
unticked rather than claimed. Everything in it is about the Hub's Map Images section and the
wording of the Front Page choice — both explicitly out of scope here — and it mounts `ProjectHub`
through an `EditorSession`, `$app/paths` and `$lib`, none of which `packages/ui` may import
(`scripts/check-ui-package-imports.mjs`). What moved is the *card*, so the seam that moved with it is
the card's: `packages/ui/src/project-card-list.dom.test.ts`. The editor's file still runs and passes,
now against a Hub that renders the shared list.

**"the per-Project menu" is the Hub's per-Project control row**, which is four buttons and not a
popover. The Contract's "offline availability, Open, and the per-Project menu" describes a card the
Hub does not have today: the name *is* the Open link, nothing on the Hub says whether a Project is
available offline, and the actions have never been in a menu. Turning four buttons into a popover
would change deletion and export, which this ticket's Contract forbids, so the controls were moved
into the snippet exactly as they were.

**`grep -rc "@html" apps/viewer/src --include=*.svelte` reports 3 for `+page.svelte`, unchanged from
before this ticket, and every one of them is prose in a comment** explaining why the directive is not
there. There is no `{@html}` directive anywhere in the viewer, and this ticket added none.

# 05 — Workspace Home becomes two columns, drawing one card in both apps

## What to build

The editor's Workspace Home becomes two columns on a wide screen — Projects left, Map Images right,
divided by a single vertical rule — with each list ruled rows under a heading carrying its own count.
The viewer's Workspace Home renders the Projects column alone, **at the same measure**, so a Project
row is identical between the apps.

`ProjectCardList` grows a leading media slot and the hand-rolled Map Image list is retired onto it, so
one component draws both lists and a change to a row cannot land in one and miss the other.

## Where to start

- `apps/editor/src/lib/components/ProjectHub.svelte` — 901 lines. The Projects section is 457–589 and
  the Map Images section 591–667. **591–667 is the hand-rolled copy**: `li.card.bg-base-100.card-border`
  with `card-body flex-row flex-wrap items-center justify-between gap-4`, a `MapThumbnail`, a
  `div.grow` with an `h3`, a size/tile-location/folder line, `used-by`, and a Delete button — the same
  card `ProjectCardList` already renders, written again.
- `packages/ui/src/ProjectCardList.svelte` — 84 lines, generic over
  `Project extends { name, directory, href }`, with `facts`, `details` and `actions` snippets and a
  `heading` prop. Its card-body class already switches on whether `actions` was passed. This is what
  grows a `media` snippet.
- `packages/ui/src/project-card-list.dom.test.ts` — the component's contract, and where the new slot
  is proved.
- `apps/editor/src/routes/+page.svelte:266-284` — the hub branch: `<main class="mx-auto max-w-4xl p-8">`
  with an `h1` and `WorkspaceRecovery` above `ProjectHub`.
- `apps/viewer/src/routes/+page.svelte:1259-1338` — the Front Page branch:
  `<div class="mx-auto w-full max-w-6xl p-4 sm:p-8">`, intro prose, and `ProjectCardList` with
  `testid="published-projects"` and no `facts`/`details`/`actions`. **Note the measures differ today**
  — `max-w-4xl` against `max-w-6xl` — and story 35 requires the Projects column to match.
- `apps/editor/src/lib/components/project-hub.dom.test.ts` and `ProjectHubHarness.svelte` — the Seam
  1c harness. Most of this ticket's assertions belong here, not in Playwright.
- `e2e/viewer-reader.e2e.ts:840-1200` — the front-page list assertions, including `no-projects-yet`,
  `none-on-front-page` and `no-account-needed`; `:947` and `:3474` assert the `<h1>` "Front Page".
- `docs/adr/0036-…` — Ruled, and the no-left-border rule.
- `CONTEXT.md` — the **Workspace Home** entry, including the rule that it is never a word a user
  reads.

## Contract

**`ProjectCardList` grows a `media` snippet**, rendered before the heading, and nothing else changes
about it. It stays generic, it stays free of `readOnly`/`mode` flags, and the name is still
interpolated as text and never `{@html}` (ADR-0009). Both lists then pass their own snippets:
Projects pass `facts`/`details`/`actions`, Map Images pass `media` plus their own `facts` and
`actions`.

**One measure for the Projects column across both apps.** Pick it, state it in the component or in a
shared class, and make both apps use it. Two hard-coded `max-w-*` values that happen to agree is not
this; the point of story 35 is that they cannot drift.

**The viewer renders no Map Images column and no vertical rule.** A Reader has no Workspace and a Map
Image is not theirs to manage. Do not invent filler for a right column to satisfy symmetry.

**Every state the Workspace Home has today survives**, in both apps: looking, empty
(`no-projects-yet`, `no-map-images`, `none-on-front-page`), unreachable, a Project whose
`project.json` cannot be read, one made by a newer version, the reserved-name refusal, the review-copy
restrictions, `bundle-notice`, `transferError`, `map-image-refused`, `map-images-total`, and the
transfer live region. Regrouping does not thin the states.

**Delete is the last control in a row and the only one in `error`.** Ruled puts a row's actions in the
row, which is honest and puts Delete near Rename; the ordering and the single error colour are what
keep that safe.

**Two columns above `lg`, stacked below**, matching the breakpoint the Project page already uses.
Below `lg` the Projects list comes first.

**The used-by sentence arrives on the Map Image row.** Ticket 07 removes it from the align sidebar;
this ticket provides its destination. `describeAlignmentUsers` in
`apps/editor/src/lib/alignment/used-by.ts` and its every-branch test stay — only the render site
moves. A Map Image row shows how many Projects draw it; the full sentence, with its
"Refining it here moves all of them" branch, belongs where a scholar reads about that Map Image.

## User Stories

- **30.** As an author on a wide screen, I want my Projects and my Map Images side by side, so that I
  can see what I have and what it is made of at once.
- **31.** As an author, I want each list headed by its own count, so that "four Map Images" is not
  something I have to work out by counting.
- **32.** As an author, I want a Project's row to carry its name, when it was last saved, its folder
  and how many Layers it has, and its actions in the row.
- **33.** As an author, I want *Delete* to be the last thing in the row and the only one in the error
  colour, so that it is never adjacent to *Rename* and never mistakable for it.
- **34.** As an author, I want a Map Image's row to carry its thumbnail, its size, whether its tiles
  are here or referenced, and how many Projects draw it.
- **35.** As either user, I want a Project row to be pixel-identical between the two apps, because the
  Projects column is the same component at the same measure in both.
- **36.** As a Reader, I want the viewer's Workspace Home to show me the Projects on the Front Page and
  nothing about Map Images, because I have no Workspace and a Map Image is not mine to manage.
- **37.** As a maintainer, I want one card component rendering both lists, so that a change to a row
  cannot land in one list and miss the other.
- **38.** As an author, I want the Workspace Home to keep every state it has today: looking, empty,
  unreachable, a Project whose file cannot be read, one made by a newer version, a reserved name, and
  a review copy's restrictions.
- **39.** As a maintainer, I want *Workspace Home* to be the one name for this surface in both apps,
  and to be a word no user ever reads — a Reader meets a *Front Page*, an author meets *Projects*.

## Out of scope

- **The Reader-facing labels.** The viewer's `<h1>` still reads "Front Page" and the editor's
  breadcrumb still reads "Projects". *Workspace Home* is our word, not a user's, and two specs assert
  that `<h1>` by accessible name.
- **A Project thumbnail derived from its Layers.** One rejected layout led each Project row with the
  thumbnail of its bottom Map Image Layer, which would make the Workspace Home read Project files and
  tile pyramids to draw its own list. The `media` slot exists for Map Images; do not feed it from
  Projects.
- **Making a Map Image row a link.** A Map Image is not a destination — the align route refuses to
  open without a Project (`No Project chosen`), so a clickable thumbnail would promise a screen that
  does not exist.
- **A second card component in `packages/ui`.** Generalise the one that is there.
- **Removing `describeAlignmentUsers`.** It moves; it does not die.

## Acceptance criteria

- [x] Above `lg` the editor's Workspace Home renders two columns with a single vertical rule; below
      `lg` they stack with Projects first.
- [x] Both lists are drawn by `ProjectCardList`; no card markup for Map Images remains in
      `ProjectHub.svelte`.
- [x] `ProjectCardList` accepts a `media` snippet, proved by a Seam 1c test in
      `project-card-list.dom.test.ts`.
- [x] Each list's heading carries its count.
- [x] A Project row's action order ends with Delete, and Delete is the only action in `error`.
- [x] The Projects column has the same computed width in both apps at the same viewport, from one
      shared source rather than two matching literals.
- [x] The viewer's Workspace Home renders no Map Images column, and its `<h1>` still reads
      "Front Page".
- [x] Every empty, loading, refused and review-copy state listed in the Contract still renders, with
      its existing testid.
- [x] A Map Image row states how many Projects draw it.
- [x] No row uses a left border for emphasis or selection.
- [x] `pnpm precommit` passes; if `SEAM_2_CEILING` is raised, the table in
      `scripts/check-seam-2-size.mjs` records the count and the reason.

```bash
pnpm --filter @ballastella/ui test
pnpm --filter @ballastella/editor test

pnpm test:e2e viewer-reader
pnpm test:e2e editor-transfer
pnpm test:e2e editor-offline-copy
pnpm test:e2e editor-folder-workspace

# The hand-rolled Map Image card must be gone.
grep -n "card-body flex-row" apps/editor/src/lib/components/ProjectHub.svelte
# expect: no output

pnpm precommit
```

Success is one component drawing both lists, the two apps' Project rows measuring the same, and
`editor-offline-copy` — which counts `map-image` cards at `:325`, `:981` and `:1010` — green.

## Blocked by

- 01

## Answer

### The measure, and why

**42rem, declared once as `--workspace-home-measure` in `packages/ui/src/layout.css`**, with a
`workspace-home-column` utility beside it — an `@utility`, so the rule lands in Tailwind's
`utilities` layer rather than above every layer — that both apps put on their `ProjectCardList`.
Both apps already import that stylesheet, so there is one declaration and no pair of literals to
drift.

Neither of the old numbers could be it. `max-w-4xl` (56rem) was the editor's *whole page* and is now
two columns; `max-w-6xl` (72rem) is the viewer's whole page and is far past a comfortable measure for
a one-line list.

**42rem is measured, and it is the floor.** Measured in Chromium at 1024px with a Project called
"Boston 1775" in folder `boston-1775`: the four controls are 307px wide and the row keeps name,
last-saved, folder and controls on one line at 42rem and at 44rem, and wraps the controls onto a
second line at 41rem and at every width below it. So nothing in the 32–38rem range is available: it
would cost every Project row in both apps its single line.

**And the 1024px squeeze the smaller measure was meant to relieve is not the measure's to relieve.**
At exactly `lg`, `main`'s `max-w-[90rem] p-8` leaves 960px, less the 672px column, the 32px `gap-8`
and the Map Images section's 32px `lg:pl-8` — 224px for a row holding a 96px thumbnail, a `gap-4`, a
name, a facts line and the used-by sentence. Measured, that Map Image row wraps into three lines
(thumbnail, text, Delete) at 1024px at **every** measure from 44rem down to 32rem: the text block's
flex basis is its max-content, which a full sentence puts past any of these widths. Shrinking the
measure only takes height off the wrapped row — 388px at 42rem against 300px at 32rem for the
longest-named map — while breaking the Projects row. So the measure stays 42rem, and how the two
columns divide 1024px is left as a question for human judgement rather than answered with a number
that trades one column's layout for the other's.

The editor's column is pinned to the same custom property through its grid template —
`lg:grid-cols-[minmax(0,var(--workspace-home-measure))_minmax(0,1fr)]` — rather than taking half of
whatever the page happens to be, so the Projects column measures 42rem above `lg` (where it is one of
two), below `lg` (where it is the whole width) and in the viewer, at every viewport wide enough for
it. The editor's `<main>` widened from `max-w-4xl` to `max-w-[90rem]` to hold the second column.

### The used-by sentence, for ticket 07

It renders on the Map Image row, composed in `ProjectHub.svelte`'s `usedBy` from
`describeAlignmentUsers` — which is untouched, as is `used-by.test.ts` — with the hub's own two
sentences kept for the branch that function is deliberately silent about (no Project this build can
read draws the map). The element:

```html
<p class="text-sm opacity-70" data-testid="used-by" data-used-by-count="{n}">
```

- **testid:** `used-by` — the testid the hub row already had, on the `details` snippet of the shared
  row. `alignment-used-by` remains the align sidebar's until ticket 07 deletes it.
- **live region: none, deliberately.** `usedBy` is a field of the same `WorkspaceMapImage` record as
  the bytes and the file count, filled by the one `refreshMapImages` walk, and the list renders
  nothing until that walk has an answer — so the row reaches the screen with the sentence already on
  it, which is exactly what a live region does not announce. A per-row `aria-live` bought nothing on
  insert and, on a Project deletion, queued one polite announcement per affected row. What this
  screen announces about a Map Image is the single `map-image-status` region above the list.
- **count attribute:** `data-used-by-count` is the number of Projects the walk can vouch for
  (`map.usedBy.length`), the same meaning the align sidebar's attribute has, so
  `editor-align-referenced.e2e.ts`'s two `toHaveAttribute('data-used-by-count', …)` assertions can be
  retargeted rather than rewritten.

Ticket 07 also inherits three string edits already made here, in `editor-workspace.e2e.ts`: the hub's
"Used by …" wording is now the shared-Alignment sentence, because rendering both would have printed
the newer-version caveat twice in one row.

### What `ProjectCardList` grew

`media` (the leading slot, per the Contract), and two smaller things the Contract's own out-of-scope
list forces:

- **`href` is optional**, and a row without one renders its name as text. "Making a Map Image row a
  link" is out of scope, and `/align` refuses to open without a Project, so there is nothing for a
  Map Image's name to link to. Same interface as the actions: what the consumer does not hand over,
  the row does not have.
- **`itemTestid`**, put on each `<li>`. `map-image` is the handle fifteen assertions across four
  specs count and filter rows by, and it has to be on the row rather than on something inside it.

The rows themselves are now ruled — `divide-y divide-rule border-y border-rule` — rather than
`card bg-base-100 card-border`, which is Ruled applied to the surface this ticket rebuilt. No spec
asserted those classes.

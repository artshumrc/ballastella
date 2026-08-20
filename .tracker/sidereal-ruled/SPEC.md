# Sidereal, Ruled

## Problem Statement

Both apps are on stock daisyUI. `@plugin 'daisyui';` appears in each app's `routes/layout.css` with
no theme block after it, and there is **no `@font-face` and no font stack anywhere in the
repository** — so a scholar's Published Site, the artefact they show colleagues and cite, is drawn in
the browser's default sans on daisyUI's default violet and pink. The tool is fully functional and
looks like a framework's demo of itself. ADR-0016 has always named the missing piece — "Tracy's
generated theme… ships in the published viewer, not only the authoring app" — and it has never
existed.

Underneath that, four surfaces have arrangement problems that a palette cannot reach.

**The navigation bar is source order.** `NavigationBar.svelte` hands `AppBar` a flat row: the
Workspace label and its switcher, then the Remote and the GitHub credential, then breadcrumbs, a
spacer, Undo, Publish, the save indicator, and the theme toggle. Identity, place and action are
interleaved with nothing distinguishing them, and the row re-lays-out as you move between screens
because half of what is in it depends on the route and half does not.

**The workspace menu is half a switcher and half a settings panel.** Under one button it carries the
roster of Workspaces, New Workspace…, a "Folder on this computer" group of up to three buttons,
Remote repository…, and Workspace settings…. The folder controls are *already duplicated* inside
Workspace settings — `settings-choose-folder`, `settings-reopen-folder`, "Locate Workspace folder
again", and a third "Choose a folder again" inside a warning alert — so the same decision is offered
in two places and neither is the answer to the question the menu is opened to ask.

**The Publish modal is starved.** `ModalDialog` widens to `max-w-3xl` only when passed `wide`, and
`PublishDialog` does not pass it — so eight stacked regions, including a five-way destination branch
and a three-row budget table with `data-budget="files|bytes|requests"`, are crammed into daisyUI's
default 32rem box. Workspace settings, which carries less tabular content, does get `wide`.

**Workspace settings is six unrelated concerns in a flat stack**: storage backing, browser
persistence, orphaned journals, the PWA install offer, backup and restore, and the Workspace list
with deletion. Four of them argue about the same underlying risk — *your work may vanish* — in four
different voices, and one control row is a nested `{#if}/{#if}/{:else if}/{#if}` producing up to
three buttons, two of which say almost the same thing.

**The align sidebar teaches instead of affording.** In one 24rem column it renders a collapsed
explainer, four pairing-prompt branches, a sixty-word "changed elsewhere" paragraph with three
composed outcome sentences, a fold warning, transformation guidance plus a Simple-only note plus an
advanced-types note plus per-type shortfall lines, a distortion group with three long control labels
and its question echoed as prose, three warped-status branches and three used-by branches — roughly
400 words. The screen is meant to be simple by design rather than by instruction, and it is arguing.
Worst of all, the control that destroys a Control Point is `class="btn btn-ghost btn-xs"` reading
`Delete point 3`: ghost, so it reads as text, at `xs`, with no `btn-error`, no glyph, and no
confirmation.

And the **Workspace Home** — the root of both apps — is one centred column, `max-w-4xl` in the editor
and `max-w-6xl` in the viewer, with the editor's Projects and Map Images stacked one above the other.
The Map Image list hand-rolls the same card markup `ProjectCardList` already renders, so there are
two copies of one card about to drift.

## Solution

A **generated daisyUI theme, two self-hosted OFL faces, and a structural position** — recorded with
their alternatives in ADR-0036 — plus the arrangement fixes the palette cannot reach.

The palette is **Sidereal**: night ground, brass fittings, verdigris for interaction, drawn from the
instrument the project is named after rather than from an antique map. Two themes named exactly
`light` and `dark`, because that is what `ThemeSignal` writes to `data-theme`. The type is **Bluu Next
over Instrument Sans**, 119 KB, self-hosted, and **no monospaced face exists** — `<code>` keeps its
meaning through a tinted ground and tabular figures. The structure is **Ruled**: hairline rules and
space rather than borders around boxes, no elevation, square structure and soft controls, with the
hairline defined as a mix against `base-content` because `base-300` is also a ground.

Two rules come with it and are enforced everywhere: **no left border for emphasis or selected
status**, and **no monospace**. Both are in ADR-0036 with their reasoning.

Then, surface by surface:

The **navigation bar becomes two tiers**, and the upper one is re-chartered as the tier that never
changes with the route: app name, Workspace, save state, theme. The lower tier is the document and
its actions — breadcrumbs, Undo, Publish. The Remote and the credential leave the bar entirely for
the workspace menu's header, which is where the three facts about the current Workspace finally
appear together.

The **workspace menu answers one question**: which Workspace am I in, and can I go to another. A
header block states the current Workspace's name, where its bytes live, and where it publishes; under
it a roster of the others, New Workspace…, and one line down to settings. The folder controls and the
Remote binding go to Workspace settings, where duplicates of them already live — and because that
removes the menu's only rescue path for a folder whose permission has lapsed, **an unreachable
Workspace is marked on its own row in the roster**.

**Workspace Home becomes two columns** on a wide screen, Projects left and Map Images right, divided
by a single vertical rule, each list ruled rows under a heading carrying its own count. **Both apps
render the Projects column at the same measure**, so a Project row is identical between them; the
viewer simply has no second column. The Map Image rows become the shared card component with a
leading media slot, retiring the hand-rolled copy.

**Publish becomes a receipt**: the total first at display size, the breakdown as a ruled ledger, the
front-page choices in the middle, and the destination as a strip at the foot immediately above the
button that acts on it. It takes `wide` and spends it on a 40rem column rather than a second one.

**Workspace settings becomes three groups** in one scroll — *Where your work lives*, *Keeping it
safe*, *This browser and your Workspaces* — with the nested folder conditional collapsed to at most
two controls and the third duplicate recovery button becoming its warning's own action. No tabs: the
persistence sentence is the one line in the dialog that can save someone's work.

The **align sidebar puts the points first**: prompt, then the Control Points, then how the image is
stretched, then *Done*. Roughly half the prose goes — the explainer keeps one sentence, the
Simple-only and advanced-types notes move inside it, and the used-by sentence moves to the Map
Image's own row on the Workspace Home, because it is a fact about a Map Image that a scholar needs
*before* they start refining and not while they are clicking. **Every warning stays.** The delete
control becomes a trash glyph in `error` with its per-row name in `sr-only` text.

The **Project page keeps its layout** and takes the theme block and nothing else.

Two repairs found while reading and kept because they outlive the design: the **add-Layer buttons stop
scrolling out of reach**, and the two apps **stop disagreeing about one z-index**.

## User Stories

An author is a scholar using the editor. A Reader meets a Published Site. Where a story says "either
app", the behaviour is the shared component's and is the same in both.

### The theme, in both apps

1. As a Reader, I want the Published Site I am sent to to look like a considered piece of work rather
   than a framework's default, so that I take the scholarship in it seriously.
2. As an author, I want one generated theme to dress both apps, so that what I author in and what my
   colleagues read are recognisably the same tool.
3. As either user, I want the theme to declare exactly the two names the app writes to `data-theme`,
   so that choosing a theme cannot select a theme that does not exist.
4. As either user, I want my operating system's light or dark preference honoured on arrival without
   asking, and the Base Map's flavor to move with it in the same action.
5. As an author working past sunset, I want the interface to follow my desktop into dark *while it is
   open*, so that a change of light does not require reloading a screen I am mid-alignment on.
6. As either user, I want the dark half of the palette to be as finished as the light half, so that
   which one I meet is not a judgement about how much care my session gets.
7. As a maintainer, I want the three base grounds to descend from `base-100`, so that every
   `border-base-300` and every `bg-base-300` well in both apps means what daisyUI's own themes mean by
   it.
8. As a maintainer, I want the palette's grounding, its rejected alternatives and its two marking
   rules recorded in an ADR, so that a later change knows what it is overruling.

### Type, and the absence of monospace

9. As a Reader, I want the site's type served from the site's own origin, so that reading a scholar's
   work does not report me to a font host.
10. As a maintainer, I want both faces to be OFL and entered in `THIRD-PARTY-NOTICES.md`, because
    publishing copies the files into every Published Site and that is redistribution.
11. As a Reader on a slow connection, I want the type to cost 119 KB rather than 364 KB, and I want
    that figure to be a measured one.
12. As either user, I want a display face that heads a section and names the app and never appears on
    a control label.
13. As either user, I want a folder path, a Control Point's coordinates and an image pyramid's
    figures set in the same face as everything else, with figures that line up in columns.
14. As either user, I want a literal string still to *read* as a literal string, from a tinted ground
    rather than from a second family.
15. As a maintainer, I want `code`, `kbd`, `samp` and `pre` reset explicitly, because the browser's
    default monospace otherwise defeats this decision in four places with nothing erroring.

### Ruled, and the two marking rules

16. As either user, I want a surface separated from the surface behind it by a hairline and by space,
    so that the screen reads as drawn rather than as a stack of floating boxes.
17. As either user, I want the controls I touch — toggles, sliders, checkboxes — to be round, and the
    panels they sit on to be square, so that a control reads as an object placed on a panel rather
    than stamped out of it.
18. As a maintainer, I want that distinction to come from daisyUI's three radius tokens with no
    per-component override.
19. As either user, I want a hairline to be equally visible on a card and on the ground behind it, in
    both themes.
20. As either user, I want emphasis and selection marked by a ground tint and the element's own ink,
    never by a coloured left edge.
21. As either user, I want a notice bordered on all four sides with a glyph beside its words, so that
    a warning does not read as a block quote.
22. As a maintainer, I want the difference between a *boundary* rule and an *emphasis* rule written
    down, so that the align rail's edge against the map is not mistaken for a violation.

### The navigation bar

23. As an author, I want the part of the bar that says who I am and where my work is kept to stay
    still as I move between the Workspace Home, a Project and the align screen.
24. As an author, I want the part of the bar that changes — where I am and what I can do here — to be
    visibly the part that changes.
25. As an author, I want my save state beside the app's identity rather than beside the route's
    actions, because whether my work is saved is a fact about my Workspace and not about this screen.
26. As an author, I want every item the bar carries today to still be in it: Workspace, save state,
    theme, breadcrumbs, the Project-name edit action, Undo with its descriptive label, and Publish.
27. As an author, I want Undo to keep naming what it will undo, so that pressing it is never a
    gamble.
28. As a maintainer, I want the two tiers to live inside `AppBar`'s existing `<header>`, so that
    every "exactly one of these in the bar" assertion still counts one.
29. As a Reader, I want the viewer's bar to keep folding into a menu on a narrow screen, unchanged.

### Workspace Home

30. As an author on a wide screen, I want my Projects and my Map Images side by side, so that I can
    see what I have and what it is made of at once.
31. As an author, I want each list headed by its own count, so that "four Map Images" is not something
    I have to work out by counting.
32. As an author, I want a Project's row to carry its name, when it was last saved, its folder and
    how many Layers it has, and its actions in the row.
33. As an author, I want *Delete* to be the last thing in the row and the only one in the error
    colour, so that it is never adjacent to *Rename* and never mistakable for it.
34. As an author, I want a Map Image's row to carry its thumbnail, its size, whether its tiles are
    here or referenced, and how many Projects draw it.
35. As either user, I want a Project row to be pixel-identical between the two apps, because the
    Projects column is the same component at the same measure in both.
36. As a Reader, I want the viewer's Workspace Home to show me the Projects on the Front Page and
    nothing about Map Images, because I have no Workspace and a Map Image is not mine to manage.
37. As a maintainer, I want one card component rendering both lists, so that a change to a row cannot
    land in one list and miss the other.
38. As an author, I want the Workspace Home to keep every state it has today: looking, empty,
    unreachable, a Project whose file cannot be read, one made by a newer version, a reserved name,
    and a review copy's restrictions.
39. As a maintainer, I want *Workspace Home* to be the one name for this surface in both apps, and to
    be a word no user ever reads — a Reader meets a *Front Page*, an author meets *Projects*.

### The workspace menu

40. As an author, I want the menu to answer one question — which Workspace am I in, and can I go to
    another — and to stop offering me storage decisions.
41. As an author, I want the current Workspace's name, where its bytes live and where it publishes
    stated together in one place, because that is the only place they appear together.
42. As an author, I want a review copy marked as one in the roster, and the open Workspace marked as
    open.
43. As an author whose folder permission has lapsed, I want that Workspace marked as unreachable **on
    its row**, so that removing the recovery button from this menu does not remove my way back to my
    work.
44. As an author, I want *New Workspace…* and *Workspace settings…* to be the only actions here, under
    one rule.
45. As an author, I want the folder controls and the Remote binding to be in settings only, so that
    the same decision is not offered to me in two places that could disagree.

### Publish

46. As an author, I want the size of what I am about to publish stated first and largest, because it
    is the fact I opened this dialog to learn.
47. As an author, I want the breakdown to read as a ledger — label left, figure right, ruled between —
    rather than as a cramped list.
48. As an author, I want the destination stated immediately above the button that sends my work there,
    so that *Publish* is never pressed without its target in view.
49. As an author, I want `owner/repository`, my credential and the requests I have left on one line
    that does not wrap.
50. As an author, I want to choose which Projects Readers see first, and to be told plainly that all
    Projects stay published either way.
51. As an author, I want every state this dialog can refuse in to be designed rather than merely
    handled: no Remote bound, not signed in, no push permission, an upload problem, a conflict with
    another machine, and nothing to do.
52. As a first-time author with no Remote bound, I want the dialog to explain what is missing and
    where to fix it, rather than to look broken.
53. As an author whose site was last published from another machine, I want to be told that publishing
    replaces rather than merges, and to have to arm that action deliberately.
54. As an author using a screen reader, I want the outcome, the progress and the standing refusal each
    announced once and in the right way.

### Workspace settings

55. As an author, I want this dialog to be three groups rather than six, so that I can find the one I
    came for.
56. As an author, I want the sentence about whether this browser will keep my work to be visible
    without opening anything, because it is the one line here that can save my work.
57. As an author, I want at most two "choose a folder" controls, not three saying nearly the same
    thing.
58. As an author, I want the recovery action for a storage problem to be part of the warning that
    tells me about it.
59. As an author, I want backup, restore, my other Workspaces and the install offer all still here,
    with every state they have today including a review copy's refusal to back up.
60. As an author, I want deleting a Workspace still to name what it holds and still to ask.
61. As a maintainer, I want the dialog's accessible name to stay "Workspace settings", because every
    spec that touches it arrives through that name.

### The align sidebar

62. As an author placing my first Control Point, I want one sentence telling me what to do, with the
    rest of the explanation available and closed.
63. As an author, I want the Control Points I have placed to be the first thing in the column, because
    they are what I am doing.
64. As an author, I want a row's ordinal, its dot's colour and the mark on both map panes to identify
    the same point from the same rule.
65. As an author, I want the control that destroys a Control Point to look like a button and look
    destructive, and to name which point it destroys to a screen reader.
66. As an author, I want every warning I have today: the fold warning, the shortfall lines, the
    "changed elsewhere" alert and its outcomes, the refusal to undo, and the warped status.
67. As an author, I want the transformation guidance and the notes about Simple and about advanced
    types available where I would look for them rather than always on screen.
68. As an author, I want the fact that one Alignment is shared by every Project drawing this Map Image
    told to me on the Map Image, before I start refining, rather than beside the controls while I
    click.
69. As an author, I want *Done* to stay exactly as it is: one large control, at the bottom, always
    reachable.
70. As an author, I want the column to keep its live regions announcing pairing, warped status, the
    opening view and outcomes, unchanged in what they say and when.

### The Project page

71. As an author, I want the Project page's layout untouched, and to see only what the tokens do to
    it.
72. As an author, I want the Layers rail to read as a well its cards sit in, in both themes.
73. As an author, I want a Layer's kind still recognisable before it is read, at the same legibility
    it has today, with the ink-mixing rule unchanged.
74. As an author with a dozen Layers, I want *＋ Map Image* and *＋ Annotations* still reachable
    without scrolling past the whole stack.
75. As a maintainer, I want the two apps to stack their map-pane controls at the same z-index, so that
    "identical except for editing" is true of the one number where it currently is not.

### Contributors and maintainers

76. As a contributor, I want the theme block, the hairline and the type in each app's `layout.css`
    where daisyUI expects them, rather than in a file of our own invention.
77. As a contributor, I want the copy this epic deletes to be deleted deliberately, with the specs
    that pin it rewritten to assert the new arrangement rather than relaxed to assert nothing.
78. As a contributor, I want to know that `select` takes its radius from two tokens, so that a square
    dropdown on a soft control is not read as a bug.

## Implementation Decisions

### The theme lives in each app's `layout.css`, and there are two of them

`@plugin 'daisyui/theme'` blocks go where `@plugin 'daisyui'` already is:
`apps/editor/src/routes/layout.css` and `apps/viewer/src/routes/layout.css`. They are duplicated
rather than shared, and that is deliberate in the same way `theme.svelte.ts` is duplicated — but
unlike that module, these two must not diverge, so the epic's first ticket is the only place either
is written and any later change touches both in one edit.

`packages/ui/src/layout.css` takes what belongs to the shared components: the `--color-rule` pair and
the `code`/`kbd`/`samp`/`pre` reset, since both are needed wherever a shared component renders.

### The faces are assets Vite emits, not files in `static/`, and not a dependency

Both `woff2` files live in `packages/ui/src/fonts/` — **one copy in the repository** — and are
referenced by a relative URL from `packages/ui/src/layout.css`, the file beside them. Vite then hashes
each, emits it, and rewrites the URL relative to the emitted stylesheet.

`static/` is the wrong home and an absolute `url('/fonts/…')` is the wrong reference, for a reason
ADR-0006 already made mandatory: `paths: { relative: true }` is set in both apps because the publish
target — a domain root or a project subdirectory — is unknown at build time. An absolute font URL
therefore 404s on every site published into a subdirectory, and a relative URL from `static/` is no
better, because the built CSS is served out of `_app/immutable/assets/` and resolves against *that*
directory.

Not an npm package either: a font is not a component library, nothing imports it, and a pinned version
buys nothing over a file whose bytes are in the tree. `THIRD-PARTY-NOTICES.md` records both, with
upstream and licence, under ADR-0021.

### The bar's two tiers are inside `AppBar`'s `<header>`

`AppBar` grows the tiering; it does not grow a second element. `editor-project-screen.e2e.ts` asserts
exactly one `navigation-bar`, `workspace-identity`, `theme-toggle`, `undo-slot` and `save-slot` in
the bar on three routes, and every one of those counts must still be one. The viewer's `SiteBar`
passes `menu` and therefore folds; the editor's passes none and therefore cannot, which is ADR-0014's
first fence and is not being changed.

### `ProjectCardList` grows a media slot; it does not grow a second component

The Map Image list becomes the same component with a leading `media` snippet for `MapThumbnail`.
Generalising the existing component is the smaller change and the one ADR-0034 asks for; a second
card in `packages/ui` would recreate the drift this retires.

### The used-by sentence moves rather than dies

`describeAlignmentUsers` and its every-branch test in `used-by.test.ts` stay. What changes is where
the sentence renders: the Map Image's row on the Workspace Home, not the align sidebar. Deleting the
function would lose the one place ADR-0023's consequence is explained in words.

### The delete control keeps its per-row name

`Delete Control Point 3` moves from visible text to `sr-only` text beside a trash glyph in `error`.
This is ADR-0016's icon amendment applied, not relaxed: the name is in text, never in a `title`, and
three specs reach for it by accessible name.

### Two repairs, scoped small

The rail becomes a flex column with the add-Layer pair as a non-shrinking last child — no token, no
palette, no change to the stack. And the pane control block's z-index becomes one number across both
apps, chosen against `layout.css`'s forcing of MapLibre's four control corners to `6` and the
Inspector's dock at `7`.

## Testing Decisions

### The seams are the ones that already exist

No new seam. Component-level assertions go to Seam 1c — `packages/ui/src/*.dom.test.ts` and
`apps/editor/src/lib/**/*.dom.test.ts` — where a rendered row, dialog, focus order or live region can
be asserted in Node against `happy-dom` rather than in a four-second browser test.

### A palette is asserted by contrast, not by hex

Hard-coding `#8a5f14` in a test pins the decision to a value and makes the next palette a test
rewrite. What is worth asserting is the property the palette was chosen for: that a Layer kind's ink
clears 4.5:1 against a `base-100` card in both themes, computed from the rendered colours, with the
mixing code untouched. That test would have caught the inverted dark ramp; an attribute assertion
would not.

### The no-monospace rule needs a test that fails when the reset is absent

`editor-alignment.e2e.ts` already asserts a computed `tabular-nums` on a Control Point's ordinal, and
that assertion passes whether or not the reset exists, because tabular figures are not monospace. The
rule needs its own check: the computed `font-family` of a rendered `<code>` is the text face.

### The copy cuts are test edits, and they are the point

Three places pin the align sidebar's words. `transformation-picker.dom.test.ts` asserts the four
primary option strings verbatim, the shortfall sentences verbatim, and that the group contains no
`[title]` and no `[class*="tooltip"]`. `editor-align-route.e2e.ts:817-845` asserts the explainer's
`aria-expanded`, that its text contains "Click a feature on the Map Image", and that there is no
CSS-generated content. `editor-alignment.e2e.ts` asserts `control-point-select` text, the ordinal's
`tabular-nums`, and the delete control by accessible name. Each is **rewritten to assert the new
arrangement**, never relaxed to assert nothing — a spec that stops checking is how the copy creeps
back.

### The geometry assertions constrain and are not weakened

`editor-project-screen.e2e.ts:104-130` (map wider than the rail, rail to its left),
`editor-annotations.e2e.ts:1568-1990` (stacking at exactly 1024, the Inspector sheet clear of the
zoom block and the attribution), `viewer-reader.e2e.ts:1278-1560` and `:3957-4205`, and
`e2e/support/leader.ts` all measure boxes. The Project page takes tokens only partly so that none of
them has to move.

### `pnpm precommit`, and the ports are derived

lint → check → test → e2e, cheapest first. `pnpm test:e2e` for the suite, never a bare
`playwright test`, and never `--reporter=…` alone.

## Out of Scope

- **The Base Map.** Protomaps' flavor per theme is ADR-0020's, driven by the theme signal, and
  unchanged.
- **Restructuring the Project page.** Two redesigns of the Layer rail were drawn and both are
  rejected in ADR-0036. The page takes tokens; the add-Layer repair is not a redesign.
- **Authoring on a phone.** ADR-0014's first fence. The editor bar does not fold and is not made to.
- **A monospaced face.** Reconsider only if a layout is genuinely unachievable with tabular figures.
- **Subsetting the type.** Instrument Sans and Bluu Next are shipped whole at 119 KB. A subsetting
  step is what Junicode would have required, and rejecting Junicode is how this epic avoids owning a
  build obligation.
- **A backup timestamp.** One rejected Workspace-settings layout led with "Last backup: never", which
  is a fact nothing records. Storing it is a separate decision.
- **Splitting incidents out of *Keeping it safe*.** Backup-and-restore is a deliberate act and an
  orphaned-edit warning is an incident report; they share a heading because both concern not losing
  work, which is the same loose logic that produced today's flat six. Known, unresolved, and left
  alone rather than fixed badly.

## Further Notes

**`CONTEXT.md` already carries *Workspace Home***, added while this was being designed, with the rule
that it is never a word a user reads: to a Reader that surface is labelled the Front Page, to an
author it is labelled Projects. *Front Page* keeps its existing entry and its existing `<h1>`.

**ADR-0036 is the design reference** and is where the palette's values, the radius seam, the two
marking rules and every rejected alternative live. It also links the two decks, with the warning that
they are private artifacts and may not outlive the decision — everything load-bearing is in the ADR.

**Two things were found by reading and are not design.** The add-Layer buttons scroll out of reach on
a Project with many Layers, and the two apps stack their map-pane controls at `z-[6]` and `z-10`
against an Inspector at `z-[7]` in both. Neither is caused by this epic; both are cheap here and
would otherwise wait for someone to notice them in anger.

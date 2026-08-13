# A Project chooses whether it is on the Front Page

## What to build

A per-Project choice: whether the Project appears on the **Front Page** a Reader arrives at. Set on the
Workspace hub, carried in the Project document, recorded in the published-site record, and honoured by the
viewer's Front Page.

A Project not on the Front Page is still published, still in the repository, and still readable by anyone
who opens `?p=<directory>`. The control must say so. This is the one piece of wording in the epic where
getting it wrong could cause a scholar real harm.

## Where to start

- `packages/core/src/project/project-file.ts` — `ProjectFile` is
  `{ formatVersion, name, updatedAt, layers, baseMap, canonicalUrl, unknownFields }`. Read how
  `unknownFields` is destructured out in the parser and spread back in the serialiser; that channel is why
  this ticket does not need a format-version bump. Read `CURRENT_FORMAT_VERSION`, `ProjectFormatTooNewError`,
  and `parseLayers` versus `parseProjectFile`.
- `docs/adr/0010-integer-format-version-with-forward-only-migrations.md` — the whole argument for not
  bumping. Its rationale names this epic's exact situation.
- `packages/core/src/publish/publish.ts` — `PublishedProject` is `{ directory, name }` today, and
  `parsePublishedSite` is deliberately the tolerant reader. Both change.
- `apps/viewer/src/routes/+page.svelte` around line 891 — `<h1>Published Projects</h1>`, the
  `data-testid="published-projects"` list, and the `?p=` links. This is the Front Page. It exists and is
  already read-only and responsive; this ticket filters it and renames its heading.
- `apps/editor/src/lib/components/ProjectHub.svelte` around lines 490–560 — the Project card and its
  Rename / Duplicate / Export / Delete buttons. The new control goes here. Read the `aria-disabled` comment
  at line 549.
- `e2e/support/published-site.ts` — assembles a Published Site on disk from the **real built viewer** plus
  Project data and serves it at a domain root *and* a subdirectory. This is where the Reader half is
  asserted, not by publishing through the editor. `e2e/viewer-reader.e2e.ts` is the spec that uses it.

## Contract

**A boolean on the Project document, and no format-version bump.** Absent means **on the Front Page**,
which preserves today's behaviour — every Project appears on a Published Site — and matches the intended
default. `CURRENT_FORMAT_VERSION` is **not** incremented: ADR-0010 refuses a newer version outright, and
this epic multiplies the skew it names by making one repository readable by several instances at several
versions. An older build carries the field through `unknownFields` and writes it back untouched, so a fork
that has never heard of the flag cannot silently take a colleague's Project off their own front page.

**`PublishedProject` gains the same fact**, and `parsePublishedSite` stays tolerant: an older viewer bundle
meeting the field must list **everything**, never nothing. Absent means on the Front Page there too.

**The wording is part of the contract.** The state is *"on the front page"* / *"not on the front page"*. It
is never called published, unpublished, private, draft, or hidden — all six are on `CONTEXT.md`'s _Avoid_
list for a reason. Alongside the control, in words the user cannot miss, something to the effect of:
**"Not on the front page — but still readable by anyone with the link."** A scholar with an embargoed
archival photograph, a manuscript under a library's publication restriction, or a student's unmarked
coursework will act on the reading the phrase invites, and the invited reading has to be the true one.

**The heading changes.** `Published Projects` becomes the Front Page's own heading; ADR-0008's "hub page"
prose has already been amended to **Front Page**, and the editor's `ProjectHub` keeps "hub" for itself.
Check `e2e/` and `apps/viewer/` for text assertions on the old heading before renaming.

**A Project not on the Front Page is still reachable by `?p=`** and must render normally. Do not add a
gate, a warning banner, or a `noindex` — none of those makes it private and all of them imply it is.

### User Stories

25, 26, 27, 28, 29, 52, 53, 54.

## Out of scope

- **No `formatVersion` bump.** SPEC "Out of scope" item 7. If you find yourself wanting one, re-read
  ADR-0010.
- **No privacy mechanism.** No token-gating, no obfuscated directory names, no `robots.txt` entry per
  Project. The repository is public; pretending otherwise is the harm this ticket guards against.
- **No per-Project publish.** ADR-0008 defers a single-Project site and ADR-0032 keeps it deferred. The
  Workspace is the unit that publishes; the flag only decides listing.
- **No reordering of the Front Page**, no sorting controls, no descriptions, no thumbnails. Listing and
  not-listing is the whole feature.
- **Do not touch the Reader's Project screen** beyond what filtering requires.
- **Do not make `parsePublishedSite` strict.** Its tolerance is deliberate and documented in place.

## Acceptance criteria

- [ ] A Project can be taken off and put back on the Front Page from the Workspace hub, and the choice
      survives a reload.
- [ ] A Project document with the field absent is treated as on the Front Page.
- [ ] The published-site record carries the fact per Project.
- [ ] `parsePublishedSite` reading a record whose entries lack the field lists every Project.
- [ ] The viewer's Front Page lists only Projects on it.
- [ ] A Project not on the Front Page still opens and renders normally via `?p=<directory>`.
- [ ] The control's accessible text contains no occurrence of "unpublished", "private", "draft", or
      "hidden", and does contain the readable-by-anyone caution — asserted, not eyeballed.
- [ ] `CURRENT_FORMAT_VERSION` is unchanged, asserted by a test.
- [ ] A round-trip through a parser that does not know the field preserves it.
- [ ] The Front Page reads well at a 375 px viewport.

```
pnpm --filter @ballastella/core test
pnpm test:e2e viewer-reader
pnpm test:e2e editor-project-screen
pnpm check
pnpm lint
```

Success: the Reader half passes at both base paths through the existing published-site harness.

## Blocked by

- Ticket 02

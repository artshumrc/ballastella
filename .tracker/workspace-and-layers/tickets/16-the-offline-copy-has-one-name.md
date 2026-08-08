# The Offline Copy has one name

## What to build

Nothing a user can see changes. The code stops calling an Offline Copy a "mirror".

[CONTEXT.md](../../../CONTEXT.md)'s **Offline Copy** entry reads:

> A referenced historical map whose tiles have been fetched into the workspace, so it no longer needs the network and survives the library reorganising. The address it came from is kept, so it can still be cited. The user-facing verb is "make an offline copy".
> _Avoid_: mirror, cache, download, localise

[CONTRIBUTING.md](../../../CONTRIBUTING.md) makes that binding: "The code and the UI are required to use those words." The code does not. `mirror` is the spelling throughout — a module, a component, a job, several barrel exports, and the `mirrored` half of a returned pair.

This was found during ticket 08's review and deferred because three tickets were in flight and the rename crosses all of them. It is bookkeeping, not design, and it should land when the epic's parallel work has merged.

## Where to start

Get the real list first — this ticket was written from a partial one:

```
grep -rn "mirror\|Mirror\|cache\|localise\|localize\|downloadCopy" packages/*/src apps/*/src e2e
```

Known sites at the time of writing:

- `packages/core/src/remote-iiif/mirror.ts` — `planMirror`, `estimateMirrorBytes`, `mirrorRemoteImage`, and the module name itself.
- `packages/core/src/project/historical-maps.ts` — `partitionByLocalCopy` returns `{ referenced, mirrored }`. Ticket 08 moved this here and left the vocabulary alone deliberately.
- `apps/editor/src/lib/remote-iiif/MirrorMap.svelte` and `mirror-map.svelte.ts`.
- `packages/core/src/index.ts` — whatever of the above is exported.
- `e2e/editor-mirroring.e2e.ts`, and test names and `data-testid`s throughout.
- `apps/editor/src/lib/project/ProjectScreen.svelte` — the `mirror` job, the `mirrored-image-label`
  and `mirrored-image-source` test ids on a Layer's actions, and the `mirror-done` region. **Ticket
  04 moved these here from the deleted `ProjectView.svelte`**, so the vocabulary is unchanged but the
  address is: a `grep` written against the old path finds nothing. `e2e/editor-project-screen.e2e.ts`
  is new surface in the same sweep.

## Contract

**The domain word is Offline Copy, and the verb is "make an offline copy".** `offlineCopy`, `planOfflineCopy`, `makeOfflineCopy`, `OfflineCopyJob`. `partitionByLocalCopy` becomes something spelling both halves in the ubiquitous language — the pair is a referenced map versus one with an Offline Copy.

**`cache` survives only where it names something that really is an HTTP cache** — the Cache API, a service-worker cache, a `Cache-Control` header. Those are not Offline Copies and must not be renamed into one. This is the distinction that makes the grep above need judgement rather than `sed`.

**`cache` also survives for the Base Map tile cache, and that is not a loophole (ADR-0025, ticket 11).** These are Base Map tiles pulled out of a Protomaps archive so a Project's reference map draws with the network off. They are **not** an Offline Copy: an Offline Copy is of a *Historical Map* — the scholar's own source, fetched from a IIIF host, listed per Layer, and owned by the Project. Renaming the tile cache into that vocabulary would collide two different things in one word, which is the failure this ticket exists to undo rather than repeat. ADR-0025 says "cache" throughout and ticket 11 built to it.

The sites, all added after this ticket was written:

- `packages/core/src/base-map/tile-cache.ts` and `offline-cache.ts`, their tests, and the
  `base-map/index.ts` barrel that re-exports them.
- `packages/core/src/render/base-map-tile-protocol.ts`.
- `packages/core/src/publish/publish.ts` (the cached-tile half of the published record) and its test.
- `apps/editor/src/lib/editor-session.svelte.ts`, the cached-tile reader and coverage.
- `apps/editor/src/lib/base-map/` — `archive-tiles.ts`, `make-offline.svelte.ts`,
  `BaseMapPane.svelte`, `browser-test-handle.ts`.
- `apps/editor/src/lib/components/ProjectHub.svelte` and
  `apps/editor/src/lib/project/ProjectScreen.svelte`.
- `apps/viewer/src/lib/ReaderMapPane.svelte`, `apps/viewer/src/lib/browser-test-handle.ts`, and
  `apps/viewer/src/routes/+page.svelte`.

⚠ **AC2 as written is unsatisfiable against this branch** and must be read with this exemption, or the ticket will be closed by renaming something that should not be renamed.

**`new URL(...).host` and other Web API members are not the domain word** and stay. The same applies to any `mirror` that belongs to a third-party API.

**No behaviour changes.** If a test needs editing beyond its name and its locators, something has gone wrong — stop and say so.

## Out of scope

- **Library vs host.** Already fixed in ticket 08.
- **Any change to what an Offline Copy does**, when it is made, or what it costs. Ticket 11 owns the offline story.

## Acceptance criteria

1. `grep -rn "\bmirror" packages/*/src apps/*/src e2e` returns only third-party API members, each with a comment saying so.
2. `grep -rn "\bcache" packages/*/src apps/*/src` returns only genuine HTTP/service-worker caches and the Base Map tile cache listed under Contract.
3. Every renamed symbol is renamed at its definition, its exports, its call sites, and in test names — no aliasing shim left behind.
4. `pnpm -r build && pnpm -r test && pnpm lint && pnpm check` passes, and `pnpm test:e2e` passes.
5. The diff contains no change to a `.svelte` file's rendered text other than where that text used a banned word.

Because this ticket changes no behaviour, the usual mutation check does not apply. The check that matters instead: **confirm the test count is unchanged before and after**, and that no test was deleted rather than renamed.

## Outcome

Finished by the epic coordinator after the implementer hit a session usage limit during its final prose review. The mechanical work was complete; what follows was verified independently rather than taken from a report.

**Criterion 1 is amended, not ticked.** As written it expects `grep -rn "\bmirror"` to return "only third-party API members, each with a comment saying so." Two hits remain and neither is third-party: `distortion.ts:141` and `distortion.test.ts:126`, both the **geometric** sense — an Alignment that is mirrored because two Control Points were swapped. That is a different concept from the banned "mirror = Offline Copy", it is the ordinary word for the thing, and `distortion.ts:140-148` now says so explicitly and points at CONTEXT.md. The criterion did not anticipate the collision. Renaming the geometric use would have obeyed the letter and damaged the vocabulary.

**Criteria 2, 3 and 5 verified.** Every surviving `cache` is the Base Map tile cache the Contract permits, a genuine HTTP/service-worker cache, or `DirectoryHandleStore`'s handle cache. No aliasing shim was left behind. No `.svelte` rendered text changed except where it carried a banned word.

**Criterion 4:** `pnpm -r build`, `pnpm -r test` (58 files, **1493 passed**, 15 skipped), `pnpm lint`, `pnpm check` (0 errors) all green.

**The substitute check passed exactly.** Core test count is 1493 before and after. In the diff, test declarations balance 3 removed against 3 added and `describe` blocks 8 against 8 — every one a rename, none a deletion.

**ADR-0007 was renamed with a banner** recording its old title rather than rewriting history, which is this repo's convention and the right call for a document other records cite.

**The composed e2e fixture survived.** A repo-wide rename is the change most likely to quietly unpick it, so this was checked rather than assumed: `check-e2e-network-fence` reports 26 specs behind the composed root, and the root still layers the fence.

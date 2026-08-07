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

## Contract

**The domain word is Offline Copy, and the verb is "make an offline copy".** `offlineCopy`, `planOfflineCopy`, `makeOfflineCopy`, `OfflineCopyJob`. `partitionByLocalCopy` becomes something spelling both halves in the ubiquitous language — the pair is a referenced map versus one with an Offline Copy.

**`cache` survives only where it names something that really is an HTTP cache** — the Cache API, a service-worker cache, a `Cache-Control` header. Those are not Offline Copies and must not be renamed into one. This is the distinction that makes the grep above need judgement rather than `sed`.

**`new URL(...).host` and other Web API members are not the domain word** and stay. The same applies to any `mirror` that belongs to a third-party API.

**No behaviour changes.** If a test needs editing beyond its name and its locators, something has gone wrong — stop and say so.

## Out of scope

- **Library vs host.** Already fixed in ticket 08.
- **Any change to what an Offline Copy does**, when it is made, or what it costs. Ticket 11 owns the offline story.

## Acceptance criteria

1. `grep -rn "\bmirror" packages/*/src apps/*/src e2e` returns only third-party API members, each with a comment saying so.
2. `grep -rn "\bcache" packages/*/src apps/*/src` returns only genuine HTTP/service-worker caches.
3. Every renamed symbol is renamed at its definition, its exports, its call sites, and in test names — no aliasing shim left behind.
4. `pnpm -r build && pnpm -r test && pnpm lint && pnpm check` passes, and `pnpm test:e2e` passes.
5. The diff contains no change to a `.svelte` file's rendered text other than where that text used a banned word.

Because this ticket changes no behaviour, the usual mutation check does not apply. The check that matters instead: **confirm the test count is unchanged before and after**, and that no test was deleted rather than renamed.

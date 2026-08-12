# Making an Offline Copy moves the picture into the Workspace

## What to build

When a scholar makes an Offline Copy of a referenced Historical Map, its picture stops coming from the
Library and starts coming from their own Workspace. Nothing about the picture should look different —
the point is that it no longer needs the network, which is the whole promise of making the copy.

**The expected code change is zero.** An Offline Copy writes a pyramid into the same image directory and
deliberately leaves `remote.json` where it is, so `tileLocation` starts answering `'in-workspace'` for a
map that has both files, and the resolver ticket 01 built follows it. This ticket's job is to **prove
that**, and to prove it with an assertion that could distinguish the two sources.

If the behaviour turns out not to fall out for free, **stop and report it** rather than designing a fix:
that would mean `tileLocation` or the resolver disagrees with ADR-0023, which is a finding about the
earlier tickets and not a licence to add a branch here.

## Where to start

- `packages/core/src/project/historical-maps.ts` — `tileLocation`, and the comment stating that **both
  files present means `'in-workspace'`**. Also `partitionByOfflineCopy`, which exists precisely because a
  copied map keeps its record.
- `packages/core/src/remote-iiif/referenced-image.ts` — the doc comment above `listReferencedImages`,
  which explains at length why the two lists stop being disjoint after a copy and why that is *working
  rather than a defect*: the record is the citation ADR-0007 exists to protect.
- `packages/core/src/remote-iiif/offline-copy.ts` — `makeOfflineCopy`, and the point where it calls
  `ingestImageFile`. That call is what writes the `info.json` that flips the answer.
- `apps/editor/src/lib/remote-iiif/offline-copy-job.svelte.ts` — the job's UI state.
- `e2e/editor-offline-copy.e2e.ts` — **the existing spec for this flow.** The new assertions belong here;
  it already knows how to drive a copy to completion, which is the slow and fiddly part.
- The resolver and component from tickets 01 and 03.

## Contract

**The thumbnail follows `tileLocation`, not the presence of `remote.json`.** A map with both files uses
the Workspace-held tile. There is no new field, no flag, and nothing that records that a copy happened —
that is ADR-0023's rule that an observable fact is never also a stored one.

**The assertion has to be able to tell the two sources apart.** "A picture is shown" passes before and
after the copy and therefore proves nothing. Assert one of:

- the element's `src` became a `blob:` URL where it was an `https:` URL on the Library's host; or
- no request reached the Library's host after the copy completed.

**The picture must not visibly change.** Same box, same fit, same absence of a caption. A scholar should
see continuity; only the network dependency has gone.

**`loading="lazy"` goes away with the Library.** After the copy the map is Workspace-held, so the
component takes the object-URL path and the attribute is not applied — which follows from ticket 03's
contract and needs no code of its own. Worth asserting, because it is the observable difference between
the two paths.

### User Stories

Covers SPEC stories **13, 14**.

## Out of scope

- **Adding any code to make the flip happen.** See above: if it does not fall out, that is a finding to
  report, not a branch to write.
- **Changing `makeOfflineCopy`, its plan, its progress reporting, or its refusals.** The
  over-ceiling refusal, the level-0 warning, and the rights/attribution surfacing are all untouched.
- **Deleting or rewriting `remote.json` when a copy completes.** It is the citation. `listReferencedImages`'
  doc comment is explicit that a map in both lists is correct.
- **Reporting anything about the transition** — no toast, no notice, no "now offline" badge.
- **The reverse direction.** There is no gesture that turns a Workspace-held map back into a referenced
  one, and none is added here.
- **Asserting on the pyramid's contents.** That is `editor-offline-copy.e2e.ts`'s existing business and
  already covered.

## Acceptance criteria

- [ ] After an Offline Copy of a referenced Historical Map completes, the hub's picture for that map is
      served from the Workspace — its `src` is a `blob:` URL, or no request reaches the Library's host.
- [ ] The picture is still one that has actually decoded: `naturalWidth > 0`.
- [ ] `remote.json` still exists for that map after the copy.
- [ ] The element no longer carries `loading="lazy"`.
- [ ] No production code was added or changed by this ticket; the diff is tests only. If that is not
      true, the deviation is written into this ticket with its reason.
- [ ] `pnpm precommit` passes.
- [ ] A mutation record is written into this ticket.

```sh
pnpm test:e2e editor-offline-copy.e2e.ts

# The resolver's both-files case, if not already covered by ticket 01's node tests.
pnpm --filter @ballastella/core test --project node -t "offline copy"

pnpm precommit
```

Success is exit code 0 from each. Read exit codes directly; no `grep`, and no `--reporter=…`.

### The mutation record

| Criterion | Mutation | Result |
| --- | --- | --- |
| the source really moved into the Workspace | make `tileLocation` answer `'referenced'` when both files are present | expect red — **green means the assertion is "a picture is shown", which passes either way** |
| the citation survives | delete `remote.json` when a copy completes | expect red |

⚠ **This is the ticket most likely to pass vacuously**, because the visible outcome is identical before
and after the change it is testing. An assertion that does not name `blob:` or count requests to the
Library is not testing anything. That failure mode — an assertion that compares a state with itself —
has appeared in this tracker before and was found only on review.

⚠ Making an Offline Copy is a long job. Wait on its completion state rather than on a timeout, and reuse
whatever `editor-offline-copy.e2e.ts` already does for that rather than inventing a second wait.

## Blocked by

- 03 — a referenced map has no picture to move before it.

# 07 — Replay never reverts newer bytes

## Why this is first

The [change of direction](../SPEC.md) moves the durability guarantee onto the Write-Ahead Journal: a write that fails is safe because the journal holds a copy and replay returns it at startup. **That is only true if replay is correct, and it is not.** Everything else in the re-sliced epic waits on this.

Fulfills stories **1** (a storage hiccup does not cost me work), **6** (a stranded edit survives until written or explained) and **9** (recovery without knowing to act).

## What is already measured — do not re-derive it

Found during ticket 01, reproduced twice by different agents:

```
A  store "v1"                        → entry ["v1"] → replay → store "v1"   ✓ redundant, harmless
B  store "v1", then something writes "v2-NEWER" → entry ["v1"] → replay → store "v1"   ✗ reverted
```

`replayJournal` → `writePlain` → `store.write(path, bytes)` **unconditionally**. `missingOwner` checks only that the owner still exists; nothing ever compares what the store holds against what the entry carries. And the revert is reported as `restored`, which reads to the caller as good news.

**Why it is latent today:** `Autosave` re-records on every `queue`/`commit`/`capture`, so its own entries always track the newest bytes. The routes that write the store *without* recording are `transfer/open-project-bundle.ts`, `transfer/restore-workspace-tar.ts`, `tiler/ingest.ts`, `base-map/offline-cache.ts`, and `replay.ts` itself.

**Why it stops being latent:** under the new design, a stranded write deliberately keeps a live journal entry across a restart. That is the normal case, not an edge case.

**A warning from ticket 01, worth more than it looks.** The implementer's first two attempts to probe this had wrong constructor signatures and **both produced a reassuring empty result** — `restored: []`, B apparently keeping its newer bytes. A broken harness in this area fails toward "no problem found", which is the same direction as the defect. Plant a revert you know should be caught and confirm the harness catches it before trusting any green.

## What to do

Make replay unable to overwrite bytes newer than the entry it is replaying, and stop reporting a revert as a restoration.

The mechanism is yours to choose, but state it and test it. Candidates:

- record what the store held when the entry was made, and skip the replay if the store no longer holds that;
- carry a monotonic stamp on the entry and on the stored bytes, and compare;
- compare content directly where that is cheap enough to be honest about.

**Decide what "newer" means and write it down.** The journal and the store are different backends with no shared clock; if the answer is "we cannot always tell", say which cases are decidable and what happens in the rest. An honest narrow guarantee beats a broad one that is false.

## Acceptance criteria

- [ ] Case B above leaves the newer bytes in place. Driven as a test, with the mutation that turns it red recorded.
- [ ] A replay that declines to write does not report `restored`. What it reports instead is stated and asserted.
- [ ] Case A still works — a genuinely stranded write is still returned at startup. This is the whole point; do not fix B by disabling replay.
- [ ] Each of the five direct-write routes named above is either covered by a test or explicitly argued as out of reach, per route. Not as a group.
- [ ] The harness is proven to catch a planted revert before any green result is reported.
- [ ] Every claim in a comment or docblock has a mutation that falsifies it. This epic has had eight findings of prose over-claiming, several inside fixes for that exact problem.

## Out of scope

- **Redesigning when the journal records.** Recording at the edit rather than at `pagehide` is settled.
- **The unload warning** — that is ticket 08, and it depends on this.
- **`Autosave`'s internal state** — that is ticket 09, running alongside. Do not refactor `autosave.ts` here; coordinate if you need a seam from it.

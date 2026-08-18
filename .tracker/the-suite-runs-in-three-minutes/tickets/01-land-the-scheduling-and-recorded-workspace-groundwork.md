# 01 — Land the scheduling and recorded-Workspace groundwork

## What to build

Nothing new. **This work already exists, uncommitted, in the working tree**, and this ticket is to review it, verify it, and land it — because everything else in the epic builds on it and it is currently one `git checkout` from being lost.

Four changes are involved:

1. `fullyParallel: true` in the Playwright configuration. Playwright was parallelising across *files* only, running each file's tests serially in one worker, so a run could never finish faster than its longest file.
2. The worker count made overridable by environment, default unchanged at 4.
3. The obsolete "eight workers measured 19% faster, so the suite is near this CPU's ceiling" note corrected in place. That measurement predates `fullyParallel` and was measuring the scheduling, not the processor.
4. A recorded Workspace: a Map Image's pyramid is captured once per build through the real interface and written straight into OPFS thereafter, instead of being rebuilt through the file picker in every test of the alignment family.

Verify each, correct anything that does not hold, and commit.

## Where to start

- `playwright.config.ts` — the `workers` and `fullyParallel` blocks, and the long comment above `workers` that carries the corrected measurement.
- `e2e/support/workspace-snapshot.ts` — new. Captures and replays the Workspace; keyed to the fingerprint `scripts/e2e-build.mjs` already writes to `node_modules/.cache/ballastella-e2e/build-stamp.json`.
- `e2e/support/alignment-workspace.ts` — `start()` now seeds from the recording and navigates directly to the alignment route; `ingestThroughTheInterface()` is the recorded path.
- `e2e/editor-layers.e2e.ts` — six tests already retired here; their replacements are in `apps/editor/src/lib/layers/layer-list.browser.test.ts` and `LayerListHarness.svelte`. **Those two files are ticket 02's to convert — land them as they are.**
- Read `scripts/e2e-build.mjs`'s header for how the fingerprint is computed and why it is the right key.

## Contract

- **The recording is a recording, never a construction.** It is produced by driving the real interface and reading the resulting bytes out of OPFS. It must never be built from `core`'s own serialisers — `e2e/support/reader-project.ts`'s header carries the argument: a fixture sharing a code path with the application agrees with it however wrong both are.
- **The recording is keyed to the build fingerprint.** A changed tiler, serialiser or Project screen invalidates it. A missing or damaged recording falls back to the real ingest.
- **`workers` default stays 4.** The reason for 4 is the shared machine, not the benchmark, and this epic does not overturn it. `BALLASTELLA_E2E_WORKERS` is the override.
- **`fullyParallel` changes an inherited guarantee**: tests in one file no longer share an order. Any spec that wants ordering must declare `test.describe.serial`. The configuration comment must say so.

### User Stories

2, 12, 15, 16, 17, 18, 37, 38, 44.

## Out of scope

- Converting the component seam to Node — that is ticket 02. Land `layer-list.browser.test.ts` in its current browser-mode form.
- Raising the default worker count.
- Fixing the pre-existing `editor-remote-binding` failure or the `viewer-reader` flake — ticket 05 records them.
- Retiring any further Seam 2 tests.
- Reverting the Firefox instance in `packages/core`'s browser project. It was tried during investigation and reverted: it saves 2.6s and costs the local half of SPEC story 4. Leave it.

## Acceptance criteria

- [ ] `pnpm precommit lint check test` passes.
- [ ] The full Seam 2 suite passes apart from the two pre-existing faults named in ticket 05, and its wall time is recorded in `TRACKER.md`.
- [ ] Deleting the recording and re-running the alignment family reproduces it and still passes — the fallback to a real ingest works.
- [ ] A recording made against a different build is not reused: touch a tiler source, rebuild, and confirm a new cache file appears.
- [ ] `BALLASTELLA_E2E_WORKERS=10` changes the worker count; unset, it is 4.
- [ ] The `workers` comment no longer asserts the 19% figure as evidence about the CPU.

```bash
pnpm precommit lint check test
time pnpm test:e2e                      # record wall time and counts in TRACKER.md
rm -f node_modules/.cache/ballastella-e2e/snapshot-*.json
pnpm test:e2e editor-alignment-refinement.e2e.ts   # regenerates the recording, passes
ls node_modules/.cache/ballastella-e2e/            # a snapshot-*.json is back
BALLASTELLA_E2E_WORKERS=10 pnpm test:e2e editor-layers.e2e.ts
```

Success: `precommit` exits 0; the suite matches the recorded failure profile and nothing new is red; the recording regenerates without manual intervention.

## Blocked by

None — can start immediately.

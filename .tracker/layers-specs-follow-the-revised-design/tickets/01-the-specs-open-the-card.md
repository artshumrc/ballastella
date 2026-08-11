# 01 — The specs open the card

## What to build

Twenty-nine browser tests that assert on Layer controls from a collapsed row, updated to open the
card first — because that is where the controls are since `b65663d`.

**No product code changes.** The app is correct; the assertions describe the previous layout.

**Fulfills** — no new SPEC story. It restores the suite's ability to defend stories 38, 49, 51, and
96, and ADR-0002 and ADR-0014, all of which currently have red tests standing over working code.

## Where to start

[TRACKER.md](../TRACKER.md) in this epic holds everything already measured: which controls moved,
which stayed, the canonical fix, the accordion trap, the two non-mechanical cases, the recorded
human decision about keyboard reordering, and the traps met while running the suite. **Read it
first and do not re-derive any of it.**

## Contract

Each fix is the smallest change that makes the test assert what its own prose says it asserts. Where
opening the card changes *what the test is about*, say so in a comment rather than leaving the
gesture unexplained — a future reader will otherwise take `openLayerRow` for boilerplate and move it.

Where a test asserts an **absence**, it must be read on an open card. The disclosure is an accordion,
so a collapsed row satisfies any absence for the wrong reason.

## Out of scope

- **Changing the design back.** Decided 2026-08-11: keyboard users expand, pointer users drag the
  collapsed row. See the TRACKER.
- **The `viewer-reader.e2e.ts:2293` flake.** Within the retry budget; noise.

## Acceptance criteria

- [x] The six single-failure files pass — `editor-add-historical-map`, `editor-align-referenced`,
      `editor-image-ingest`, `editor-named-workspaces`, `editor-offline-copy`, `editor-opening-view`
- [x] `editor-undo` and `editor-remote-iiif` pass in full — 32 tests
- [ ] `editor-layers` passes in full
- [ ] The four `tabTo` tests assert keyboard reachability per open card, and name the decision
- [ ] `is an ordered list whose structure and order are announced` rests on a defensible locator
- [ ] The ticket-05 comment block no longer claims the closed row holds the position controls
- [ ] Full suite: 540 passed, 1 skipped, no failures — verified with the exit code read directly

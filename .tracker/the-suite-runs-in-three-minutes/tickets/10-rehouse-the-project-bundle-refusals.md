# 10 — Rehouse the Project Bundle refusals to Seam 1

## What to build

`editor-transfer.e2e.ts` carries a block of eight refusals — every way a Project Bundle can be malformed, each currently driven through a real file input into a real browser to assert that a parser says no:

- a file that is not a tar at all;
- a bundle whose download stopped half way;
- an archive with no `project.json`;
- a `formatVersion` from the future, naming the remedy (ADR-0010);
- a missing `geojsonRef`, naming what is not there;
- an image directory with no `info.json`, naming it;
- an entry that climbs out of the Project;
- a bundle there is no room for, refused before anything is created.

Every one is a claim about parsing bytes and about the message a scholar is shown. `packages/core` already owns both.

## Where to start

- `e2e/editor-transfer.e2e.ts` — the refusals block, and the helper that packs the fixture tars it feeds to the file input.
- `packages/core/src/transfer/open-project-bundle.ts` and `project-bundle.test.ts` — where these belong, and where `assertReferencesPresent` already lives.
- `packages/core/src/transfer/tar-format.test.ts` — the model for asserting against real archive bytes in Node, including truncation. Its header records what `modern-tar` guarantees and how those guarantees were measured.
- `packages/core/src/store/memory-project-store.ts` — for "refused before anything is created", which is a claim about the store being untouched.
- ADR-0010 for the version-refusal contract, ADR-0024 for why a bundle is a tar.

## Contract

- **The message is part of the claim.** Each refusal names something — the remedy, the missing reference, the offending directory. A Seam 1 test that asserts only that an error was thrown has dropped half the behaviour; ADR-0010's refusal exists to tell a scholar what to do.
- **"Refused before anything is created" is asserted on the store**, not on the absence of an exception: after the refusal, the store contains exactly what it did before.
- **One Seam 2 test remains** proving a malformed bundle picked through the real file input is refused and the refusal is shown to the user. Moving the matrix down without it leaves the wiring between the file picker and the parser unasserted.
- The XSS-payload-in-a-bundle test belongs with ticket 06's sanitiser work, not here — but if it is still at Seam 2 when this ticket runs, leave it rather than duplicating.
- Every retired Seam 2 test names its replacement.

### User Stories

5, 9, 24.

## Out of scope

- The Review Workspace half of this file — the review copy being editable, being absent from the Project list, being taken off the switcher before deletion, both exits working from the keyboard. That is ADR-0024 behaviour in the running application and it stays for now.
- The export half: the tar named for the folder, exporting a Project this build refuses to open, the focus behaviour during an export.
- Changing `modern-tar`, the bundle format, or any refusal message.

## Acceptance criteria

- [ ] All eight refusals are asserted at Seam 1, each against real archive bytes, and each asserting what the message names rather than only that it failed.
- [ ] "Refused before anything is created" is asserted by comparing store contents before and after.
- [ ] Exactly one Seam 2 test remains covering the file-input-to-parser wiring, with a comment saying why it survives.
- [ ] Each new Seam 1 test is watched to fail once against a deliberate break.
- [ ] Every retired Seam 2 test is named alongside its replacement.
- [ ] `pnpm test:e2e editor-transfer.e2e.ts` passes; count and wall time recorded before and after.
- [ ] `pnpm precommit lint check test` passes.

```bash
pnpm test:e2e editor-transfer.e2e.ts
pnpm --filter @ballastella/core test
pnpm precommit lint check test
```

Success: eight browser tests become eight Node tests plus one wiring test; the messages are still asserted.

## Blocked by

- 01

# The same sentence on the author's side

## What to build

The editor says the same thing the published viewer now says when a Map Image's tiles stop arriving — on the Project screen, and on the alignment screen, where it matters most.

A scholar placing Control Points against a referenced map whose Library has gone quiet is aligning against a stale or partial image and cannot tell. That is the case this ticket exists for.

## Where to start

- **The domain function ticket 04 added.** Do not write a second sentence. If the editor needs a distinction the function does not yet make, add the row *to the function* and its tests, so both deployments get it.
- `apps/editor/src/lib/project/ProjectScreen.svelte` — the existing `base-map-unavailable` `role="alert"` block is the pattern, and its comment explains why `role="alert"` rather than a live region for text inserted when it first exists.
- `apps/editor/src/lib/alignment/AlignmentWorkspace.svelte` and `apps/editor/src/lib/image-pane/MapImagePane.svelte` — the alignment screen and the pane that reads a Map Image. The pane already carries an offline notice naming the host, and already has a load effect with an `untrack`ed connection read whose reason is written down. **Read that reasoning before touching the effect** — losing the connection must not tear down a pane a scholar is mid-alignment on.
- `e2e/editor-align-referenced.e2e.ts` and `e2e/editor-base-map.e2e.ts` — the seams and the fixture idiom.
- `e2e/support/base-map-notice.ts` — the shared helper that lets one spec on each side assert the *same whole string*, so a wording change turns both red. That is the mechanism that closed the "cannot drift" criterion last time; reuse it rather than pinning fragments.

## Contract

**One sentence, two deployments, asserted rather than eyeballed.** Both sides assert the whole rendered text against a shared helper. Pinning fragments on one side and the whole string on the other leaves the fragment side free to drift — which is exactly the gap found and closed in the previous epic.

**The alignment screen is the acute case.** A scholar mid-alignment must be told, and must not lose the Control Points they have placed, and must not have the pane torn out from under them.

**Tiles already drawn stay drawn.** Same rule as ticket 04. Assert it here too — a fix that blanks the pane would pass a naive "the notice appears" test.

**A failure while a Layer is hidden is reported when the Layer is shown.** A message a scholar could not have seen is not an adequate warning.

**Visible text, never a tooltip. Announced**, using the settled mechanism, with the choice stated.

**Do not steal focus** from a Control Point being placed.

## Out of scope

- **Changing the shared sentence's wording** without changing the domain function and its tests. If the editor needs different words, that is a new row in the function, not a template edit.
- **The Base Map's unreachable-archive notice**, which the editor already has. Different failure, different remedy, separate message. Do not merge them.
- **The published viewer** — ticket 04 owns it. Do not "improve" it while you are here.
- **The offline notice** the pane already shows. Losing a connection and a Library refusing are different things; do not collapse them.
- **The write path.** Tickets 01–03.
- **`storedPyramidTileSource`** and the upstream gap it waits on. Leave it as documented.

## Acceptance criteria

- [ ] With a referenced Map Image's tiles refused mid-alignment, the alignment screen shows the sentence, and the Control Points already placed are still on screen and still on disk.
- [ ] The Project screen shows the same sentence for the same failure.
- [ ] **Both deployments assert the same whole string** through a shared helper, and a wording change in the domain function turns **both** the editor and the viewer specs red.
- [ ] Tiles that already arrived are still drawn while the message is up — asserted on rendered tiles, not on a count the page reports about itself.
- [ ] A failure that occurs while a Layer is hidden is reported when the Layer is shown.
- [ ] The message is announced, with the mechanism stated in code.
- [ ] Losing the connection while a pane is open does not tear the pane down (existing behaviour, re-asserted so this change cannot have removed it).
- [ ] No uncaught `pageerror` on the editor path.
- [ ] The mutation check is recorded per criterion. **Report any surviving mutation as green with its reason.**

```sh
pnpm exec playwright test e2e/editor-align-referenced.e2e.ts e2e/editor-base-map.e2e.ts e2e/viewer-reader.e2e.ts
pnpm --filter @ballastella/core exec vitest run src/base-map/resolve.test.ts
pnpm lint && pnpm check && pnpm -r build && pnpm -r test
pnpm test:e2e
```

All exit 0. Read exit codes directly; never pass `--reporter=`; do not pipe gate output through `grep`. No test may reach the network.

## Blocked by

- Ticket 04 — a Reader is told when a Map Image's tiles stop arriving.

# A save that gave up says so

## What to build

End the state where the app knows a save has failed and shows a scholar one word. When retries are exhausted, the editor says so in visible text: what is affected, that the rest of their work is safe, and what they can do.

The contract this ticket establishes, and which every later change must keep: **no save state other than "Saved" or "Saving…" may be shown without an accompanying sentence.**

## Where to start

- `apps/editor/src/lib/components/SaveIndicator.svelte` — today a `saveState` prop mapped to three labels, one of which is `'Unsaved changes'`. That label currently covers both "a debounce is pending, all is well" and "a write failed and nothing is coming".
- `apps/editor/src/lib/components/NavigationBar.svelte` — renders the indicator, and already renders sibling warnings (`protection-warning`, `deletion-warning`) with `role="alert"`. That is the settled pattern for text that is *inserted* at the moment it first exists.
- `apps/editor/src/lib/editor-session.svelte.ts` — `saveError` and the existing `onJournalRefused` → warning wiring. Extend these surfaces rather than adding a parallel one.
- **The sentence goes in `packages/core`**, beside `baseMapUnavailableNotice` in `packages/core/src/base-map/resolve.ts`. Read that function's header: it carries three things in the order the questions arrive — *it is not you*, *your work is safe*, *here is what would fix it* — and its unit tests drive every row **plus** one asserting that no row makes a claim the code cannot support. Copy that shape.
- `e2e/editor-project-screen.e2e.ts` — the existing test that a save which failed says why, in a region a screen reader is given. That is the prior art and the seam.

## Contract

**The sentence lives in the domain layer.** One function, taking the facts that decide the wording, unit-tested across every row. The editor renders it; it does not compose its own. This is what stops the two deployments drifting, and it is the resolution the Base Map notice already reached.

**Announcement uses the mechanism the repo has settled on twice.** A region *inserted together with its text* is not reliably announced; `role="alert"` is announced on insertion. `ReviewBanner.svelte` and `UpdatePrompt.svelte` both state this in writing — a permanently-mounted `aria-live` wrapper for text that changes, `role="alert"` for text that appears. Choose deliberately and say which and why.

**Distinguish the causes the scholar can act on differently.** A refused write, a storage that is full, and a browser that will not hold a rescue copy are different remedies. ADR-0017 requires "two refusals, not one" for exactly this reason, and the existing `protectionWarning` is the precedent — note that its wording is about an edit *on its way* to storage and does not fit a save that has given up.

**Visible text, never a tooltip** (SPEC story 111 in the previous epic, ADR-0016).

**Dismissible, and it comes back.** A scholar can dismiss a message they have read. If the failure happens again, it appears again — a dismissal keyed on the message's *content* will not do that, which the previous epic found the hard way.

**Do not steal focus.** A warning must not interrupt a Control Point being placed. If focus moves at all, it moves in response to a gesture.

**Name what is affected.** With several Projects open over a session, the sentence says which one. A Workspace-wide storage failure is told apart from one file failing.

## Out of scope

- **The retry policy itself** — ticket 02. This renders the outcome; it does not change when giving up happens.
- **The drain gap** — ticket 01.
- **The published viewer.** A Reader does not save. The viewer's half of this epic is tickets 04 and 05, and it is about tiles, not writes.
- **Redesigning `SaveIndicator`'s visual language**, the debounce delay, or the "Saving…" minimum-display behaviour.
- **A rescue/export affordance** for unsaved bytes. Telling the scholar is this ticket; giving them a new way out is not.

## Acceptance criteria

- [ ] With the store refusing permanently, the editor shows a sentence naming what could not be saved and stating what is unaffected — asserted on the rendered text, not on a state field.
- [ ] That sentence comes from the domain function, and a wording change there turns the editor test red (so the editor cannot drift into its own words).
- [ ] The domain function is unit-tested across every row it can be in, including one test asserting that **no** row claims something the code cannot support.
- [ ] The sentence is announced — asserted through the accessible mechanism, with the choice of `role="alert"` versus a mounted live region stated in code.
- [ ] "A debounce is pending" and "a write gave up" are distinguishable on screen, not just internally.
- [ ] The message can be dismissed, and **reappears if the failure recurs after dismissal** (assert across a second failure, not only the first).
- [ ] Placing a Control Point while the message is up does not lose focus to the message.
- [ ] No save state other than Saved/Saving is reachable without a sentence — assert the pairing, not each half separately.
- [ ] The mutation check is recorded per criterion. **Name, for each new assertion, the exact deletion that would keep it green if you cannot make one go red.**

```sh
pnpm --filter @ballastella/core exec vitest run src/base-map/resolve.test.ts
pnpm exec playwright test e2e/editor-project-screen.e2e.ts
pnpm lint && pnpm check && pnpm -r build && pnpm -r test
pnpm test:e2e
```

All exit 0. Read exit codes directly; never pass `--reporter=`; do not pipe gate output through `grep`.

## Blocked by

- Ticket 02 — a failed write retries itself, within a stated bound.

# 02 — Move the component seam into Node

## What to build

The editor's component seam currently runs in Vitest's **browser mode**, taking a Chromium process per run to render Svelte components that touch no OPFS, no WebGL and no service worker. That is a scaled-down copy of the cost this epic exists to remove. Move it to **Node against a DOM implementation**, port the thirteen existing tests, and — before trusting any of them — find out where the DOM implementation lies.

The deliverable is a component seam that runs with no browser, a written record of its known divergences, and any claim that the divergences reach sent back to Seam 2 rather than worked around.

## Where to start

- `apps/editor/vitest.config.ts` — two projects today, `editor` (Node, no DOM) and `editor-browser` (Chromium). The second is what changes. **Read its header first**: the `environments.ssr` note explains why getting the *client* Svelte runtime is what makes a reactivity assertion mean anything, and that argument applies unchanged to the new project.
- `apps/editor/src/lib/layers/layer-list.browser.test.ts` — the thirteen tests to port.
- `apps/editor/src/lib/layers/LayerListHarness.svelte` — a parent holding `$state`, whose header explains why prop replacement from the test body cannot test focus restoration.
- `apps/editor/src/lib/layers/LayerList.svelte` — `moveByButton` is the function whose behaviour the riskiest tests assert.
- `packages/core/vitest.config.ts` — read the `optimizeDeps.include` note for the browser-mode failure this move should be escaping, not inheriting.

Choose a DOM implementation and add it to the catalog in `pnpm-workspace.yaml` with a justification comment, per ADR-0019.

## Contract

**Rename the project.** `editor-browser` is no longer true. Something like `editor-dom`, and the file suffix moves with it — pick one suffix and make the `include`/`exclude` globs of both projects agree, or the Node-without-DOM project will try to render a component and fail with `document is not defined`, which reads as a broken test rather than a misrouted one.

**The client Svelte runtime is not optional.** Compiled for the server, `derived` outside a render is an uncached thunk re-invoked on every read, so a reactivity assertion passes whether the runes work or not. Whatever the new project's environment, verify the emitted import is `svelte/internal/client`.

**Verify the divergences before porting, and write down what you find.** At minimum:

1. **Focusability of a disabled control.** Several ported claims turn on it — "at the bottom of the stack Move down is disabled, so the keyboard is handed the other half of the same control". Write a throwaway probe: render a disabled `<button>`, call `.focus()`, read `document.activeElement`. A real browser refuses; if the DOM implementation allows it, that claim **goes back to Seam 2** and is not asserted here.
2. **Accessible-name computation**, as used by `toHaveAccessibleName('Name of Layer 1 of 2')`.
3. **Focus after a keyed node moves** — the behaviour `moveByButton` exists for.

**Address elements by position, never by a held locator.** A locator captured from an `.all()`-style call binds to the element's accessible name, and the disclosure button's name changes from "Open — Notes" to "Close — Notes" when clicked, so a held locator stops matching the moment it does its job and fails as "cannot find element" on a row that is plainly open. This cost a debugging cycle already; the existing test file carries the note.

**The boundary of this seam, restated so it cannot erode.** Belongs here: a row's text for a given state; which control holds focus after a move or delete; what a live region announces; whether a disclosure is a real toggle; whether a control is offered for one Layer kind and not another. Never belongs here: MapLibre layer order or paint, bytes on disk, service workers, Published Site paths, OPFS. Each of those asserted here would be asserted against the props the test passed in.

⚠ **When the DOM implementation proves insufficient, the answer is Seam 2 — not a browser-mode component tier.** That would be a fake with a browser attached: most of Seam 2's cost, less of its truth.

### User Stories

3, 7, 8, 19, 41, 42, 43.

## Out of scope

- Migrating any further Seam 2 tests. This ticket ports the thirteen that exist and changes nothing about coverage.
- Touching `packages/core`'s browser project. Its two engines exist because OPFS has no Node implementation and SPEC story 4 is a cross-engine claim; none of that argument reaches here.
- Adding a component-testing library beyond what rendering Svelte in Node requires. ADR-0016 bans a headless component library in the *product*; a test-only renderer is not that, but the justification belongs in the catalog comment.
- Changing `LayerList.svelte` to make it easier to test. If a claim needs a prop or a `data-testid` the component does not have, that is an application change and needs its own justification.

## Acceptance criteria

- [ ] The component project runs with no browser process.
- [ ] All thirteen existing claims either pass in Node or are recorded as returned to Seam 2, each with the divergence that sent it back.
- [ ] The divergence probe results are written into the project's configuration header — what was tested, what the DOM implementation does, and what that means for this seam.
- [ ] Each ported test is watched to fail once against a deliberately broken component, and the mutation used is noted in the commit.
- [ ] The emitted Svelte runtime is the client one, verified rather than assumed.
- [ ] `pnpm precommit lint check test` passes; the component suite's wall time is recorded and compared with the 993ms browser-mode baseline.

```bash
pnpm --filter @ballastella/editor exec vitest run --project editor-dom
ps aux | grep -c "[c]hromium"     # unchanged while the above runs
pnpm precommit lint check test
```

Success: the component project reports its tests passing with no browser launched; `precommit` exits 0; the configuration header names the divergences found.

## Blocked by

- 01

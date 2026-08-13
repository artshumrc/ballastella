# The suite runs in three minutes — specification

## Problem Statement

Running the tests costs thirteen minutes, and every contributor pays it on every change.

Measured on `main` at 2026-08-13, on a 20-core Linux box that is not otherwise idle: `pnpm test:e2e` is **13 minutes 4 seconds for 675 tests**. Everything else in the gate is fast — lint 15.6s, check 10.3s, and **2099 Vitest tests in 11 seconds**. The whole problem is Seam 2.

The cost is not that Playwright is slow. It is that Seam 2 is being asked for work that does not need it. A Seam 2 test boots the built application, starts a real MapLibre over software-rasterised WebGL, and drives real OPFS — roughly a second per test averaged across the suite, and **~11.8 worker-seconds per test** in `editor-annotations` and `editor-layers`. A great many of those tests then assert something that never needed any of it: the text of a sidebar row, which control holds focus after a delete, whether a bundle with no `project.json` is refused, what an unrecognised Base Map id falls back to.

**The reason they live there is that until now there was nowhere else to put them.** `apps/editor` had a Vitest project with `environment: 'node'` and no DOM at all, so every claim about a *rendered* thing had exactly one home. There was no seam between "a class with no DOM" and "the entire application", and 675 browser tests is what that gap looks like after eighteen tickets.

The consequences are the ordinary ones and they compound. A contributor runs the suite less often than they should. An agent working this repository burns a quarter of an hour to learn it broke one assertion. The gate is long enough that "I'll let CI tell me" becomes reasonable, which moves every discovery an hour later. And the suite's own flake budget is harder to reason about the longer a run takes, because a rate is only as trustworthy as the number of runs anyone is willing to do.

## Solution

**Move the claims down a seam. Do not delete them, and do not remove Seam 2.**

That sentence governs this epic and every ticket in it. The output is not a smaller suite; it is the *same body of claims* asserted where each one belongs, with Seam 2 left holding the ones that genuinely need a browser — smaller, sharper, and still the place the application is proved to work. A ticket that reports a saving by deleting coverage has not done the work; it has moved the cost onto whoever finds the regression.

The mechanism: put every claim at the highest seam **at which it can still fail for the right reason**, and no higher.

That is the existing rule in [CONTRIBUTING](../../CONTRIBUTING.md) and in [ballastella-v1's Testing Decisions](../ballastella-v1/SPEC.md#testing-decisions), applied where it has not been. It is emphatically *not* "prefer unit tests". A claim about a Published Site served at two base paths, about MapLibre's own layer order, about OPFS surviving a reload, or about a service worker, belongs in Seam 2 and stays there — asserting any of those one seam down would assert it against a fake, which is the vacuous green this repository's testing decisions exist to prevent.

What changes is that a claim about **the interface's own behaviour** now has somewhere to go: a component-and-DOM seam for `apps/editor`, rendering one Svelte component against props and fakes. A test there costs milliseconds against ~4 seconds at Seam 2 — the first thirteen written cost 993ms in total, replacing six Seam 2 tests that cost about 70 seconds between them.

⚠ **This seam runs in Node against a DOM implementation, not in a real browser.** The first cut of it was built in Vitest's browser mode (Chromium, via the provider `packages/core` already uses) because that was the shortest path from the existing configuration. That is not the target: a browser process per run is the cost this epic exists to stop paying, and a component rendered against props has nothing in it that needs a GPU. Converting it to Node is ticket work, with the fidelity caveats set out under *Implementation Decisions*. Where a claim genuinely needs what a DOM implementation only approximates, it does not get promoted to browser mode — it stays at Seam 2, where the browser is real rather than nearly real.

Alongside that, two scheduling faults were found and fixed, and one measurement in the repository was found to be wrong:

- **`fullyParallel` was never set.** Playwright was parallelising across *files* and running each file's tests serially in one worker, so a run could never finish faster than its longest file — 63 tests deep. Turning it on took `viewer-reader` from about four minutes to **40 seconds** and `editor-alignment-refinement` from 2m25s to **33s**.
- **The recorded "eight workers measured 19% faster, so the suite is near this CPU's ceiling" was measuring the scheduling, not the processor**, because it predates `fullyParallel`. Re-measured properly: 4 workers 314s against 10 workers 206s on a heavy 156-test sample. Sublinear, but for the real reason — every test drives a software-rasterised WebGL context.
- **A Historical Map's pyramid was rebuilt through the interface once per test** in the alignment family. It is now recorded once per build and written straight into OPFS.

Those three together took the full suite from 13m04s to **10m55s — 16%**. That is the whole of what configuration can buy, and it is recorded here so nobody looks for a fourth such win. **The remaining 75% has to come from moving claims down a seam**, one file at a time, and this epic is that work.

The target is **150–250 Seam 2 tests and a suite that finishes in two to three minutes**, with a fence that stops it growing back.

## User Stories

1. As a contributor, I want the whole gate to finish in about three minutes, so that I run it before every commit instead of hoping CI will tell me.
2. As a contributor, I want to run one spec and get an answer in under a minute, so that a tight edit-test loop is possible at Seam 2 at all.
3. As a contributor, I want a claim about a rendered row to be assertable without booting the application, so that writing the test is cheaper than not writing it.
4. As a contributor, I want a claim about MapLibre's layer order to stay at Seam 2, so that I am never shown a green test that was asserted against a fake.
5. As a contributor, I want each retired Seam 2 test rehoused rather than deleted, so that "faster" never quietly means "less covered".
6. As a maintainer, I want Seam 2 kept and kept meaningful, so that the application is still proved to work against real MapLibre, real OPFS and a real static server.
7. As a contributor, I want the component seam to run in Node without a browser process, so that the seam I am asked to move work into is not carrying a scaled-down copy of the cost I am moving away from.
8. As a contributor, I want the DOM implementation's known divergences written down and verified, so that I learn where it lies before I trust a migrated claim rather than after.
9. As a reviewer, I want a migrated test's new home to name what it no longer covers, so that I can see the seam boundary rather than infer it.
10. As a reviewer, I want the count of Seam 2 tests to be fenced, so that the suite cannot drift back to thirteen minutes one ticket at a time.
11. As a maintainer, I want the measured before-and-after of every change in this epic recorded, so that the next person does not re-derive it or trust a number that was never measured.
12. As a maintainer, I want a wrong measurement in the repository corrected in place, so that a future decision is not made from it.
13. As an agent working this repository, I want a fast gate, so that a fifteen-minute wait does not dominate a task that took two minutes to do.
14. As a scholar, I want the application's behaviour to be unchanged by all of this, so that a test refactor is invisible to me.
15. As a contributor, I want the pyramid a test needs to be seeded rather than built, so that a test about undo does not pay for the tiler.
16. As a contributor, I want the seeded pyramid to be the bytes this build's ingest really produces, so that a byte-identity assertion still compares the application against itself.
17. As a contributor, I want the recording keyed to the build fingerprint, so that changing the tiler cannot leave a stale fixture passing.
18. As a contributor, I want tests whose subject *is* the ingest to keep driving the real file picker, so that the recording stays honest.
19. As a contributor, I want a component test to render against a real parent when the component's behaviour depends on the parent updating, so that a focus assertion tests what the application does rather than what the test arranged.
20. As a contributor, I want to know which specs cost the most per test, so that I cut by time rather than by count.
21. As a contributor, I want the Historical Map and Annotation specs addressed first, so that the largest concentration of cost goes first.
22. As a contributor, I want reordering, focus restoration and announcement assertable at the component seam, so that story 53's keyboard contract is cheap to keep.
23. As a contributor, I want a Layer row's warning text assertable at the component seam, so that "as text and not as a colour" costs milliseconds.
24. As a contributor, I want malformed-bundle refusals assertable at Seam 1, so that eight parsing claims stop booting a browser.
25. As a contributor, I want Base Map catalog resolution and fallback assertable at Seam 1, so that an id-to-style decision is not a browser test.
26. As a contributor, I want offline-cache tile counts and byte estimates assertable at Seam 1, so that arithmetic is not driven through a map.
27. As a contributor, I want the Markdown sanitiser's payload matrix asserted once, so that the same pure function is not tested through three interfaces.
28. As a contributor, I want one Seam 2 test proving the sanitiser is actually wired into the Annotation popup, so that moving the matrix down does not leave the wiring unasserted.
29. As a contributor, I want the remote and GitHub flows assessed for what genuinely needs a browser, so that 78 map-free tests are not assumed to be cheap or assumed to be dear without measurement.
30. As a contributor, I want near-duplicate keyboard tests kept only where the widget is custom, so that the platform's own `<dialog>` and `<select>` are not re-tested in every spec.
31. As a contributor, I want the Reader's Published Site coverage protected, so that ADR-0006's claim about relative paths at two base paths keeps its only possible seam.
32. As a contributor, I want the Base Map outage-notice sequence kept at Seam 2, so that a real state machine over real network conditions is not mocked into agreement with itself.
33. As a contributor, I want warped-render and Resource Mask coverage kept at Seam 2, so that the renderer is still exercised by the thing that ships.
34. As a contributor, I want service-worker and PWA coverage kept at Seam 2, so that an update prompt is never asserted against a stub.
35. As a contributor, I want byte-identity-on-disk claims moved carefully or not at all, so that the folder-is-the-product discipline survives the refactor.
36. As a contributor, I want a per-spec cost profile available, so that a later ticket can target the next worst file without guessing.
37. As a contributor, I want the worker count overridable, so that an idle machine can buy 1.5× without imposing it on a shared one.
38. As a contributor, I want `fullyParallel`'s consequence documented, so that a spec needing ordered tests declares it rather than inheriting it by accident.
39. As a maintainer, I want the one failing test on `main` fixed or explicitly quarantined, so that a red gate is not normalised while the suite is being reworked.
40. As a maintainer, I want the long-standing `viewer-reader` flake investigated rather than absorbed into the retry budget, so that the budget keeps meaning something.
41. As a contributor, I want the component seam's boundary written down, so that it does not become a cheaper Playwright and start asserting integration against mocks.
42. As a contributor, I want the component seam to avoid browser mode's dependency-optimisation hang rather than inherit its workaround, so that nobody pays the forty minutes that cost `packages/core` a run.
43. As a contributor, I want component tests to address elements by position rather than by held locator, so that a control whose accessible name changes when clicked does not fail as "cannot find element".
44. As a maintainer, I want the two-tier split explicitly rejected in writing, so that it is not proposed again as a shortcut.
45. As a maintainer, I want the epic to record what it cost, so that the next planner knows the real ratio of work to saving.

## Implementation Decisions

### The seams, and why there are now four

| Seam | Runs in | Costs | Answers |
| --- | --- | --- | --- |
| **1 — application logic** | Node, in-memory `ProjectStore` | ~5ms | "after this sequence, the store contains these files with this content" |
| **1b — storage backends** | Chromium + Firefox | ~50ms | OPFS and File System Access, which have no Node implementation |
| **1c — the editor's own interface** *(new)* | **Node, with a DOM implementation** | ~5–10ms | what one component renders, announces, and focuses |
| **2 — the running app** | Chromium, built output | ~1000–11800ms | the application with its real dependencies underneath it |

Seam 1c is the only addition, and adding a seam is a cost this epic accepts deliberately: it is the seam whose *absence* produced the problem. `packages/core`'s own note already records why 1b exists (there is no OPFS in Node) and why it is only that project. 1c's justification is the mirror image — there is no DOM in the editor's node project, and Svelte's client runtime compiled for the *server* is not a stand-in for one. The existing `environments.ssr` note in that project is the proof: compiled for the server, a `derived` becomes an uncached thunk that recomputes on every read, so every reactivity assertion passes whether the runes work or not.

**Node, not a browser, and this is a deliberate reversal of the first implementation.** Seam 1b runs in real engines because its whole subject is a storage backend that only a real engine has. Seam 1c has no such subject: a component rendered against props touches no OPFS, no WebGL, no service worker. Paying for a browser process to find out what a `<li>` says is the same category of overspend as paying for the built application to find out the same thing, one order of magnitude down.

### What a DOM implementation gets wrong, and what that costs

A DOM implementation *is* a fake, and this repository's standing rule is that a fake agreeing with itself is not a test. So the boundary is drawn by where the fake is known to diverge rather than by hope:

- **Focusability is the known risk.** Several migrated claims turn on which control holds focus after a move or a delete, and specifically on a *disabled* button being skipped — "at the bottom of the stack Move down is disabled, so the keyboard is handed the other half of the same control". Whether a given DOM implementation refuses `focus()` on a disabled element is exactly the sort of rule such implementations get approximately right. **The first ticket verifies this directly** — focus a disabled button, assert `document.activeElement` did not move — and a divergence sends that claim back to Seam 2 rather than being worked around.
- **No layout.** No `offsetWidth`, no scroll geometry, no visibility derived from paint. Any claim of the "does not widen the page" or "is readable inside the viewport" family stays at Seam 2, where there is a viewport.
- **Accessible-name computation is a library's approximation** of what a real accessibility tree yields. It is good enough for "this field is named *Name of Layer 1 of 2*"; it is not good enough to be the only place an accessibility claim is asserted, which is why the keyboard-and-announcement coverage at Seam 2 is thinned rather than emptied.

Each migrated claim is watched to fail once against a broken component before it is trusted, which is what separates "the DOM implementation agrees with the test" from "the component behaves".

**The rule that decides which seam a claim goes to is not "prefer the lowest".** It is: *the highest seam at which this claim can still fail for the right reason.* A claim that would pass at Seam 1c whether or not the application wires the component up belongs at Seam 2.

### The boundary of Seam 1c, stated so it cannot erode

Belongs at 1c: a row's text for a given state; which control holds focus after a move or a delete; what a live region announces; whether a disclosure is a real toggle; whether a control is offered for one Layer kind and not another; whether an empty state names the actions that exist.

Does **not** belong at 1c, ever: anything about MapLibre's layer order or paint; anything about bytes on disk; anything about a service worker; anything about a Published Site's paths; anything about OPFS. Each of those, asserted here, would be asserted against the props the test passed in.

⚠ **A component test is not a cheaper Playwright test.** It is a different question. When the two would assert the same sentence, they are not duplicates — the Seam 2 one is asking whether the application is wired up and the 1c one is asking whether the component behaves, and retiring the wrong one leaves a gap that no count will show.

### The parent harness, and why `rerender` is not enough

`LayerList` does not reorder anything: it calls `onmove` and then, one microtask later, restores the keyboard to the button that moved. In the application the parent's `$state` updates *synchronously* inside `onmove`, so by the time that microtask resolves the keyed `{#each}` has already moved the node.

A test that awaited the click and then called `rerender` would reorder **after** that microtask, so focus restoration would run against the old order — reporting a focus bug the application does not have, or passing for a reason unrelated to the behaviour. So a component whose behaviour depends on its parent updating is tested under a **real parent component** holding `$state`, not under prop replacement from the test body.

### Retiring a Seam 2 test

**A Seam 2 test is retired by being rehoused, not by being deleted.** The default and overwhelmingly commonest path is (1); (2) is ordinary; (3) is rare and needs a reason a reviewer would accept.

1. An equivalent claim now exists at a lower seam, named in the retiring commit. **This is the path.**
2. The claim is genuinely covered by another Seam 2 test that remains, named — the near-duplicate case, e.g. four specs each re-testing that a native `<dialog>` closes on Escape.
3. The claim is being **dropped**, stated as such, with the reason and what is now unasserted.

⚠ **(3) is not a budget to spend.** Nothing in this epic obliges anyone to reach a test count by deleting; the number falls out of rehousing, and a ticket that finds itself deleting to hit a target has mistaken the target for the goal. The suite is allowed to end up larger in total tests than it started — Seam 1 and Seam 1c are nearly free — and what has to fall is *time at Seam 2*.

The measured ratio from the first file is **13 component tests written to retire 6 Seam 2 tests**. A plan that assumes retirement is deletion, and therefore free, will be wrong by about that factor.

### The fence

A check script, in the family of the existing `check-*` scripts that `pnpm lint` runs, refuses a Seam 2 suite larger than a recorded ceiling. Its failure message names the ceiling, the current count, and this spec. The ceiling is lowered by the tickets as they land and is never raised without a recorded reason — the point is that regrowth becomes a decision rather than an accretion.

A count is a proxy for time and an imperfect one. It is chosen over a wall-clock budget because a timing gate on a shared, unevenly-loaded box fails for reasons nobody can act on, which is exactly the argument `scripts/retry-budget.mjs` already records about a gate that fires on something nobody can fix.

### Scheduling, already landed

- `fullyParallel: true`. Consequence: tests in one file no longer share an order. Every spec here already builds its own Workspace and empties storage first, so nothing was inherited; a spec that *wants* ordering must say so with `test.describe.serial`, which is the honest spelling of a dependency that used to be free.
- `workers` stays at 4 by default, overridable by environment. The reason for 4 was the shared machine, not the benchmark, and that reason is unchanged.
- The obsolete 19% note is corrected in place with the re-measurement, because a wrong number left in a comment is a wrong decision waiting to be made.

### The recorded Workspace

A Historical Map's pyramid is captured once — through the real interface, by the real ingest — and replayed into OPFS for every test that needs a Project with a map already on disk.

- Keyed to the build fingerprint the e2e build already computes, so a changed tiler, serialiser or Project screen discards it.
- Cached per worker process and on disk; written by rename so concurrent first-runs cannot interleave.
- The fallback for a missing or damaged recording is the real ingest, which is correct however it got that way.

⚠ **Tests whose subject is the ingest must keep driving the real file picker.** They are what keeps the recording honest; if they are ever deleted, the recording starts asserting that a pyramid captured long ago still loads rather than that this build can make one.

### Priority order

By measured cost per test, not by count:

| Spec | Tests | Approx. worker-seconds each |
| --- | --- | --- |
| `editor-annotations` | 51 | ~11.8 |
| `editor-layers` | 36 *(from 42)* | ~11.8 |
| `editor-base-map` | 47 | — profile first |
| `editor-workspace` | 41 | — profile first |
| `editor-transfer` | 37 | — profile first |
| `editor-publish` | 30 | — profile first |
| `viewer-reader` | 63 | ~2.5 — **protect** |

The map-free remote family (`clone-remote`, `review-remote`, `remote-binding`, `github-signin` — 78 tests) is a large count and, on the evidence so far, a small cost. It is profiled before it is touched.

## Testing Decisions

### What makes a good test here

Unchanged from [ballastella-v1](../ballastella-v1/SPEC.md#testing-decisions), and this epic is an application of it rather than an amendment: assert what a user can observe and would notice if it broke; never assert internal call sequences, private state, or module structure. **The user's folder is the product**, so file contents are behaviour, not a proxy for it.

This epic adds one criterion, because it is the one a migration can violate: **a test must be able to fail for the reason its title gives.** A component test asserting that a Layer draws above another cannot fail for that reason — it can only fail if the array it was handed is in the wrong order. That test is worse than no test, because it reports coverage of something it never touched.

### The tests of this epic's own work

The changes here are to the test suite, so the ordinary question — how do we know this did not break anything? — is answered by the suite itself, plus:

- **The full suite, run end-to-end before and after each ticket**, with the counts and wall time recorded in the ticket. A ticket that reports a saving without both numbers has not measured one.
- **The failure profile must be unchanged.** Both the 13m04s baseline and the 10m55s run reported 1 failed and 1 flaky, which is what confirmed the failure was pre-existing rather than introduced. A ticket that changes the count of failures explains it.
- **Mutation of the new seam.** A component test that cannot be made to fail by breaking the component is not asserting anything; each migrated claim is watched to fail once, the way ticket 17's fixes were.
- **The fence has a positive control** — a deliberately over-count run must fail it — in the family of `BALLASTELLA_E2E_RETRY_BUDGET=0` for the retry budget.

### Modules under test at each seam

Nothing new is under test. What changes is where existing claims are asserted:

- **Seam 1** gains: bundle validation refusals, Base Map catalog resolution and fallback, offline-cache tile counts and byte estimates, Markdown sanitiser payloads, Layer-document write counting, simplestyle emission.
- **Seam 1c** gains: Layer row rendering and warnings, disclosure behaviour, reorder focus restoration and announcement, per-kind control offering, list structure and accessible naming, dialog focus restoration.
- **Seam 2 keeps**: warped rendering and layer order, Resource Mask editing, OPFS through the built app, the Published Site at both base paths, Base Map outage notices, service worker and PWA, the ingest itself, and every byte-identity claim not demonstrably safe to move.

### Prior art

- The editor's existing node project is the model for 1c's configuration — in particular its `environments.ssr` note, which is the same problem in a different guise: getting the *client* Svelte runtime is what makes a reactivity assertion mean anything, and it is not something a config gets right by default.
- `packages/core`'s browser project is the model for what 1c should **not** need. Its `optimizeDeps.include` note — a forty-minute hang from Vite re-optimizing mid-run — is a browser-mode failure mode, and moving 1c to Node is partly an escape from that class of problem rather than an inheritance of it.
- `e2e/support/reader-project.ts` is the model for a fixture written as literals, and its header carries the argument for why a fixture built from the application's own functions agrees with itself however wrong both are — which is precisely why the recorded Workspace is a **recording** rather than a construction.
- `scripts/retry-budget.mjs` is the model for the fence: a gate that prints per-event detail, reports a rate, and carries its own argument for the threshold.
- `e2e/support/network-fence.ts` and `scripts/check-e2e-network-fence.mjs` are the model for a rule enforced by a seam plus a script rather than by discipline.

## Out of Scope

- **Removing Playwright, or removing Seam 2.** Not a goal, not a stretch goal, not an eventual direction. Seam 2 is the only place the application is proved to work with real MapLibre, real OPFS, a real service worker and a real static server underneath it, and this epic makes it smaller precisely so that what remains there is worth the minutes it costs. A future ticket proposing to finish the job by deleting the rest has misread this document.
- **Promoting a Seam 1c claim to a browser-mode component project when a DOM implementation proves insufficient.** The two answers are Node or Seam 2. A third, browser-mode-but-not-the-app tier would be a fake with a browser attached — most of the cost of Seam 2 and less of the truth.
- **Any change to application behaviour.** If a migration wants a `data-testid` or a prop the component does not expose, that is a change to the application and needs its own justification; it is not smuggled in as test scaffolding.
- **The two-tier split** — a fast default plus a `--project=full`. Explicitly rejected. A "full" tier that only runs in CI is deleted local coverage with a reassuring name, and selecting a fast tier by *speed* optimises the wrong axis. It was recommended twice during the investigation and withdrawn once `fullyParallel` had already delivered the inner-loop win it was meant to provide.
- **A map-abstraction layer.** ADR-0019's argument stands: inventing a boundary purely to enable testing would test a fake instead of the thing that ships.
- **Pixel-comparison rendering tests**, per ballastella-v1.
- **Cross-engine Playwright.** Seam 1b's two engines cover the storage claim; a second engine at Seam 2 is a separate decision and would move this epic's number the wrong way.
- **Dropping Firefox from Seam 1b.** Tried and reverted: it saves 2.6 seconds and costs the local half of SPEC story 4. Vitest was never the problem.
- **Raising the default worker count.** Available by environment; the shared-machine reason for the default is not this epic's to overturn.
- **Fixing the `editor-remote-binding` failure and the `viewer-reader` flake.** Both are recorded below and both predate this work. They need doing, but folding a product investigation into a test-speed epic is how an epic stops finishing.

## Further Notes

### The numbers, so nobody re-derives them

| Measurement | Value |
| --- | --- |
| Full suite, clean `main` | 675 tests, **13m 04s** |
| Full suite, after scheduling + recorded Workspace + first migration | 669 tests, **10m 55s** (−16%) |
| Vitest, whole workspace | 2099 tests, **~11s** |
| Heavy three-spec sample, before | 156 tests, 6m 18s |
| Heavy three-spec sample, after | 150 tests, 4m 43s (−25%) |
| Same sample, 4 workers → 10 workers | 314s → 206s (1.5×) |
| `viewer-reader` alone, before → after | ~4m → **40s** |
| `editor-alignment-refinement` alone, before → after | 2m 25s → **33s** |
| Seam 2 fixed startup floor, warm build | ~5s |
| First 13 component tests, in browser mode | **993ms** |
| Same, expected in Node with a DOM implementation | to be measured by the converting ticket |

### Three estimates that were wrong, and how

Recorded because each was stated confidently before being measured, and two of them shaped a recommendation:

1. **"The in-browser ingest costs 15–25s per test."** It cost 2–3s. The pyramid was never the dominant cost; the application boot was.
2. **"The full suite takes about 20 minutes."** Extrapolated from the first 126 tests of a killed run, which over-weighted server boot and a front-loaded set of heavy specs. It was 13m04s.
3. **"`fullyParallel` is the dominant win."** It is dominant for a *single file* — up to 4.4× — and worth only about 16% across 35 files, because file-level parallelism was already keeping four workers mostly fed. The per-file figure was quoted as though it were a suite figure.

The pattern in all three is the same: a per-file or partial measurement generalised to the whole. **Every claim of saving in this epic is to be made from a full-suite run, before and after.**

### Two open faults, both predating this epic

- **`editor-remote-binding` › "shows no sign-in affordance anywhere" fails on `main`.** A visible element matching `/GitHub/i` is present on a first visit. Reproduced on clean `main`, in isolation, with and without `fullyParallel`, and it fails its retry — so it is deterministic, not flake. It is a product question (ADR-0031, ADR-0032 territory), not a suite question.
- **`viewer-reader` › "tells a server that is failing apart from a connection that is gone" is habitually flaky.** It retried in three of the runs taken during this investigation, including on clean `main`. A test that needs its retry habitually is exactly what the retry budget's own note says the budget still catches, and it should be explained rather than tolerated.

### What the epic is likely to cost

The first file took 13 component tests, one parent harness, and a support module to retire 6 Seam 2 tests, and the honest read of that is that this is **days of work, not hours**. Planning against a per-file saving of "delete N tests" will be wrong by roughly a factor of two in effort. The compensation is that the saving is permanent and the coverage moves rather than evaporates.

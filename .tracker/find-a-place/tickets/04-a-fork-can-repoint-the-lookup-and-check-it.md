# A fork can repoint the lookup and check it

## What to build

Everything the person hosting an instance needs, and nothing a scholar ever sees: a fence keeping the service address in one module, a deploy that says the default service is borrowed without failing, a hand-run check that says whether the configured service actually answers, and documentation telling them all three exist.

Demoable for that actor end to end: edit one line, run one command, get a real answer about whether it worked.

Read [`SPEC.md`](../SPEC.md) and [ADR-0029](../../../docs/adr/0029-place-lookup-is-a-warned-service-that-leaves-nothing-behind.md) first. **The ADR's argument for why this warns where the Base Map fails is the load-bearing part of this slice**, and you will be tempted to "fix" the inconsistency. Do not.

## Where to start

- **The configuration module slice 1 added**, in the domain package, holding the service address and its attribution.
- `scripts/check-base-map-catalog.mjs` — **the script to model yours on.** Read three things: the `UNCONTROLLED_HOSTS` comment on why a fence that goes green because the thing it describes *moved* is worse than no fence; the containment scan below it; and the comment at `let failed = false` recording that `--deployment` is a **mode** of one check rather than a second check — exiting early is how `pnpm check:deployment` once came to skip the containment scan entirely.
- `scripts/check-deployment-runs.test.mjs` — how a check script is tested under `node --test`.
- `scripts/check-e2e-network-fence.mjs` and `scripts/check-viewer-deps.mjs` — two more scripts in the `lint` chain, for the idiom.
- `package.json` — `lint` is a chain of `node scripts/*.mjs`; `check:deployment` is currently `check-base-map-catalog.mjs --deployment` **alone**, and must become a composite without losing the Base Map's failure.
- `docs/hosting.md` — part 1 step 4 ("Decide about the Base Map") is the section yours sits beside, and "Known gaps" at the end is the list it joins.
- `docs/adr/0025-no-base-map-ships-offline-is-per-project-and-opt-in.md` and `docs/adr/0020-base-map-catalog-author-default-and-reader-switching.md` — the decisions the Base Map's own fence implements.

## Contract

**The containment scan fails `pnpm lint` if any module outside the configuration module names the service host.** This is what makes "change this file, and nothing else" a property rather than a hope, and it is the property a fork pointing at their own service depends on.

> The scan is for **the address**. It is **not** a fence on who may import the lookup module — that was considered and declined in ADR-0029, because two surfaces import it legitimately and an autocomplete implementation would import it just as legally.

**`pnpm check:deployment` warns about the borrowed lookup service and exits 0.**

**And it still fails for a borrowed Base Map archive.** Both halves matter. A composite that short-circuits on the first check would pass a test written for either half alone — which is exactly the defect the existing script's own comments record having had.

**Do not make the lookup warning into a failure.** ADR-0029's reason is that repointing an archive means putting a file in a bucket, while repointing this means running a planet-scale geocoder — days of compute, hundreds of gigabytes, permanent diff replication. Almost no fork can. **A check that fails with a remedy nobody can take is a check people learn to route around, and it would corrode the Base Map check standing beside it, which people *can* satisfy.**

**`pnpm check:places` is new, hand-run, and outside `lint` and outside CI.** It issues one query against the configured service and asserts the fields the app depends on are still present — the point, the bounds, and the display name. It is the **only** thing in this repository permitted to reach the network, and being outside every gate is *why*.

It exists because a fixture is a snapshot of an assumption. This repository has been bitten by that class before: a borrowed archive did not change shape, it vanished, and nothing in the suite could have said so.

**`docs/hosting.md` gains the service** beside its Base Map section, and the borrowed default joins its "Known gaps" list. Say plainly that this one **warns** where the Base Map **fails**, and why — otherwise the difference reads as an inconsistency in the tooling rather than a decision. Three SPEC user stories are written for somebody who reads that document and nothing else.

## Out of scope

- **Anything a scholar sees.** No component, no field, no sentence in the app.
- **Changing `catalog.ts`, or the Base Map's own check behaviour.** The composite *calls* the existing scan; it does not modify it.
- **Adding `check:places` to `lint`, to `test`, or to CI.** If it is in a gate, a stranger's uptime can turn this repository red, which is the standing rule's whole subject.
- **Making the lookup warning fail.** Named again because it is the single most likely wrong turn in this slice.
- **A proxy, or a caching layer.** The service's policy recommends both for bulk use; there is no server here and no bulk use.
- **Provisioning an actual service.** That is a human decision with a budget attached, exactly as the Base Map archive is.

## Acceptance criteria

- [ ] `pnpm lint` fails when a module outside the configuration module names the service host. **Asserted by planting one, confirming red, and removing it.**
- [ ] `pnpm lint` passes on the tree as it stands.
- [ ] `pnpm check:deployment` **prints a warning naming the borrowed lookup service and exits 0** while the default is configured.
- [ ] `pnpm check:deployment` **still exits non-zero** for a borrowed Base Map archive. **Both halves asserted**, under `node --test`, in the same way `check-deployment-runs.test.mjs` already covers the existing check.
- [ ] `pnpm check:places` exists, reaches the configured service, and reports usefully when it does not answer.
- [ ] `pnpm check:places` appears in **neither** `lint`, `test`, nor any CI workflow — asserted by reading `package.json` and `.github/workflows/`, and stated in the report.
- [ ] `docs/hosting.md` tells someone hosting an instance where the service is configured, that the default is borrowed, that the check warns rather than fails, and why.
- [ ] The borrowed lookup service appears in `docs/hosting.md`'s "Known gaps".
- [ ] The mutation check is recorded per criterion. **Report any surviving mutation as green, with its reason.**

```sh
pnpm lint
pnpm check:deployment; echo "exit: $?"
pnpm check:places; echo "exit: $?"
node --test scripts/*.test.mjs
pnpm check && pnpm -r build && pnpm -r test
```

`pnpm lint`, `node --test`, `check`, `build` and `test` all exit 0. `pnpm check:deployment` exits **0** with a warning on this tree. `pnpm check:places` reaches the network by design and is the one command here that is not a gate — report what it said.

**Read exit codes directly.** Never pass `--reporter=`. Do not pipe gate output through `grep`.

## Blocked by

- Slice 1 — [`01-find-a-place-and-go-to-it.md`](./01-find-a-place-and-go-to-it.md)

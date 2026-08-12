# Tracker for find-a-place

## Purpose

A scholar can type a place name and either move the map to it or drop a Pin at it. The service that answers is deployment configuration that warns rather than fails, and **nothing it returns is recorded in a Project's files** — a Pin placed from a lookup is byte-identical to one drawn by hand.

Scope, user stories, and the testing approach are in [SPEC.md](./SPEC.md). The decisions this epic implements are in [ADR-0029](../../docs/adr/0029-place-lookup-is-a-warned-service-that-leaves-nothing-behind.md), which was written before any ticket and is the reference for every "why is it like that" question below.

## Current status

Overall status: `In Progress`

Current ticket: 01 — the tracer bullet.

Last updated: 2026-08-12.

## What is already decided — do not re-derive it

Twelve decisions came out of a design interview on 2026-08-11 and are recorded in ADR-0029. The ones most likely to be re-opened by an implementer acting reasonably:

- **Nothing is tracked.** No provenance property, no "unsettled" flag, no new `OverlayPointKind`. The best version of this — a scholar-owned "I have not checked this yet" flag that self-clears — was argued for and **declined as disproportionate** (human decision). It is not an oversight and re-proposing it is a new decision.
- **The bounding box reaches the camera and never the file.** A placed Place is a `Point`. Rectangles do not become polygon Annotations, and real administrative boundaries are declined on ODbL grounds, not deferred.
- **The deployment check warns and stays green** for the lookup service, while it still *fails* for the Base Map archive. That asymmetry is deliberate: forks cannot realistically run their own Nominatim, and a check nobody can satisfy corrodes the one next to it that they can.
- **Submit-only is contingent, not a law.** It is what the default service's policy requires; it is not a claim that autocomplete is wrong. Record it that way in any comment.
- **The published viewer never gets this.** `ReaderMapPane` is "the same picture with authoring attached" and will look like an oversight. It is not.

## Standing constraints

Carried from `nothing-fails-silently` and `workspace-and-layers`, where each was paid for.

- **The mutation check is mandatory.** Break the behaviour, confirm the test goes red, restore, and record what you broke. Two-axis review found real defects after a green report in sixteen of sixteen tickets in `workspace-and-layers`.
- **No test may depend on the network.** Enforced by the composed root fixture in `e2e/support/network-fence.ts` and by `scripts/check-e2e-network-fence.mjs`. Drive every lookup from a committed fixture.
- **Never pass a reporter override on the command line.** It silently disables the retry budget. Read exit codes directly; do not pipe gate output through `grep`.
- **The failure mode is claims outrunning code.** If something is left open, say so plainly rather than describing it as closed.
- **Two assertions in this epic pass vacuously if written naively** — "typing issues zero requests" and "the two empty-list outcomes say different things". Both are called out in the tickets that own them. Mutate them specifically.

## Seams

Agreed with the repository owner before the spec was written, and **no new seam is to be introduced**:

- the **browser suite** for everything a scholar does — the primary seam, and the only honest home for the three counted claims (zero requests while typing, one store write per placement, byte-identical output);
- the **domain package's node project**, narrowly, for the outcome-to-sentence table and the rate limiter;
- the **script suite**, pre-existing, for the lint containment scan and the deployment checks.

## Ledger

| Number | Filename | Status | Depends On |
| --- | --- | --- | --- |
| 01 | [01-find-a-place-and-go-to-it.md](./tickets/01-find-a-place-and-go-to-it.md) | In Progress | — |
| 02 | [02-a-failed-lookup-says-which-failure-it-was.md](./tickets/02-a-failed-lookup-says-which-failure-it-was.md) | Not Started | 01 |
| 03 | [03-place-a-pin-at-a-place.md](./tickets/03-place-a-pin-at-a-place.md) | Not Started | 01 |
| 04 | [04-a-fork-can-repoint-the-lookup-and-check-it.md](./tickets/04-a-fork-can-repoint-the-lookup-and-check-it.md) | Not Started | 01 |

## Ordering

**01 is the tracer bullet and gates everything.** It establishes the configuration module, the lookup, and the search surface, and is demoable on its own: type a place name, the map goes there.

**02, 03 and 04 are parallel.** Each needs only what 01 establishes, and none needs anything from the others — so three implementers can take them at once once 01 lands.

01 is deliberately the largest. Building any of the others first would mean designing the search surface twice, and building 04 first would make the opening ticket a horizontal slice of deployment plumbing that demonstrates nothing.

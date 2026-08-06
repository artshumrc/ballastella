# The Workspace's Historical Maps on the hub

## What to build

The hub gains a list of every Historical Map in the Workspace: its label, its size, whether its tiles are here or on a Library's server, and which Projects use it. A map no Project uses can be deleted. A map in use cannot — the attempt is refused, naming the Projects that would break.

This is the one place a scholar can answer "why is my Workspace two gigabytes?", which today they have no way to ask.

Demonstrable end to end: from the hub, see three Historical Maps with sizes; one says it is used by two Projects and refuses to be deleted, naming them; one says no Project uses it and deletes, and the Workspace's total size drops.

## Where to start

- `apps/editor/src/lib/components/ProjectHub.svelte` — 383 lines: the Project list, create, rename, delete, publish, import. Read its delete flow for the confirmation pattern and its `ModalDialog` usage.
- `apps/editor/src/lib/editor-session.svelte.ts` — `images`, `referencedImages`, `remoteOrigins` (Workspace-wide after ticket 01), and `workspaceBytes()`.
- `packages/core/src/project/workspace-size.ts` — `workspaceSize`, `describeBytes`, `crossesHostingLimit`, `STATIC_HOSTING_LIMIT_BYTES`. **Note it uses `ProjectStore#size` and never `read`** — a mirrored pyramid is tens of thousands of files and opening each to add up lengths would make this the slowest thing in the application. Keep that discipline.
- `packages/core/src/project/workspace.ts` — `listProjects` and `readProject`, which is how "which Projects use this map" is answered.
- `packages/core/src/publish/publish.ts` — its size warning, which gains a line.
- The picker from ticket 06 — it already lists maps with labels and sizes. **Share the computation**, not the component: this list needs used-by and delete, which the picker must not have.

## Contract

> **From the review of ticket 01:** "is this Historical Map referenced rather than copied?" already has five implementations — `referencedImageIds` in `publish.ts`, `partitionByLocalCopy` in `referenced-image.ts`, `readMapLayer`'s 404 probe in the viewer's `project-documents.ts`, and the derived sets in the editor's `layers/+page.svelte` and the viewer's `+page.svelte`. One `referencedHistoricalMaps(store)` in core would serve all of them, and this ticket is the place to write it. Do not add a sixth.

**A new core function answers which Projects use which Historical Maps**, reading every `project.json` in the Workspace and returning, per image id, the Projects whose Layers reference it. It must not read any pyramid bytes. It is a pure-ish function over the store and belongs in core so both the hub and publish can use it.

**Deleting a Historical Map that is in use is refused, and the refusal names the Projects.** Not a confirmation dialog offering to cascade. One click that destroys three arguments is not a click this application has. The message names them; the user removes the Layers themselves if that is what they want.

**Deleting an unused Historical Map removes its pyramid, its `remote.json`, and its Alignment.** All three, or the Workspace keeps an orphaned Alignment for a map that no longer exists.

**Deletion is destructive and irreversible, so it confirms** — through `ModalDialog`'s `<dialog>` + `showModal()` (ADR-0016), naming the map and its size, exactly as Project deletion already does.

**Sizes come from `ProjectStore#size`, never `read`.**

**The list says where each map's tiles are** — in this Workspace, or on a named host. Derived, per ADR-0023: an `info.json` of ours means the tiles are here; only a `remote.json` means they are not. Never a stored flag.

**Publish's size warning gains a line naming the weight of unused maps.** Publishing is additive and cannot exclude them — they are already in the directory — so the ADR-0008 hosting warning must say so: "…including 340 MB of Historical Maps no Project uses." That sentence is what gives the reclaim list a reason to be visited.

**A Workspace with no Historical Maps says so, and names the next action** — which is to open a Project and add one, since ticket 18's decision is that maps are added from inside a Project.

## Out of scope

- **Do not add an Align button to this list.** Decided deliberately: alignment is reachable only from a Layer card, so there is exactly one answer to "how do I align this?", and so that an Alignment is always made against the Base Map of the Project whose argument it serves.
- **Do not add Historical Maps to the Workspace from here.** Adding happens inside a Project (ticket 06).
- **Do not build the Base Map cache row.** Ticket 11 adds it beside this list.
- **Do not implement any form of garbage collection, automatic cleanup, or "remove all unused" bulk action.** One map at a time, chosen by the user.
- **Do not change how Projects are created, renamed, deleted, or published.**
- **Do not read pyramid bytes anywhere in this slice.**

## Acceptance criteria

- [x] The hub lists every Historical Map in the Workspace with its label and its size.
- [x] Each entry says whether its tiles are in this Workspace or names the host they are on.
- [x] Each entry names the Projects that use it, and says plainly when none do.
- [x] Deleting a map used by two Projects is refused, and the message names both Projects.
- [x] Deleting an unused map removes its pyramid, its `remote.json`, and its Alignment, and nothing else.
- [x] Deletion confirms through a `<dialog>` opened with `showModal()`, closable by Escape, with focus restored afterwards.
- [x] Rendering the list issues no `read` calls against any pyramid — assert with a spy on `ProjectStore#read`.
- [x] The publish size warning names the byte weight of Historical Maps no Project uses, and that figure is zero when every map is in use.
- [x] A Workspace with no Historical Maps shows a sentence naming the next action.
- [x] The list and its controls are fully keyboard-operable.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm exec playwright test e2e/editor-workspace.e2e.ts e2e/editor-publish.e2e.ts
pnpm test:e2e
```

All green. The used-by computation and the refusal belong at Seam 1 — an in-memory `ProjectStore` with two Projects sharing an image id, asserting on the refusal and on the files that survive. The no-`read` criterion has prior art in `packages/core/src/publish/publish.test.ts`, which puts a spy on `read` to keep publishing from copying Project data.

The refusal criterion is the one that must not pass vacuously: assert the pyramid is **still on disk** after the refused deletion, not merely that a message appeared.

## Blocked by

- Ticket 01

## Implementation notes

Merged from `main` at `1bdc171` (ticket 01 merged). Three commits.

### What the consolidation became

`packages/core/src/project/historical-maps.ts` is the new home. The **rule** is `tileLocation({ infoJson, remoteJson })` and there is now exactly one of it; what differs between call sites is only the *observation* of its two inputs, and that genuinely does differ by backend:

- a store that can list walks `images/` once (`historicalMapFiles`), which is what the editor and publishing use;
- a store that cannot — ADR-0006's HTTP adapter — asks for the two files by name and reads the 404, which is the viewer's `readMapLayer`, unchanged in behaviour and now handing its two booleans to the same function.

The five spellings the review named are gone: `publish.ts`'s private `referencedImageIds` is `referencedHistoricalMaps`; `partitionByLocalCopy` **moved** out of `remote-iiif/referenced-image.ts` into this module (moved rather than delegating, because the reverse import would have made a cycle) and now routes through `tileLocation`; `readMapLayer` calls `tileLocation`; the editor's `layers/+page.svelte` takes `session.referencedImageIds` instead of building a set of its own; the viewer's `+page.svelte` projection is a three-state read of `documents`, which is viewer-only state, and it now consumes an observation the shared rule produced rather than making one.

Mutating `tileLocation` to answer `'in-workspace'` for both files turns six tests red across three files — the hub, publishing, and the referenced-image suite — which is the evidence that the single rule is genuinely load-bearing rather than a wrapper.

### Judgement calls worth a reviewer's attention

- **The list reads one small document per map** — `manifest.json` for a local copy, `remote.json` for a referenced one — because an image id is a random identifier (ADR-0015) and a reclaim list naming maps after hashes is unusable. The no-`read` criterion is asserted as written: the spy sees only `project.json` and those two records, and **never** a tile or an `info.json`. `unusedHistoricalMapBytes`, which publishing calls on every plan, skips the labels entirely and issues `size` calls only for the directories of maps nothing draws — usually none, so it is cheaper than `workspaceSize`.
- **A map's stated size includes its Alignment**, so the figure beside Delete is exactly what the Workspace total drops by.
- **Delete on an in-use map produces the refusal immediately, with no confirmation dialog.** A dialog asking "are you sure?" about something that will not happen is a lie. Only a map nothing draws reaches `<dialog>`. Either way the decision is core's, taken from the Projects' documents at the moment of the deletion rather than from the list on screen.
- **An image directory holding neither file is not a Historical Map** — the tiles of an interrupted ingest, consistent with `listIngestedImages`. It is not listed, not deletable, and not counted in the unused-bytes figure.

### Left for someone else

- **`ProjectHub.svelte`'s Delete Project dialog still says "Its Historical Maps, Alignments, and Annotations go with it."** ADR-0023 made that false — they are the Workspace's and survive — and it now sits a few lines above a list saying the opposite. Not changed here because "do not change how Projects are created, renamed, deleted, or published" is out of scope for this ticket. It is a one-sentence copy fix for whoever owns that dialog next.
- **`playwright.config.ts` pins the preview servers to fixed ports 4173/4174 with `reuseExistingServer: !CI`.** With several agent worktrees on one machine, a run silently reuses *another worktree's* server and tests that worktree's build — which presents as tests failing for no visible reason, or as `ERR_CONNECTION_REFUSED` when the other run finishes and kills the server. Verified by reading `/proc/<pid>/cwd` for the listener. Making the ports env-overridable would fix it; not done here because the config is shared and three sibling tickets are in flight.

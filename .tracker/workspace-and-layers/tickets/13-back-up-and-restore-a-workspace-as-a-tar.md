# Back up and restore a Workspace as a tar

## What to build

A scholar can write their whole Workspace to one tar file and read it back — on this computer or another one. This is the backup and the move-between-machines story, and for anyone on Firefox, Safari, or an iPad it is the only way their work leaves the browser.

Demonstrable end to end: back up a Workspace containing two Projects and a shared Historical Map; restore it in a fresh browser profile; find both Projects, one pyramid, and the Alignment intact.

Read [ADR-0024](../../../docs/adr/0024-backup-and-handoff-are-different-artefacts.md) first, especially why this is not a zip.

## Where to start

- `packages/core/src/transfer/export-project-zip.ts` and `import-project-zip.ts` — the shape to follow and the ceiling to escape. Read `MAX_ZIP_ENTRIES`' doc comment: `fflate` counts entries in sixteen bits, 70,000 entries produced an archive indexing 4,464, and `unzipSync` read it back as 4,464 files **with no error at all**. Note also `ALREADY_COMPRESSED`, which already skips deflating tiles — so compression was buying nothing.
- `ZIP_ENTRY_MTIME` and the reasoning for a constant timestamp — byte-reproducibility is what lets a test assert a round trip is lossless rather than merely plausible. Carry that property over.
- `packages/core/src/transfer/viewer-files.ts` — `isViewerFile`, `VIEWER_FILE_PATHS`, `PUBLISHED_SITE_RECORD_NAME`. The enumerable viewer file set is what a backup excludes.
- `packages/core/src/transfer/import-project-zip.ts` — `orderForWriting`, and why `project.json` is written **last**: an interrupted restore must leave orphaned files rather than a Project that lists on the hub with half its Layers missing. The first is litter; the second reads as the tool having eaten someone's work.
- `packages/core/src/project/project-file.ts` — `parseProjectFile` and `ProjectFormatTooNewError`, plus `reendFormatRefusal` in the zip importer, which re-ends the refusal message for the import path.
- The named-Workspace machinery from ticket 12 — restore creates one.
- `packages/core/src/project/workspace-size.ts` — for the pre-restore quota check.

## Contract

**`modern-tar` is the dependency.** Zero-dependency, Web Streams, USTAR with PAX extensions. **Verify its streaming and PAX behaviour before committing to it** — ADR-0024 justifies the whole format change on those two properties and they are taken from its documentation, not from measurement. If either does not hold, stop and escalate rather than working around it.

**Do not add a WASM tar implementation.** Tar is a 512-byte header layout, not a computation. Ticket 05 of v1 is still stalled because npm ships only a threaded `wasm-vips` build needing COOP/COEP headers a static host cannot send; a second WASM dependency on a path that must work on a static host would repeat that.

**Long paths are load-bearing and must be asserted, not assumed.** `<project-dir-up-to-64>/annotations/<uuid>.geojson` is about 121 characters, past tar's 100-character `name` field. A naive writer truncates or throws. Test with a **deliberately long Project name**, at the 64-character limit `toDirectoryName` allows.

**A backup is byte-reproducible.** Same Workspace, same bytes, twice — and after a round trip through restore. Use a constant entry timestamp for the same reasons the zip did: it makes losslessness assertable, and it refuses to imply that an archive carries useful times, since a Project's `updatedAt` lives inside `project.json` precisely because archiving destroys filesystem times.

**A backup excludes the published viewer files.** `index.html`, `_app/`, and `ballastella-site.json` are build output that `isViewerFile` already enumerates. Including them bloats every backup and restores a viewer bundle possibly older than the app, which ADR-0006 warns goes stale against its data. **The restore must say that a re-publish is needed** rather than letting the user hand out a stale site.

**Restore creates a new named Workspace and switches to it. It never overwrites and never merges.** Both real uses need this: a new computer has nothing to overwrite, and recovering from damage is the exact moment the damaged Workspace must survive, because the user cannot know what the backup predates until they have looked at both. Merging is the Alignment-collision problem in another hat.

**`project.json` files are written last**, per the existing importer's discipline, so an interrupted restore leaves litter rather than half-Projects.

**Quota is checked before restoring, not discovered at eighty per cent.** `navigator.storage.estimate()`; refuse legibly with the numbers.

**A newer `formatVersion` inside a backup is refused with the message naming where to get that version**, and nothing is restored — the same class and the same discipline the zip importer already applies.

**Restore streams.** The archive must not be held whole in the JS heap; that is half of what tar was chosen for, and it is what makes restoring a large backup on an iPad possible at all.

**The zip path for whole-Workspace transfer is removed.** Project-level zip export stays until ticket 14 replaces it with the bundle.

## Out of scope

- **Do not implement zip64.** The zip is going; do not fix it on the way out.
- **Do not build the Project bundle or Review Workspaces.** Ticket 14.
- **Do not offer merging, or an "overwrite my Workspace" option**, however much simpler it looks.
- **Do not include the viewer files** to make a restored Workspace immediately publishable.
- **Do not compress the tiles.** They are already-compressed JPEG; the existing exporter knows it.
- **Do not change the pyramid layout, `project.json`, or any document format.** This slice moves bytes.
- **Do not add cloud, drive, or sync integrations.**

## The `modern-tar` measurement, which came first

ADR-0024 justifies the whole format change on two properties of `modern-tar` that it took from the
README, and the epic's standing constraints forbade building on either unverified. **Both hold.** The
measurement is `packages/core/src/transfer/tar-format.test.ts` — a test rather than a paragraph, for
the reason ticket 11 made `tile-cache.test.ts` one, so a `modern-tar` upgrade that starts buffering
whole entries turns a suite red instead of turning a scholar's iPad restore into a crash. It imports
nothing from `packages/core`: it is about the library, and `workspace-tar.test.ts` is about what was
built on it. Measured at `modern-tar` 0.8.2:

| Claim | Measured |
| --- | --- |
| Streams while packing | 2,163,200 B already emitted downstream at the half-way point of writing one 4 MiB entry |
| Backpressure while packing | writer stops resolving after **8,323,072 B (7.94 MiB)** into a sink nobody reads — bounded, not unbounded |
| Streams while unpacking | header delivered immediately; with the body held unread the producer stalls **9.00 MiB** into a **64 MiB** entry, so entries are not buffered whole |
| Bounded across a whole archive | the producer never runs more than **~9 MiB** ahead of a slow consumer, whatever the archive's size |
| Custom PAX records | round-trip exactly through both readers, including NFD and Devanagari — this is what carries a folder Workspace's real name |
| Long paths | exact round trip at 100/101/256/257 bytes, at 121 B (`<64-char dir>/annotations/<uuid>.geojson`), and with no separator at all — USTAR `prefix` to 256 B, PAX `path` beyond |
| Non-ASCII | exact round trip for Devanagari, CJK, Arabic, and an astral emoji; the PAX pseudo-entry is not surfaced as a file |
| Entry ceiling | 70,000 entries written and **70,000 read back** — the number that made `fflate` produce an index claiming 4,464 |

**A third property fell out that ADR-0024 does not claim and that is worth more than it looks: a
truncated tar throws.** Every cut tried — inside a header, inside a body, between entries, one block
short of the end marker — raised `Tar archive is truncated.` The entire reason the zip is going is
that `fflate` read a short archive back as a short archive *with no error at all*, so a format whose
truncation announces itself is the requirement rather than a bonus. It is asserted.

**One honest limit, found by a test that first failed for the wrong reason.** Restore's peak memory is
**a constant plus one file**, not a fraction of the archive. The Web Streams chain between source and
decoder buffers about 9 MiB, so an archive *smaller* than that is held whole however carefully
anything streams. That is fine — it is small — and for the ~400 MB backup ADR-0024 says a zip could
not restore on an iPad at all, the constant is the whole point. The first draft of
`workspace-tar.test.ts` asserted a fraction against a 1.8 MB archive and failed; the test was wrong,
not the code, and it now measures against a 32 MiB archive and asserts the constant. Recorded because
"restore streams" is easy to overclaim.

**And a second one, about `ProjectStore` rather than about tar.** There is no streaming *write*, so
one file is held in memory while its entry is written or read. That bound is the store's and predates
this ticket; the archive around it is streamed, which is what the ADR's claim is about. Making the
store stream is an ADR-0017 question, not this slice's.

## Acceptance criteria

- [x] A Workspace with two Projects sharing one Historical Map backs up to a single tar.
- [x] Restoring that tar into a fresh Workspace reproduces both Projects, one pyramid, one Alignment, and every Annotation.
- [x] The tar contains no `index.html`, no `_app/`, and no `ballastella-site.json`. — also no `robots.txt` and no `base-map/`, because the ticket's "the enumerable viewer file set is what a backup excludes" points at `isViewerFile`, which enumerates all five. The cost is that an Offline Copy's Base Map extract has to be made again, so the restore notice says so as well as saying to publish — otherwise a Reader of a restored Project gets the silent blank map ticket 17 found the product had no notice for.
- [x] Restoring reports that publishing is needed before the Workspace is a site again.
- [x] Restoring creates a **new** named Workspace and switches to it; the Workspace that was open is unchanged. Asserted at both seams, and at Seam 2 by reading OPFS behind the app's back rather than by trusting the save indicator.
- [x] A Workspace with more than 65,535 files backs up and restores intact — 70,000 generated, not a fixture, asserted on the **restored file count**.
- [x] A Project directory at the 64-character limit round-trips, with its `annotations/<uuid>.geojson` files intact — with the Workspace name at *its* 64-code-point limit too, so the archive paths are as long as they can be, and separately with the Workspace name in Devanagari, CJK, Arabic and Latin.
- [x] Backing up the same Workspace twice produces byte-identical archives; so does backing up a restored Workspace. A third test asserts it does not depend on the order the store lists files in.
- [x] Restoring with insufficient quota is refused beforehand with the numbers, and writes nothing — *before the destination Workspace is even created*, so there is nothing to have written into. Tar makes this honest in a way a zip could not: nothing is compressed, so `File.size` is a real bound on what unpacks, and there is no deflate-bomb class to guard against at all.
- [x] A backup containing a newer `formatVersion` is refused, naming where to get that version, and nothing is restored — and refused *before the manifest is written*, asserted separately from the discard so it cannot pass for the wrong reason.
- [x] Restore does not hold the whole archive in memory — two measurements, not a completion: files land while most of the source is unread, and the unwritten backlog never exceeds the stream chain's own constant.
- [x] An interrupted restore leaves no Project listed on the hub — asserted through `Workspace.listProjects` rather than by comparing paths, for a truncated archive and for a failed write, and the whole destination Workspace is discarded.

## The mutation check

Mandatory, and it earned its place three times before review and again after. **39 mutations** in
total, across the two core modules, the editor's storage layer, the measurement file, and `modern-tar`
itself in `node_modules` — each applied, tested, and reverted, and the whole set re-run against the
final code. Everything covering the review findings goes red, including the shipped folder-name defect
at **both** seams, prefixing entries with the un-normalised name, dropping or ignoring the PAX record,
counting a declined Alignment, and feeding the decoder a fully-buffered archive.

**One mutation was itself wrong and is worth recording**, because it would have read as a passing
guard: "omit the Workspace directory entry" was written as an extra `name:` key in the same object
literal, where the *later* key wins — so it changed nothing and came back green. Rewritten to delete
the entry outright, and separately to write it under a wrong name; both red. A mutation that does not
mutate is the same failure as an assertion that does not assert.

Of the original 25, **three came back green, and all three were real:**

1. **`assertSafeBackupPath(header.name)` was dead code.** Restore checked the entry name twice, once
   before stripping the Workspace prefix and once after. Deleting the first left the whole suite
   green — and no specimen could be constructed that only it would catch, because the prefix fence
   rejects anything outside the Workspace folder and every traversal segment that survives the fence
   survives the slice. **The call was removed rather than given a contrived test.** A guard that
   cannot be made to fire is worse than no guard, because a reader counts it as protection.
2. **The Workspace-name idempotence check was untested.** `backupWorkspaceName` refuses a name that
   changes under `toWorkspaceName`, because the normaliser is idempotent by contract (ticket 12) and
   a name that changes is one our exporter could not have written. Deleting the check left everything
   green: the only specimen was `has/a/slash/`, which an *earlier* check already rejects. Now covered
   by two names that pass every structural check and still change — `Marking#2026`, and an NFD
   `Café Notes`, which is exactly how it would really arrive, since APFS stores filenames decomposed.
3. **Routing Alignment writes through ticket 18's one writer was unobservable.** Replacing
   `writeAlignmentBytes` with a plain `store.write` changed nothing, because the destination is
   normally a Workspace created moments earlier and therefore empty. A guarantee nothing can observe
   is not a guarantee, so there is now a test that hands restore a destination that already holds an
   Alignment and asserts the existing one wins — the direction ADR-0023 requires, and the case
   ticket 14's Review Workspaces will actually reach.

The e2e spec was mutation-checked too: removing the format refusal, removing the viewer-file
exclusion, opening the existing Workspace instead of creating one, not switching after a restore, and
dropping "publish" from the notice each turn `editor-backup.e2e.ts` red.

The measurement file was checked against itself: deleting `modern-tar`'s PAX branch in
`node_modules`, and tightening the backpressure bound to an impossible value, both turn
`tar-format.test.ts` red — so it is measuring the library rather than asserting tautologies.

Two further bounds — how many Projects a backup may declare, and how large a `project.json` may be —
were noticed to be untested before they were mutated, and now have specimens. The first needed
*valid* manifests to reach the bound at all: `{}` is refused by `parseProjectFile` first, which is
correct, and would have made the bound fire only behind another refusal.

## What was run

Exit codes, not summaries — a grepped summary is how the pre-existing `pnpm lint` failure stayed
hidden earlier in this ticket.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm -r build` | 0 | green |
| `pnpm -r test` | 0 | 60 files, 1,575 passed, 15 skipped — **run three times**, no timeouts, after the memory test made `publish.test.ts` flaky |
| `pnpm lint` | 0 | green |
| `pnpm check` | 0 | green |
| `pnpm test:e2e` (unfiltered, no `--reporter=`) | 0 | **434 passed, 0 retries** (budget 0.50% = 2) |

Two fences refused this work before it landed, both correctly, and both were answered by changing the
code rather than by taking the opt-out. `check-workspace-rooted-paths` flagged
`<workspace>/images/<id>/info.json` in the tests: the shape is legitimate here — the leading segment
is the *Workspace's* name, which sits above the store root — but it is indistinguishable from the
Project-rooted spelling ADR-0023 forbids, so the tests now compose it through `archivePathFor` and
`imageInfoPath` (Seam 1) and a named `inWorkspace` helper (Seam 2). That is better than a pragma
twice over: the pragma would have claimed something untrue of those lines, and the Seam 1 assertion
can no longer drift from what the exporter actually composes.

## What ticket 18's fence does not reach, recorded rather than implied

Restore computes `alignments/<image-id>.json` **out of an archive entry's name**, so the `WritablePath`
brand never applies — the compiler only ever sees a `string`, which is the limit ticket 18 states
about itself. `scripts/check-alignment-writers.mjs` did not flag it either, because this code never
spells `alignments/`; the path arrives as data. The write is routed through `writeAlignmentBytes`
anyway, and criterion 3 above is what makes that routing observable. **The gap is in the fence, not
in this ticket's use of it**, and a third writer arriving the same way would go unnoticed the same
way — worth knowing before ticket 14 writes one.

**Restore does not detect a concurrent edit and does not pretend to.** ADR-0023 accepts that gap and
ticket 18 left it open deliberately. A backup and restore is exactly where somebody would assume it
was covered, so `restore-workspace-tar.ts` says in as many words that it compares no timestamps and
reconciles nothing: it makes a second Workspace and puts the archive in it, and deciding which of the
two is the good one is the user's. That is the whole reason the old one is left alone.

## What spec review found, and what it cost

Five findings. Two were defects that would have reached a scholar; two were the measurement being
weaker than the prose I wrote, which is worse than it sounds because those numbers were repeated
upward; one was a comment that would have misled the next reader. All five are fixed, and every fix
is mutation-checked.

**1. The app wrote backups it would then refuse to restore.** `exportWorkspaceTar` took the app's name
for the Workspace verbatim, and for a **folder** Workspace that is the operating system's folder name,
which has never been through `toWorkspaceName`. `backupWorkspaceName` refuses any root directory that
is not already normalised. Reproduced before fixing: `Dave's maps` → `Dave s maps`, `maps, 1625` →
`maps 1625`, `maps & plans` → `maps plans`, anything over 64 code points truncates, and an NFD `Café
Notes` changes while looking identical. **A folder user's backup failed only at restore** — the one
moment they cannot afford it.

The fix normalises **in core**, where the fence lives, so no call site can get it wrong; and the
original name rides along in a **custom PAX record** so nothing is thrown away. That record was
measured before being relied on — it round-trips exactly through both readers, for NFD and Devanagari
— and is omitted entirely when the name needs no normalising, so an ordinary browser-storage archive
is byte-for-byte what it was and reproducibility is untouched. The record is treated as untrusted: it
is only ever a *preference* handed to whoever creates the Workspace, and a hostile one degrades to the
archive's own directory name rather than to a refusal.

**Why nothing caught it: every fixture in the repo was called `My Workspace` or `Marking 2026`** — the
only kind of name the normaliser leaves untouched. There is now a Seam 1 table of six real folder
names and a **Seam 2 test that takes a folder called `Dave's maps, 1625` through the real picker,
backs it up, and restores it.** Its first draft failed for an instructive reason: it seeded the folder
and then reloaded, and a folder grant does not survive a reload without a fresh gesture (ADR-0012), so
it silently backed up `My Workspace` — the same blind spot in a new costume.

**2. Silent under-restore.** `writeRestored` discarded `writeAlignmentBytes`' outcome and counted the
file anyway, so a restore that deliberately kept the destination's Alignment still reported the
archive's as delivered. Unreachable today because the destination is always new — but ticket 14's
Review Workspaces reach it, and **a transfer that reports more than it wrote is `fflate` claiming
4,464 of 70,000 with a different spelling.** Now `writeRestored` returns `'written' | 'declined'`,
nothing declined is counted in `totalFiles`, `totalBytes`, or `projects`, and `WorkspaceRestore`
carries a `declined` list that the notice names in words.

**3 and 4. The measurement was weaker than what I wrote down, and one part of it was vacuous.**

The stall figure said "9 MiB into a 256 MiB entry" while the test ran a 64 MiB entry. Corrected, and
the entry size is now taken from the constant rather than restated in prose, since prose beside code
is prose that will disagree with it.

The heap bound was worse than weak — **it could not have failed.** It measured `heapUsed`, and a
`Uint8Array`'s payload is external memory that `heapUsed` does not count. Measured over the same
512 MiB round trip, against a consumer deliberately retaining every chunk:

| consumer | `heapUsed` | `arrayBuffers` |
| --- | --- | --- |
| correct, streaming | +3.17 MiB | +18.44 MiB |
| retains every chunk (the bug) | +5.24 MiB | **+512.00 MiB** |

So the bound passed just as comfortably for a consumer holding the entire archive as for one holding
none of it. **The 2.80 MiB figure I reported was measuring nothing, and should be struck from
anything it was repeated into.** It is corrected here, in `pnpm-workspace.yaml`, and in
`workspace-tar.ts`.

**⚠ And the replacement is not another memory figure, which is a judgement worth challenging me on.**
I tried three instruments and none gave an answer I would defend:

1. peak `heapUsed` — vacuous, above;
2. peak `arrayBuffers` **during** the run — dominated by allocation churn rather than by what is
   held, since a fresh buffer per write leaves thousands uncollected. Swung between 3.9 MiB and
   22.3 MiB for identical work, and **once reported the retaining consumer as cheaper than the
   streaming one**;
3. `arrayBuffers` **retained after a forced `gc()`** — the right question, and unavailable:
   `globalThis.gc` is undefined under vitest, and I got `--expose-gc` to the worker only by changing
   the pool configuration for all 1,100 tests in the project to serve one assertion. I reverted that.

The criterion offers "peak usage **or** streamed consumption", so the file now asserts the latter,
counted in bytes moved through a stream rather than bytes the collector has freed. It is
deterministic, needs no runtime flag, and there are now four such assertions: the packer stalling into
an unread sink, the decoder stalling 9.00 MiB into a 64 MiB entry, restore writing while most of the
archive is unread, and a **new whole-archive one** — the producer never runs more than ~9 MiB ahead of
a slow consumer, which is what would catch a decoder accumulating *across* entries rather than within
one. That last is mutation-checked: feeding the decoder a fully buffered archive turns it red.

A harness bug surfaced on the way and is recorded in the file: a counting `TransformStream` between
decoder and consumer added its own high-water mark and inflated the figure from 18 MiB to 98 MiB.

**This test also made its neighbours flaky, which is why the size came down.** Holding 512 MiB timed
out two unrelated tests in `publish.test.ts` under the load of a full `pnpm -r test` — `publish`
passes 56/56 alone and timed out at 5 s twice in a full run. Confirmed by measurement rather than
assumed, and the replacement moves 32 MiB.

**5. A comment stated something false.** It described an NFD `Café Notes` as a name "our own exporter
could not have written" — which, per finding 1, it wrote for every folder Workspace. Rewritten to
state the rule the guard actually enforces, which does not rest on the exporter behaving.

## Debt paid on the way through

**`pnpm lint` was already red on `main`** — seven files failed `prettier --check`, all fallout from
ticket 16's Offline Copy rename (`offline-copy.ts` and its three tests, `referenced-image.test.ts`,
`editor-offline-copy.e2e.ts`, `ProjectScreen.svelte`, `OfflineCopyDialog.svelte`). Formatting only,
fixed in place rather than reported, so this ticket's own command list can be honest.

```sh
pnpm -r build && pnpm -r test && pnpm lint && pnpm check
pnpm --filter @ballastella/core test
pnpm exec playwright test e2e/editor-transfer.e2e.ts e2e/editor-workspace.e2e.ts
pnpm test:e2e
```

All green. `packages/core/src/transfer/project-zip.test.ts` is the prior art for a byte-reproducible round trip; the new suite should read like it.

The >65,535-file criterion is the reason this ticket exists — generate the entries rather than committing a fixture, and assert the **restored file count** equals the original, which is exactly the assertion that caught fflate silently dropping 94% of a pyramid.

The long-path criterion will pass by accident if your Project name is short. Use the full 64 characters.

## What was built

- `packages/core/src/transfer/workspace-tar.ts` — what a backup *is*: the constant entry time, the
  archive-path composition, the entry-name refusals, and the reasoning for the archive being rooted
  at a directory named after the Workspace.
- `packages/core/src/transfer/export-workspace-tar.ts` — `exportWorkspaceTar`.
- `packages/core/src/transfer/restore-workspace-tar.ts` — `restoreWorkspaceTar`, and the order of
  operations a streaming restore forces, which is the whole design.
- `packages/core/src/transfer/tar-format.test.ts` — the `modern-tar` measurement, above.
- `packages/core/src/transfer/workspace-tar.test.ts` — the round trip, Seam 1.
- `e2e/editor-backup.e2e.ts` — Seam 2: a real download, a real file input, real OPFS.
- `apps/editor/src/lib/components/WorkspaceSettings.svelte` — the two controls, beside the sections
  that tell a scholar their work is in a place they cannot see and may be evicted. The persistence
  section already said "keeping a backup … is the answer to that" and had nothing to point at.
- `apps/editor/src/lib/workspace-storage.svelte.ts` — `backUp` and `restoreFrom`.

**One decision worth flagging for review: the archive is rooted at `<workspace-name>/`.** A Project
zip deliberately does *not* carry its own directory name, so the importer chooses it and a collision
is a question for the user. A Workspace backup is the opposite case — restore creates a **new**
Workspace, so there is nothing to collide with, and the name is the one piece of the user's work with
nowhere else to live since ticket 12 made the directory name *be* the name. It also makes
`tar xf backup.tar` produce a folder a person recognises, and it puts the long-path measurement on
the common path rather than in a corner: the Workspace name prefixes every entry.

**`restoreWorkspaceTar` takes a way of *making* a Workspace rather than a store**
(`OpenRestoreDestination`, returning a `name`, a `store`, and a `discard`). That is what makes
"nothing has been restored" true rather than aspirational — the destination is new, so throwing it
away costs the user nothing, which is a luxury the zip importer's file-by-file rollback did not have.

**Restoring always lands in browser storage, even from a folder Workspace.** ADR-0024 requires a new
Workspace; browser storage can make one by itself and a folder cannot without a second picker
gesture, and a subdirectory of the current folder would be the Workspace-inside-a-Workspace
containment failure ticket 12 removed. The folder is left untouched and the user can copy out.

## Not done, and deliberately

**"The zip path for whole-Workspace transfer is removed" removed nothing: there was none.** Zip
transfer in the editor is per-Project only — `exportProject` / `prepareImport` / `confirmImport` on
`EditorSession`, reached from `ProjectHub.svelte`. Grepped for `exportWorkspace`, "Export
everything", "Workspace zip"; the only whole-Workspace mentions were comments anticipating this
ticket. Project-level zip export stays until ticket 14 replaces it with the bundle, per the contract.

## Blocked by

- Ticket 01
- Ticket 12

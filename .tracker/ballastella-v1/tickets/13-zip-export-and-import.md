# 13 — Zip export and import, with collision handling

## What to build

A user exports a Project as a zip file and imports it on another computer or hands it to a colleague. On import, a name collision is reported rather than silently overwriting existing work.

This is the **only** way in and out for Firefox, Safari, and iPad users, whose Projects live in browser-managed storage they cannot see (ADR-0001). It is also the archival and deposit path.

**Fulfills** — [SPEC.md](../SPEC.md) user stories 5, 13, and 14. With tickets 07 and 10: 94. With ticket 16: 87 and 93. With tickets 09 and 10: 56 — this is how a shared Project reaches each student. This ticket is also the concrete reason ticket 10's Markdown sanitisation is required rather than theoretical.

## Where to start

[ADR-0001](../../../docs/adr/0001-opfs-first-project-store.md) (why this is a first-class path, not a convenience), [ADR-0008](../../../docs/adr/0008-projects-live-in-a-workspace.md) (a Project zip is one Project subdirectory), [ADR-0009](../../../docs/adr/0009-annotations-use-simplestyle-spec.md) (imported content is untrusted).

The store and Project lifecycle come from ticket 02.

## Contract

**A Project zip is one Project subdirectory**, rooted at the Project directory, not at the workspace. Import adds a subdirectory.

Export is **data only**. The viewer files ticket 16 writes must be excluded, which is why ADR-0006 requires that set to be **enumerable and recorded** — without that list the two export flavours are indistinguishable. Ticket 16 has not run yet, so define the exclusion mechanism here and leave the list empty; ticket 16 populates it.

**Collision handling is the substance of this ticket.** On importing a Project whose directory name already exists:

- **Report it and require a choice.** Never silently overwrite: the user may be importing a colleague's version of work they also have.
- Offer at minimum: import under a new name, or cancel.
- Directory-name identity is what collides, not display name (ADR-0008) — two Projects may share a display name, and importing one must not be blocked because of it.

Import must **validate before writing anything**:

| Check | Behaviour on failure |
|---|---|
| `project.json` present and parseable | Reject with a specific message |
| `formatVersion` not newer than this app | Refuse, naming the remedy (ADR-0010) |
| Referenced files exist (`alignmentRef`, `geojsonRef`, image directories) | Reject, naming what is missing |
| No path traversal (`..`, absolute paths) in any entry | Reject |

A partially written import is worse than a rejected one: **write nothing until validation passes.**

Path traversal matters because a zip is untrusted input from another person. An entry named `../../etc/whatever` must never be written, and on the File System Access backend (ticket 12) it would be writing outside the user's chosen folder.

**Imported content is untrusted.** Annotation `description` fields come from someone else and are rendered on the user's own domain — ticket 10 owns the sanitisation, and this ticket is the reason it is required rather than theoretical (ADR-0009). Add an import-path test asserting a malicious `description` in a zip renders inert.

Round-trip fidelity: export then import reproduces an **equivalent** Project — same Layers in the same order, same Alignments, same Annotations, same image pyramids. Byte-identical is not required (zip metadata and ordering may differ); semantically identical is.

Large Projects: a mirrored pyramid can be hundreds of megabytes. Export must stream or chunk rather than assembling the whole archive in memory, and must report progress.

## Out of scope

- **Publishing, and the "export as website" flavour** — ticket 16. This ticket is the data-only zip.
- **Exporting or importing a whole Workspace.** One Project at a time.
- **Merging two versions of the same Project.** Collision offers rename or cancel, not a three-way merge.
- **Format migration.** Refuse newer; there are no migrations to run (ADR-0010).
- **Populating the viewer-file exclusion list** — ticket 16.

## Acceptance criteria

- [x] A Project exports to a zip rooted at the Project directory
- [x] Importing that zip into another Workspace reproduces a semantically identical Project: same Layers, order, Alignments, Annotations, and pyramids
- [x] A round trip through export → import → export produces a semantically identical Project the second time
- [x] Importing a colliding directory name reports the collision and offers rename or cancel; **nothing is overwritten**
- [x] A collision on *display* name alone does not block import
- [x] A zip missing `project.json`, or with an unparseable one, is rejected with a specific message and **nothing is written**
- [x] A zip whose `formatVersion` is newer is refused with a message naming the remedy
- [x] A zip referencing a missing `geojsonRef` or image directory is rejected, naming what is missing — see note 2, the image-directory half is checked structurally
- [x] A zip containing a `../` path entry is rejected and no file is written outside the Project directory
- [~] A zip whose annotation `description` contains an XSS payload renders inert after import — **partial, see note 3**
- [x] Export reports progress and does not hold the entire archive in memory for a large Project
- [x] The export excludes whatever is on the viewer-file list (empty at this point, mechanism in place)
- [x] Import and export are reachable and operable by keyboard, and progress is announced

```bash
pnpm --filter @ballastella/core test    # round-trip equivalence, validation, traversal rejection
pnpm test:e2e                    # export/import via the UI, collision dialog, rejection messages
pnpm -r build && pnpm lint && pnpm check
```

Success: all exit 0. The traversal and collision tests must assert that **no write occurred** — asserting only that an error was shown would pass an implementation that writes first and complains afterwards.

## Blocked by

- Ticket 02

## Implementation notes

Everything above is implemented in `packages/core/src/transfer/` (`export-project-zip.ts`,
`import-project-zip.ts`, `viewer-files.ts`, `transfer.ts`), `Workspace.importProject`, the hub's
import dialog and per-Project Export button, and `e2e/editor-transfer.e2e.ts`. Zip handling is
`fflate`, chosen because the round-trip tests are Seam 1 in Node and import is half the slice.
Four things a reader should not have to reconstruct:

### 1. Where the directory name comes from — a decision the ticket left open

The Contract fixes the archive as **rooted at the Project directory**, so `project.json` is at the
top of the zip and the Project's directory name — which is its identity (ADR-0008) — is *not
inside the archive*. Something has to supply it on import, and the two acceptance criteria fence
the answer in from both sides: a colliding directory name must be reported, and a shared *display*
name must not block. Deriving the directory from the display name satisfies the first and violates
the second.

Settled as: **the zip's file name**, which is what `exportProjectZip` sets to `<directory>.zip`,
falling back to the display name only when the file name slugifies to nothing. So a Project
handed on as `assignment-3.zip` imports into `assignment-3`. `EditorSession.prepareImport` does
this; core's `Workspace.importProject` takes the directory as an argument and has no opinion.

Recorded here because it is a real decision and the alternative — a metadata file inside the
archive carrying the directory name — was rejected for polluting a data-only zip that is also the
deposit format (story 94).

### 2. The image-directory check is structural, not a followed reference

The Contract's validation table asks that referenced files exist: "`alignmentRef`, `geojsonRef`,
image directories". The first two are read straight off each Layer — the epic names those keys in
SPEC's Layer union and in ticket 09 — structurally rather than through a type, so the check works
on today's `layers: unknown[]` and keeps working when 09 lands.

**Image directories have no such key.** A map Layer reaches its image *through* its Alignment. So the
check implemented is the one that is determinable now: every `images/<id>/` in the archive must
contain its `info.json`, without which the pyramid is a heap of tiles no IIIF client can open
(ADR-0006's layout).

**Extending `assertReferencesPresent` to follow the Layer → Alignment → image-service link is now
item 12 on ticket 09's checklist**, where it will not be lost. The reason for the deferral recorded
here first — "ticket 07 defines the shape" — was only half true, and the correction matters because
it changes what the follow-up costs: ADR-0009 and the IIIF Georeference Extension already fix that
serialisation, so the shape is known. The real reason is that following the link means **parsing an
untrusted Annotation during validation**, which puts a parser on the path whose whole design property
is that it inflates almost nothing and interprets nothing before it has decided to accept the
archive. That is a decision, not a gap waiting on a type.

### 3. "Renders inert" is asserted as far as this ticket can reach

Nothing renders an annotation `description` yet — ticket 10 owns both the rendering and the
sanitising. What is asserted here is everything the import path itself owes: the payload reaches
storage **byte-identical**, import never parses or re-serialises the GeoJSON, and importing a zip
carrying `<img onerror>` and `<script>` produces no page error, no dialog, no injected element,
and no global the payload tried to set (`e2e/editor-transfer.e2e.ts`, "imported content is
untrusted"). **The criterion is not closed until ticket 10 renders a `description` through
`marked` → `dompurify` and asserts the payload inert on screen** — this ticket is the reason that
work is required rather than theoretical, and the fixture zip is here to be reused.

### 4. Export streams; the browser sink is a `Blob`, not a file handle

`exportProjectZip` returns a `ReadableStream` driven from `pull`, so one Project file is in memory
at a time and a slow sink throttles the reads. The editor pipes it into a `Blob` — backed by the
browser's own storage, which spills to disk — rather than accumulating chunks in the JS heap.
`showSaveFilePicker` would stream straight into a file the user picked and is better still, but it
is Chromium-only, i.e. absent from exactly the browsers this path exists for, so it belongs with
ticket 12's File System Access work rather than as an untested branch here.

### Also worth knowing

- Every zip entry carries a **fixed 1980 timestamp**, so an export is byte-reproducible and a
  round trip can be asserted as producing the *identical archive* rather than an equivalent one.
  It also refuses to imply that a zip carries useful times, which is the reasoning behind
  `updatedAt` living inside `project.json`. That byte-identity assertion additionally depends on
  fflate's deflate producing the same output for the same input, which nothing promises: `fflate` is
  `^0.8.3` in the catalog and CONTRIBUTING pins only `@allmaps/*` exactly, so **a routine fflate bump
  can fail that one line for a reason that is not a regression here**. Said in a comment on the
  assertion itself, next to the weaker assertion above it that is the one the ticket asks for.
- `saveFile` revokes the download's object URL on a **macrotask**, not in the same task as
  `link.click()`. Chromium takes its reference synchronously, so an immediate revoke is safe there
  and Chromium is the only browser this repository's e2e runs — but Safari has historically cancelled
  a download revoked before it began reading, which made an immediate revoke a bet placed in exactly
  the browsers this path exists for.
- `Workspace.importProject` writes the imported bytes verbatim and is **the one method there that
  does not stamp `updatedAt`** — importing is not editing. It writes `project.json` **last**, so
  an interrupted import leaves orphaned files rather than a Project that lists on the hub and
  opens half empty.
- Import is **not** streaming: the compressed archive is held whole and inflated in bounded
  batches (8 MB / 128 entries). The ticket asks only that *export* stream, and validating the
  whole archive before writing any of it needs random access to it. Peak memory is the compressed
  archive plus one batch, not compressed plus fully inflated — and that claim is now true for a
  hostile archive as well as an honest one, because the batch bound was previously computed
  entirely from fields the archive declares about itself.
- **Untrusted input: what the archive is allowed to claim.** Every number in a zip is a claim, and
  three of them are checked before anything is written (`PROJECT_ZIP_LIMITS`): total declared
  uncompressed bytes (4 GB), per-entry declared bytes (256 MB), and entry count. Deflate reaches
  nearly 1000:1 on runs of zeros, so a ten-megabyte archive can declare ten gigabytes; and fflate
  builds each entry's output buffer *from that entry's declared size*, so a forty-kilobyte archive
  can ask the browser for four gigabytes. On OPFS the quota eventually throws; on ticket 12's folder
  backend there is no quota at all. The bounds are injectable so the refusals are assertable without
  building a four-gigabyte archive.
- **CRC-32 is verified, per batch, and a failure rolls the whole import back.** fflate never reads
  that field and neither did we, and the declared uncompressed size was trusted as the output
  buffer — which fflate does not grow, because the caller supplied it, so writes past its end are a
  silent no-op and the result is clamped to exactly the declared length. An archive claiming a
  5,000-byte file is 100 bytes long therefore yielded 100 bytes with no error, and **a length check
  cannot catch that** because the length is what was declared. It matters most for the part of a
  Project that is not deflated at all: tiles are JPEG, so they are stored, and a stored entry has no
  deflate stream whose corruption could raise an error. Verifying per batch rather than inflating
  the archive twice is the recorded decision — inflating twice doubles the slowest part of a
  several-hundred-megabyte import and defeats the memory bound above — and it is why
  `Workspace.importProject` rolls back. The two are one decision: verify late, and undo.

### 5. Two known ceilings, both about size, both recorded rather than solved

**Export refuses a Project of more than 65,535 files.** A zip counts its entries in a sixteen-bit
field, and going past it needs the zip64 records fflate's *writer* does not emit. Measured: exporting
70,000 entries produced an archive whose index claimed `70000 & 0xffff` = 4,464 of them, and every
unzipper — fflate included — read it back as 4,464 files with no error. A plausible-looking zip
missing 94% of a pyramid, on the only way out of a browser the user cannot see into and on the
deposit path (story 94). SPEC puts "tens of thousands of files" on a single 2 GB pyramid, so a Project
with a few large archival scans reaches this. A legible refusal, naming ticket 12's folder Workspace
as the way out, is the honest answer; **the fix is zip64 in the writer**, which means either fflate
gaining it or writing the central directory here.

**Import holds the whole compressed archive in the JS heap** (`editor-session.svelte.ts`
`prepareImport` reads `file.arrayBuffer()`), so a ~400 MB pyramid export cannot be re-imported on an
iPad — the device ADR-0001 and this ticket name as the *reason* this path exists. Export was streamed
for exactly this size; import cannot take it back. Not a criterion miss — the ticket asks only that
export stream, and validating an archive before writing any of it needs random access to it — but a
real ceiling. The shape of the fix: `File.slice()` gives random access to the picked file without
ever reading it whole, so the central directory can be read from the tail and each entry's bytes
sliced on demand; or, if validation genuinely needs a settled copy, write the archive to a quarantine
directory in the store and move the Project's files out of it once accepted. Both are more than this
ticket asked for and neither is speculative.
- The per-Project row now reads Rename · Duplicate · Export · Delete, so
  `e2e/editor-workspace.e2e.ts`'s keyboard-reach loop gained `/^Export/`.

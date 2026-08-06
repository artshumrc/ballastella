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

**Image directories have no such key.** A map Layer reaches its image *through* its Georeference
Annotation, whose shape ticket 07 defines and which does not exist yet. So the check implemented
is the one that is determinable now: every `images/<id>/` in the archive must contain its
`info.json`, without which the pyramid is a heap of tiles no IIIF client can open (ADR-0006's
layout). **Ticket 07 or 09 should extend `assertReferencesPresent` to follow the Layer → Alignment
→ image-service link**, which is what would catch a zip whose Layer points at an image directory
that was never included at all.

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
  `updatedAt` living inside `project.json`.
- `Workspace.importProject` writes the imported bytes verbatim and is **the one method there that
  does not stamp `updatedAt`** — importing is not editing. It writes `project.json` **last**, so
  an interrupted import leaves orphaned files rather than a Project that lists on the hub and
  opens half empty.
- Import is **not** streaming: the compressed archive is held whole and inflated in bounded
  batches (8 MB / 128 entries). The ticket asks only that *export* stream, and validating the
  whole archive before writing any of it needs random access to it. Peak memory is the compressed
  archive plus one batch, not compressed plus fully inflated.
- The per-Project row now reads Rename · Duplicate · Export · Delete, so
  `e2e/editor-workspace.e2e.ts`'s keyboard-reach loop gained `/^Export/`.

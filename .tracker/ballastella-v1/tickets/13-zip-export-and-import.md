# 13 — Zip export and import, with collision handling

## What to build

A user exports a Project as a zip file and imports it on another computer or hands it to a colleague. On import, a name collision is reported rather than silently overwriting existing work.

This is the **only** way in and out for Firefox, Safari, and iPad users, whose Projects live in browser-managed storage they cannot see (ADR-0001). It is also the archival and deposit path.

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

- [ ] A Project exports to a zip rooted at the Project directory
- [ ] Importing that zip into another Workspace reproduces a semantically identical Project: same Layers, order, Alignments, Annotations, and pyramids
- [ ] A round trip through export → import → export produces a semantically identical Project the second time
- [ ] Importing a colliding directory name reports the collision and offers rename or cancel; **nothing is overwritten**
- [ ] A collision on *display* name alone does not block import
- [ ] A zip missing `project.json`, or with an unparseable one, is rejected with a specific message and **nothing is written**
- [ ] A zip whose `formatVersion` is newer is refused with a message naming the remedy
- [ ] A zip referencing a missing `geojsonRef` or image directory is rejected, naming what is missing
- [ ] A zip containing a `../` path entry is rejected and no file is written outside the Project directory
- [ ] A zip whose annotation `description` contains an XSS payload renders inert after import
- [ ] Export reports progress and does not hold the entire archive in memory for a large Project
- [ ] The export excludes whatever is on the viewer-file list (empty at this point, mechanism in place)
- [ ] Import and export are reachable and operable by keyboard, and progress is announced

```bash
pnpm --filter @ballastella/core test    # round-trip equivalence, validation, traversal rejection
pnpm test:e2e                    # export/import via the UI, collision dialog, rejection messages
pnpm -r build && pnpm lint && pnpm check
```

Success: all exit 0. The traversal and collision tests must assert that **no write occurred** — asserting only that an error was shown would pass an implementation that writes first and complains afterwards.

## Blocked by

- Ticket 02

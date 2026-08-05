# Integer `formatVersion` with forward-only migrations, and a hard refusal on newer

`project.json` carries an integer `formatVersion`. Opening a project runs forward-only migrations up to the version the app understands. An app that meets a `formatVersion` **higher** than it knows stops and says so plainly rather than proceeding.

Version skew is structural here, not accidental. The data is user-owned files that outlive any app version — in Dropbox, in a git repository, in OPFS — while the app is a rolling deployment. And the project explicitly invites people to fork and host their own instance, which guarantees old app versions stay alive in the wild, meeting data written by newer ones. Skew arrives in both directions: old project into new app is ordinary evolution; new project into old app arrives via an imported zip from a colleague, a Dropbox folder shared between machines, a stale service worker, or a fork pinned at whatever version its owner cloned.

An integer with forward-only migrations is the simplest thing covering both cases. Semver was rejected because it invites arguing over minor-versus-patch for a format with one family of consumers while buying nothing — there is never a need for "compatible with ^2.1". Tolerant additive parsing with no version field was rejected because it fails the first time anything is renamed or restructured, after which code is guessing which shape a file is in.

## The refusal path is the part that matters

Without it, an old fork silently drops fields it does not recognise, writes the file back, and destroys the user's work with no error. The message must name the remedy: "this project was made with a newer version — open it at *URL*, or update your copy."

## Consequences

- **Migrate in memory on open; write back only on the user's first actual change.** Merely *looking* at an old project must not modify files. Otherwise opening a project in a git repository produces a large unexplained diff, and opening one in a Dropbox folder syncs a rewrite to every other machine — both of which read as the tool corrupting data, even though the migration is valid.
- **Pin `@allmaps/*` to exact versions and treat any Allmaps upgrade as a migration event**, with a round-trip test over fixture alignments. Every one of those packages is pre-1.0 (`iiif-parser` beta.48, `maplibre` beta.43, `leaflet` beta.54), so the Georeference Annotation shape and parser API can still move. An unnoticed change in a beta bump would break existing alignments in the field, and it would show as maps subtly *misplaced* rather than as an error.
- Alignment files and annotation files are standard formats with their own versioning (`@context`, GeoJSON); `formatVersion` covers the project's own layout and `project.json`, not those.

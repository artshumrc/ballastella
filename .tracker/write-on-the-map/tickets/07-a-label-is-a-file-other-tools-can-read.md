# A Label is a file other tools can read

## Parent

[SPEC.md](../SPEC.md) — "A Label is a Point whose `marker-symbol` is `label`", and the file-and-other-
tools stories.

## What to build

The portability claim, made checkable for the new kind.

A Label is an ordinary GeoJSON Point with simplestyle properties, so: a Layer holding one round-trips
byte-identically when nothing changed; a Label written by *another* tool — a Point carrying the same
marker symbol — opens here as a Label; a Point carrying an *unrecognised* symbol stays a Pin and keeps
that symbol when written back; and a Label survives both ways a Project leaves this machine, as a
Project Bundle opened into a Review Workspace and as a Backup restored.

## Where to start

- `packages/core/src/annotation/geojson.ts` — `parseAnnotations` and `serialiseAnnotations`. Read the
  header: the byte-identity claim is stated there and already asserted for the other kinds, and
  `readProperties` carries `properties` **whole** rather than picking it apart — which is why a
  foreign `marker-symbol` survives with nothing written for it.
- `packages/core/src/annotation/annotation.test.ts` — the existing round-trip and conformance suites
  this extends.
- `packages/core/src/transfer/` — the Project Bundle. `open-project-bundle.ts`'s
  `assertReferencesPresent` validates that a Layer's named GeoJSON is *present* without ever parsing
  an untrusted Annotation; that property is deliberate and must survive this ticket untouched.
- `e2e/editor-transfer.e2e.ts` and `e2e/editor-backup.e2e.ts` — the specs this extends rather than
  duplicates.
- `e2e/support/annotations.ts` — `writeProjectFile`, `storedAnnotations`, `hashesUnder`. `hashesUnder`
  is how "these files did not change" is asserted.

## Contract

**Nothing new is parsed.** A Label needs no branch in `parseAnnotations`: it is a Point, and
`marker-symbol` rides in `properties`, which is carried whole. If this ticket finds itself adding a
case to the parser, that is the signal that the discriminator was implemented somewhere it should not
have been — go and look rather than adding the case.

**Byte-identity is the load-bearing claim.** Parse a Layer containing a Label and serialise it back:
identical bytes. The one legitimate difference is the existing one — a document that arrived with no
`Feature` ids gains them — and it is unchanged by this ticket.

**An unrecognised symbol is a Pin.** `isLabel` compares for equality with `label`; `"harbor"`,
`"7"`, `"Label"` and `"labels"` are all Pins. `marker-symbol` is case-sensitive here because that is
what a string comparison in a file format is; say so where the constant is defined if it is not
already said.

**Transfer carries a Label because it carries the Layer's file.** Neither the Bundle nor the Backup
knows what an Annotation is, and neither should learn. These are assertions about the artefacts, not
changes to them.

## User Stories

48. As an author, I want a Layer of Labels opened in geojson.io to show titled markers rather than
    nothing, so that the portability claim holds for the new kind too.
49. As an author, I want a Label written by another tool — a Point carrying the same marker symbol — to
    open here as a Label, so that the convention is a format and not a private flag.
50. As an author, I want a file I only looked at to be byte-identical afterwards, so that opening a
    Project never produces a diff.
51. As an author, I want a Point carrying an unknown marker symbol to stay a Pin and keep that symbol
    when written back, so that this app never destroys something it does not understand.
52. As an author, I want a Label to survive an export and reopen in a Review Workspace, so that sending
    a Project to a colleague sends its Labels with it.
53. As an author, I want a Label to survive a Backup and restore, so that the new kind is not a hole in
    my recovery.

## Out of scope

- **Reaching geojson.io.** Story 48 is asserted as a property of the *file* — a `Feature` of type
  `Point`, with `title` and simplestyle properties and no key outside the spec — not by driving
  another website. The suite may not reach the network.
- **A migration.** No existing Project changes and no file is rewritten because it was opened.
- **Teaching the Bundle or the Backup about Annotations.** They carry bytes and must keep carrying
  bytes; `assertReferencesPresent` must still validate presence without parsing.
- **Importing from other formats.** KML, shapefiles, CSV — none of it.
- **A conformance gate.** `simpleStyleViolations` stays a test and review instrument. Nothing in the
  app refuses to draw a non-conforming Annotation.

## Acceptance criteria

- [ ] A Layer containing a Label parses and serialises back to identical bytes.
- [ ] A hand-written document carrying a Point with `marker-symbol: "label"` and a `title`, and no
      other Ballastella-written field, opens as a Label and draws.
- [ ] A Point with `marker-symbol: "harbor"` opens as a Pin, draws as a Pin, and still carries
      `"harbor"` after a write prompted by an unrelated edit in the same Layer.
- [ ] `marker-symbol` comparison is case-sensitive, asserted with `"Label"`.
- [ ] A Label's serialised `properties` contain only simplestyle names — asserted by
      `simpleStyleViolations` returning `[]` and by no key outside the spec's list.
- [ ] In a browser: a Project containing a Label opened and merely *looked at* leaves every file under
      the Project hash-identical.
- [ ] In a browser: exporting a Project Bundle containing a Label and opening it into a Review
      Workspace shows the Label drawn, with its words and colours.
- [ ] In a browser: a Backup taken with a Label in it and restored brings the Label back drawn.

```bash
pnpm --filter @ballastella/core exec vitest run --project node -t "round trip"
pnpm --filter @ballastella/core exec vitest run --project node -t "marker-symbol"
pnpm test:e2e editor-transfer
pnpm test:e2e editor-backup
pnpm precommit
```

Success: all green, and the byte-identity case names the Label explicitly rather than folding it into
an existing fixture where a regression could hide.

## Blocked by

- Ticket 03 — the app has to be able to write a Label before its files can be asserted.

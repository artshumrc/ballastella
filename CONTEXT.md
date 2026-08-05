# Ballastella

A browser-based tool for placing historical map images onto the modern world and annotating them, where a scholar's work lives as ordinary files they own rather than rows in someone else's database.

A **ballastella** — also Jacob's staff — is a graduated pole with a sliding crosspiece, used from the fourteenth century to measure the angular height of a star above the horizon and so establish one's position. It is the ancestor of the sextant. The name was chosen because a Control Point pair is a sighting: the user observes a feature on a historical map, observes the same feature on the earth, and the correspondence yields a position. See [ADR-0023](./docs/adr/0023-the-name-ballastella.md).

## Language

**Workspace**:
The one place a user keeps all their projects — a directory they choose, holding every project as a subdirectory. Published, a workspace is a hub page listing the projects inside it.
_Avoid_: library, root, vault, home

**Project**:
One coherent piece of work within a workspace: the historical maps brought in for it, the alignments made, the annotations written, and the order those are stacked in. A project is a directory of files the user owns, not a record in a database.
_Avoid_: workspace, document, map (for the whole), collection

**Published Site**:
A project directory that has had a read-only viewer written into it, so that anyone with a web server — or none, in the case of a local folder — can look at the work without being able to change it. Publishing adds files to a project; it does not produce a separate copy of it.
_Avoid_: export, build, deployment, website

**Layer**:
One entry in a project's ordered stack. A layer references its content and carries only how that content is presented — its name, whether it is visible, and where it sits in the stack. Layers come in kinds: an aligned historical map, or a set of annotations.
_Avoid_: overlay, track, group

**Historical Map**:
The scanned or photographed map a scholar is working with — the thing being aligned. Always qualified, because "map" alone is ambiguous in this project.
_Avoid_: map, image, scan, source

**Base Map**:
The modern reference map of the world that historical maps are aligned onto and annotations are placed over. One of several the user can switch between.
_Avoid_: map, background, tiles

**Align / Alignment**:
To establish the correspondence between a historical map image and locations on the earth, and the artifact that records it — its control points, resource mask, and transformation type. One word, used as both verb and noun, in the UI and in the code.
_Avoid_: georeference, warp, pin, register, rectify, GeoreferencedMap

**Control Point**:
A single correspondence between one point on a historical map image and one point on the earth. Control points are paired by nature — a control point without both halves is incomplete, not merely empty.
_Avoid_: GCP, tie point, marker, pin

**Resource Mask**:
The outline of the part of a historical map image that should be shown once georeferenced — the map itself, excluding margins, titles, and decorative surround.
_Avoid_: crop, clip, cutline, boundary

**Annotation**:
A piece of scholarly content a user places on the map: a label, pin, route, or shape. Author-facing, and the reason the tool exists. Never used for georeferencing data.
_Avoid_: feature, marker, note, overlay

**Georeference Annotation**:
The IIIF Georeference Extension document format that an Alignment serialises to. A file format, never a user-facing concept — this term, and Allmaps' `GeoreferencedMap`, appear only in the module that reads and writes it. The UI may still *teach* the word "georeferencing" in help text; it is simply not what the model is organised around.

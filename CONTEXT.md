# Ballastella

A browser-based tool for placing historical map images onto the modern world and annotating them, where a scholar's work lives as ordinary files they own rather than rows in someone else's database.

A **ballastella** — also Jacob's staff — is a graduated pole with a sliding crosspiece, used from the fourteenth century to measure the angular height of a star above the horizon and so establish one's position. It is the ancestor of the sextant. The name was chosen because a Control Point pair is a sighting: the user observes a feature on a historical map, observes the same feature on the earth, and the correspondence yields a position.

## Language

**Workspace**:
The one place a user keeps their work — a directory they choose, holding every project as a subdirectory and every historical map they have brought in. Published, a workspace is a hub page listing the projects inside it.
_Avoid_: library, root, vault, home

**Project**:
One coherent piece of work within a workspace: which of the workspace's historical maps it uses, the alignments made for them, the annotations written, and the order those are stacked in. A project is a directory of files the user owns, not a record in a database. It composes historical maps rather than containing them, so one map can appear in several projects (ADR-0023).
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

**Library**:
The institution whose server a referenced historical map's tiles stay on — the thing a scholar cites, and the thing that reorganises and breaks their links. Reserved for that meaning alone: never used for the workspace, and never for a user's own collection of historical maps.
_Avoid_: repository, host, provider, source

**Base Map**:
The modern reference map of the world that historical maps are aligned onto and annotations are placed over. One of several the user can switch between.
_Avoid_: map, background, tiles

**Align / Alignment**:
To establish the correspondence between a historical map image and locations on the earth, and the artifact that records it — its control points, resource mask, and transformation type. One word, used as both verb and noun, in the UI and in the code. There is exactly one alignment per historical map, belonging to the workspace and shared by every project that uses that map (ADR-0023).
_Avoid_: georeference, warp, pin, register, rectify, GeoreferencedMap

**Offline Copy**:
A referenced historical map whose tiles have been fetched into the workspace, so it no longer needs the network and survives the library reorganising. The address it came from is kept, so it can still be cited. The user-facing verb is "make an offline copy".
_Avoid_: mirror, cache, download, localise

**Review Workspace**:
A throwaway workspace holding one project someone else sent, opened to be looked at and then discarded. Never merged into the user's own workspace, and nothing in it can be promoted out of it.
_Avoid_: sandbox, preview, scratch, temp

**Control Point**:
A single correspondence between one point on a historical map image and one point on the earth. Control points are paired by nature — a control point without both halves is incomplete, not merely empty.
_Avoid_: GCP, tie point, marker, pin

**Resource Mask**:
The outline of the part of a historical map image that should be shown once georeferenced — the map itself, excluding margins, titles, and decorative surround.
_Avoid_: crop, clip, cutline, boundary

**Annotation**:
A piece of scholarly content a user places on the map: a label, pin, route, or shape. Author-facing, and the reason the tool exists. Never used for georeferencing data.
_Avoid_: feature, marker, note, overlay

**Write-Ahead Journal**:
Where an edit's bytes wait between the keystroke and the moment the Workspace has them — a synchronous copy in browser storage, keyed by Workspace and by file, written before the store write and thrown away as soon as it lands (ADR-0017 rule 3, ADR-0001). It exists because a page being closed does not finish an asynchronous write. It holds only what the Workspace has not taken, which is usually nothing — but a write that failed is kept deliberately, and a Workspace nobody reopens keeps its entries until someone says otherwise. It is not a store, not a backup, and not durable. User-facing, putting those bytes back at startup is **putting a change back**, and it is said in words rather than done quietly.
_Avoid_: cache, buffer, autosave file, draft, recovery file

**Georeference Annotation**:
The IIIF Georeference Extension document format that an Alignment serialises to. A file format, never a user-facing concept — this term, and Allmaps' `GeoreferencedMap`, appear only in the module that reads and writes it. The UI may still *teach* the word "georeferencing" in help text; it is simply not what the model is organised around.

# Ballastella

A browser-based tool for placing map images onto the modern world and annotating them, where a scholar's work lives as ordinary files they own rather than rows in someone else's database.

A **ballastella** — also Jacob's staff — is a graduated pole with a sliding crosspiece, used from the fourteenth century to measure the angular height of a star above the horizon and so establish one's position. It is the ancestor of the sextant. The name was chosen because a Control Point pair is a sighting: the user observes a feature on a map image, observes the same feature on the earth, and the correspondence yields a position.

## Language

**Workspace**:
The one place a user keeps their work — a directory they choose, holding every project as a subdirectory and every map image they have brought in. Published, a workspace is a Front Page listing the projects inside it.
_Avoid_: library, root, vault, home

**Project**:
One coherent piece of work within a workspace: which of the workspace's map images it uses, the alignments made for them, the annotations written, and the order those are stacked in. A project is a directory of files the user owns, not a record in a database. It composes map images rather than containing them, so one map can appear in several projects (ADR-0023).
_Avoid_: workspace, document, map (for the whole), collection

**Published Site**:
A Workspace as a Reader meets it — the same files the author owns, with a read-only viewer written in beside them, answering at a web address. Publishing adds files to the Workspace; it never produces a separate copy of it.
_Avoid_: build, deployment, website. "Export" belongs to a Project Bundle and a Backup; publishing is never an export.

**Publish**:
To send a Workspace's files to its Remote, so that the Published Site at that address becomes the work as it now stands. One act and one word: it uploads, and what it uploads is readable by anyone. Never automatic and never silent — an edit is saved locally the moment it is made, and reaches the Remote only when someone presses the button.
_Avoid_: sync, deploy, upload, push, save to the cloud

**Front Page**:
The Published Site's root: where a Reader arrives, listing the Projects offered to them. Each Project is either on the Front Page or not, and not being on it says nothing about who can read the Project — the files are public either way.
_Avoid_: hub, landing page, index, home

**Workspace Home**:
The Workspace's own root, in either app: what a person meets before they have opened a Project. The Editor's lists the Workspace's Projects and its Map Images; the Viewer's lists only the Projects on the Front Page, because a Reader has no Workspace and Map Images are not a Reader's concern. One name for one surface, so that a sentence about it does not have to say which app it means — and *not* a word a user ever reads: to a Reader that surface is labelled the Front Page, and to an author it is labelled Projects.
_Avoid_: hub, dashboard, project hub, root page, home page

**Remote**:
The one GitHub repository a Workspace can be bound to, where its Published Site lives. At most one per Workspace, and orthogonal to where the Workspace's own bytes are kept — a Workspace in browser storage and a Workspace in a folder can each have one. A Review Workspace can never have one.
_Avoid_: origin, cloud, backend, server, sync target, host

**Layer**:
One entry in a project's ordered stack. A layer references its content and carries only how that content is presented — its name, whether it is visible, and where it sits in the stack. Layers come in kinds: an aligned map image, or a set of annotations.
_Avoid_: overlay, track, group

**Map Image**:
The scanned or photographed map a scholar is working with — the thing being aligned. Always both words. "Map" alone is ambiguous in this project, and "image" alone is worse: an image is any picture, while a Map Image is the one a scholar brought in to align. It is distinct from a Base Map, which is also drawn from images but is the modern reference the Map Image is placed onto, never itself aligned.
_Avoid_: map, image, scan, source, historical map. "Image Pane" is not a counter-example: it names an implementation seam, not a domain term (see below).

**Library**:
The institution whose server a referenced map image's tiles stay on — the thing a scholar cites, and the thing that reorganises and breaks their links. Reserved for that meaning alone: never used for the workspace, and never for a user's own collection of map images.
_Avoid_: repository, host, provider, source

**Base Map**:
The modern reference map of the world that map images are aligned onto and annotations are placed over. One of several the user can switch between.
_Avoid_: map, background, tiles

**Align / Alignment**:
To establish the correspondence between a map image and locations on the earth, and the artifact that records it — its control points, resource mask, and transformation type. One word, used as both verb and noun, in the UI and in the code. There is exactly one alignment per map image, belonging to the workspace and shared by every project that uses that map (ADR-0023).
_Avoid_: georeference, warp, pin, register, rectify, GeoreferencedMap

**Offline Copy**:
A referenced map image whose tiles have been fetched into the workspace, so it no longer needs the network and survives the library reorganising. The address it came from is kept, so it can still be cited. The user-facing verb is "make an offline copy".
_Avoid_: mirror, cache, download, localise

**Project Bundle**:
A tar of one Project and every Map Image, Alignment, and Annotation its Layers reference, made to be sent to somebody. It opens only into a Review Workspace and is never merged into the recipient's own (ADR-0024). The verb is "export".
_Avoid_: zip, archive, package, submission, share

**Review Workspace**:
A throwaway workspace holding one project someone else sent, opened to be looked at and then discarded. Never merged into the user's own workspace, and nothing in it can be promoted out of it.
_Avoid_: sandbox, preview, scratch, temp

**Control Point**:
A single correspondence between one point on a map image and one point on the earth. Control points are paired by nature — a control point without both halves is incomplete, not merely empty.
_Avoid_: GCP, tie point, marker, pin

**Resource Mask**:
The outline of the part of a map image that should be shown once georeferenced — the map itself, excluding margins, titles, and decorative surround.
_Avoid_: crop, clip, cutline, boundary

**Annotation**:
A piece of scholarly content a user places on the map: a label, pin, route, or shape. Author-facing, and the reason the tool exists. Never used for georeferencing data.
_Avoid_: feature, marker, note, overlay

**Label**:
An Annotation whose content is drawn on the map — a scholar's own words, set at a place on the earth, in a colour and a size they chose. A Point like a Pin, and everything a Pin has it has; what differs is that what is drawn at its place is its own words. Stored as a Point whose `marker-symbol` is `label` (ADR-0009).
_Avoid_: text, caption, marker, title, annotation text

**Annotation Inspector**:
The docked panel where one Annotation's content is read and, in the editor, changed — its title, its rendered description, and for an author how the Annotation is drawn. It is docked over the map rather than beside it, it is headed by the same ordinal, shape glyph and shape word the Annotation's row carries, and one is on screen at a time. Membership in a Layer is not its business: that is what the Layer stack says (ADR-0035).
_Avoid_: panel, popup, drawer, sidebar, detail view. "Panel" especially: `AnnotationPanel` names a component this project has already deleted, and a returning name that means something else is worse than a new one.

**Place**:
One candidate answer to a place name a scholar typed — a name and a point on the earth, offered by a lookup rather than drawn. A lookup typically offers several and the scholar picks one; what it gives them is a starting point, frequently wrong, and correcting it against the Base Map or a Map Image is the scholarly act rather than an inconvenience. A Place is transient by design: choosing one either moves the map or drops an ordinary Annotation, and nothing in a Project's files records that a Place was ever involved. The service that answers has no name here, in the UI or in this glossary.
_Avoid_: result, hit, match, location, address, feature, gazetteer, geocode

**Write-Ahead Journal**:
Where an edit's bytes wait between the keystroke and the moment the Workspace has them — a synchronous copy in browser storage, keyed by Workspace and by file, written before the store write and thrown away as soon as it lands (ADR-0017 rule 3, ADR-0001). It exists because a page being closed does not finish an asynchronous write. It holds only what the Workspace has not taken, which is usually nothing — but a write that failed is kept deliberately, and a Workspace nobody reopens keeps its entries until someone says otherwise. It is not a store, not a backup, and not durable. User-facing, putting those bytes back at startup is **putting a change back**, and it is said in words rather than done quietly.
_Avoid_: cache, buffer, autosave file, draft, recovery file

**Georeference Annotation**:
The IIIF Georeference Extension document format that an Alignment serialises to. A file format, never a user-facing concept — this term, and Allmaps' `GeoreferencedMap`, appear only in the module that reads and writes it. The UI may still *teach* the word "georeferencing" in help text; it is simply not what the model is organised around.

**Image Pane**:
The seam that draws one IIIF pyramid unwarped, in its own image pixels, on a synthetic projection. Deliberately *not* a domain term and deliberately not renamed alongside Map Image: it knows nothing about maps, takes any pyramid, and its "image" means an image in the ordinary sense. It names a component and a `@ballastella/core` type, never a thing a scholar has. What a scholar sees is a Map Image drawn in one — `MapImagePane` — and that is the name to use for the pane in the UI and in anything user-facing.
_Avoid_: map pane, viewer, canvas. Do not read "Image Pane" as a second sense of Map Image.

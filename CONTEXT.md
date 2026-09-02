# Ballastella

A browser-based tool for placing map images onto the modern world and annotating them, where a scholar's work lives as ordinary files they own rather than rows in someone else's database.

A **ballastella** — also Jacob's staff — is a graduated pole with a sliding crosspiece, used from the fourteenth century to measure the angular height of a star above the horizon and so establish one's position. It is the ancestor of the sextant. The name was chosen because a Control Point pair is a sighting: the user observes a feature on a map image, observes the same feature on the earth, and the correspondence yields a position.

## Language

**Workspace**:
The one place a user keeps their work — a directory they choose, holding every project as a subdirectory and every map image they have brought in. Where its author has asked for Share Links, a workspace also answers at a web address, whose Front Page lists the projects put there.
_Avoid_: library, root, vault, home

**Project**:
One coherent piece of work within a workspace: which of the workspace's map images it uses, the alignments made for them, the annotations written, and the order those are stacked in. A project is a directory of files the user owns, not a record in a database. It composes map images rather than containing them, so one map can appear in several projects (ADR-0023).
_Avoid_: workspace, document, map (for the whole), collection

**Remote**:
The one GitHub repository a Workspace can be bound to, holding the Workspace's files as their author owns them. It may be public or private. The relationship is local-only, never learned from repository content, and orthogonal to where the Workspace's own bytes are kept; a Review Workspace can never have one. A Remote implies no web address — whether the repository also answers as a Published Site is what Share Links decides.
_Avoid_: origin, cloud, backend, server, sync target, host. Not "backup": a Backup restores *this* Workspace, where a Remote yields a new one hydrated from it (ADR-0024).

**Sync**:
To bring a Workspace and its Remote into agreement, in either direction or both. One act and one word, and never a silent one: it states what each side holds and what each choice would add and remove before anything moves, and the author chooses to get, to send, to do both, or to overwrite the Remote with the Workspace. Sending removes from the Remote only what the Synchronization Baseline recorded and the Workspace no longer has, so work that reached the Remote from elsewhere survives an author who has not yet seen it; overwriting is the exception that removes everything the Workspace does not have, and names it first. What travels is the author's own files — Map Images, Alignments, Projects, Annotations, offline Base Map tiles — and nothing about a website (ADR-0044).
_Avoid_: publish, deploy, upload, push, pull, save to the cloud, backup, merge

**Synchronization Baseline**:
The last state a Workspace and its Remote successfully shared through a Sync. Checking Remote Status observes drift from it but never advances it. With no Baseline a Sync may still send and get; what it may not do is remove anything from either side, because nothing records what the two sides once agreed on.
_Avoid_: last checked state, latest Remote state

**Cannot tell**:
The Remote Status of a Workspace that has a Remote and no trustworthy Synchronization Baseline. It says that Ballastella cannot attribute differences to the Workspace or the Remote, not that either side is unchanged or in Conflict.
_Avoid_: unknown, in sync

**Conflict**:
One file changed on both sides of the Synchronization Baseline. A Conflict does not stop a Sync: everything that can move safely moves in both directions, and the contested file becomes a Conflict Copy. The exception is an Alignment, of which there is exactly one per Map Image (ADR-0023), where a second copy would be referenced by nothing and drawn nowhere; there the author is asked which of the two to keep.
_Avoid_: merge conflict, divergence

**Conflict Copy**:
The second version of a contested file, made so that both can be looked at and one deleted. It is made at the coarsest contested unit — a contested set of Annotations becomes another Layer, a contested Project becomes another Project and its Layers do not also double — and once the Sync finishes it exists on both sides, so every machine sees both versions. Ballastella never merges the two and never chooses between them (ADR-0046).
_Avoid_: version, branch, revision, duplicate

**Remote Status**:
The last checked relationship between a Workspace and its Remote: in sync, changes to send, changes to get, changes both ways, or Cannot tell. It is said together with whether the work is saved on this machine and never in place of it, and the repository is named only where the two sides actually agree, so that naming one is the report of a fact rather than of an intention. Ballastella checks automatically only while the user is authenticated.
_Avoid_: ahead, behind, dirty, diverged, connected, published, up to date

**Share Links**:
What a Workspace's Remote gains when its author asks for it: a Published Site at a web address, so that a Project can be opened by a link. Asked for once, in the Workspace's own settings, and separate from a Sync in both directions — a Workspace syncs perfectly well with no address at all. Withdrawing them takes the site down and breaks every link already given out; it is never a way to make what was public private again (ADR-0045).
_Avoid_: publish, deploy, go live, hosting, website

**Published Site**:
A Workspace as a Reader meets it — the same files the author owns, with a read-only viewer written in beside them, answering at a web address. It is added to the Remote when Share Links are enabled and kept current by every Sync after that; it is never a separate copy of the Workspace.
_Avoid_: build, deployment, website. "Export" belongs to a Project Bundle and a Backup.

**Front Page**:
The Published Site's root: where a Reader arrives, listing the Projects put there. A Project is on it only because its author said so, one Project at a time. Being absent from it says nothing about who may read the Project — anyone holding the link can — and a Front Page with nothing on it says nothing at all, so that an empty one cannot be read as a hint that something unlisted is there.
_Avoid_: hub, landing page, index, home

**Share Project**:
To take the link at which one Project can be read and give it to somebody. The Project need not be on the Front Page; the link works either way, which is why the Front Page is discovery and never permission. It needs the Workspace's Share Links and offers them where they are absent, and it needs that Project's work to have reached the Remote, or the link answers with yesterday's.
_Avoid_: publish, export, invite, permalink. Never a private link: it is public and guessable.

**Workspace Home**:
The Workspace's own root, in either app: what a person meets before they have opened a Project. The Editor's lists the Workspace's Projects and its Map Images; the Workspace editing dialog reached from its roster row holds a Backup, a Restore, what this browser has promised about keeping the work, the offer to install that answers it, unsaved changes with nowhere to go, the one way an existing Workspace reaches a folder on disk (ADR-0042), which repository it syncs with, and whether it has Share Links. What may be done to the *Workspaces*, plural, is the roster on the bar; the Viewer's lists only the Projects on the Front Page, because a Reader has no Workspace and Map Images are not a Reader's concern. One name for one surface, so that a sentence about it does not have to say which app it means — and *not* a word a user ever reads: to a Reader that surface is labelled the Front Page, and to an author it is labelled Projects.
_Avoid_: hub, dashboard, project hub, root page, home page

**Installation**:
The grant a GitHub App holds on one account, carrying the list of repositories it may touch. Not a Ballastella concept and not a word the UI says: it is GitHub's, it appears only in the modules that read `/user/installations`, and an author meets it as a sentence about what Ballastella can see rather than as a term to learn (ADR-0040). Distinct from the App itself, which is an identity — the client ID and callback URL deciding which deployment may ask for a token — and confusing the two is why a repository an author had admin rights to could be invisible to the tool.
_Avoid_: app, grant, permission, access. Do not read it as a second sense of Remote: a Workspace has one Remote, while an Installation covers every repository on an account.

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
The modern reference map of the world that map images are aligned onto and annotations are placed over. Drawn from one set of tiles, with three independent switches over how it looks — streets, topography, high contrast — which the author sets and a reader may override for themselves. A deployment offering more than one set of tiles also lets them be switched between.
_Avoid_: map, background, tiles, variant

**Map Snapshot**:
A clean illustration of a Project's current geographic view: the Base Map and the Map Images and Annotations in visible Layers as they are presently configured and framed, without the application's controls, authoring aids, or embedded attribution. The scholar supplies attribution where the illustration is used. Authors and Readers can download one as an ordinary PNG once everything needed to draw that frame is available; it carries no coordinates or other GIS data.
_Avoid_: screenshot, Map Image, export

**Align / Alignment**:
To establish the correspondence between a map image and locations on the earth, and the artifact that records it — its control points, resource mask, and transformation type. One word, used as both verb and noun, in the UI and in the code. There is exactly one alignment per map image, belonging to the workspace and shared by every project that uses that map (ADR-0023).
_Avoid_: georeference, warp, pin, register, rectify, GeoreferencedMap

**Offline Copy**:
A referenced map image whose tiles have been fetched into the workspace, so it no longer needs the network and survives the library reorganising. The address it came from is kept, so it can still be cited. The user-facing verb is "make an offline copy".
_Avoid_: mirror, cache, download, localise

**Project Bundle**:
A tar of one Project and every Map Image, Alignment, and Annotation its Layers reference, made to be sent to somebody. It can be opened in a Review Workspace or imported into the recipient's current Workspace. The verb for making one is "export".
_Avoid_: zip, archive, package, submission, share

**Import**:
To add a detached copy of a Project from outside the Workspace currently open, whether it arrives as a Project Bundle, from a Published Site, or from a Review Workspace. Importing does not create or switch to another Workspace, does not retain a Remote or any other ongoing relationship with its source, and gives every incoming Map Image a distinct identity; a conflicting Project name is disambiguated rather than overwritten, and the imported Project stays off the Front Page until its new owner puts it there.
_Avoid_: open, review, restore, clone

**Import Provenance**:
A visible, read-only history of the origins through which an imported Project was copied: repository, Project address, and commit observed during a GitHub transfer, or the filename and embedded Project name observed in a Project Bundle. Each transfer appends an entry without claiming authorship or creating an ongoing relationship; inherited entries are identified as inherited rather than independently verified, and an original publication address belongs here rather than to the imported Project.
_Avoid_: Remote, binding, origin

**Review Workspace**:
A throwaway workspace holding one Project from outside the user's own Workspace, opened to be examined in isolation. Its current state can be imported into the ordinary Workspace from which review began, after which the Review Workspace is discarded; the Review Workspace itself is never merged or made permanent.
_Avoid_: sandbox, preview, scratch, temp

**Control Point**:
A single correspondence between one point on a map image and one point on the earth. Control points are paired by nature — a control point without both halves is incomplete, not merely empty.
_Avoid_: GCP, tie point, marker, pin

**Resource Mask**:
The outline of the part of a map image that should be shown once georeferenced — the map itself, excluding margins, titles, and decorative surround. **Crop** is the label of the control that edits it, and only that: the outline itself is a Resource Mask everywhere else.
_Avoid_: clip, cutline, boundary. Not "crop" for the outline — a cropped sheet is one whose Resource Mask has been drawn.

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

**Edit History**:
The last few edits a scholar made on one screen, in the order they made them, so that any of them can be taken back and put back again. One per subject — a Project's, a Map Image's Alignment — and shown only on the screen that subject belongs to, so that an edit made in one place is never offered for undoing in another. Workspace Home has none. Linear and bounded: there is no branching, and reaching back far enough forgets the beginning. It lives only as long as the session, and putting a change back at startup is the Write-Ahead Journal's business rather than this one's.
_Avoid_: undo stack, history stack, command stack, timeline, journal

**Step**:
One entry in an Edit History: a single edit as the scholar meant it, whatever number of writes it took — a drag is one Step, however many positions it reported. Typed text is no Step at all: naming things stays the browser’s to undo, and a name typed after a Step survives that Step being taken back. A Step is named after the act and its subject and never after the values involved, because the same Step is read forwards and backwards.
_Avoid_: command, operation, transaction, revision, change

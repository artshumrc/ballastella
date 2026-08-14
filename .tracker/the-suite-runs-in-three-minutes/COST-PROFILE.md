# Seam 2 cost profile

⚠ **Generated. Do not edit by hand** — regenerate with `pnpm test:e2e --profile`
(`scripts/cost-profile.mjs`), which appends a reporter rather than replacing the list, so a
profiled run keeps the retry budget and gives the gate’s verdict.

**Worker-seconds, not wall time.** A test’s cost is the time a worker spent inside it, summed
over every attempt. That is what moving the claim to another seam actually removes; wall time
depends on how the scheduler packed the run.

| Run | 2026-08-14 |
| --- | --- |
| Command | `pnpm test:e2e --profile` |
| Tests | 636 |
| Skipped (not counted above) | 1 |
| Workers | 4 |
| Wall clock | 809.7s |
| Worker-seconds | 2954.7s |

| Spec | Tests | Worker-seconds | Per test |
| --- | ---: | ---: | ---: |
| `e2e/editor-layers.e2e.ts` | 36 | 485.2 | 13.48 |
| `e2e/editor-annotations.e2e.ts` | 40 | 397.0 | 9.93 |
| `e2e/viewer-reader.e2e.ts` | 63 | 330.1 | 5.24 |
| `e2e/editor-alignment-refinement.e2e.ts` | 21 | 177.4 | 8.45 |
| `e2e/editor-undo.e2e.ts` | 14 | 172.3 | 12.30 |
| `e2e/editor-base-map.e2e.ts` | 36 | 117.3 | 3.26 |
| `e2e/editor-add-historical-map.e2e.ts` | 18 | 111.2 | 6.18 |
| `e2e/editor-align-referenced.e2e.ts` | 17 | 109.5 | 6.44 |
| `e2e/editor-alignment.e2e.ts` | 18 | 98.0 | 5.45 |
| `e2e/editor-remote-iiif.e2e.ts` | 18 | 92.7 | 5.15 |
| `e2e/editor-offline-copy.e2e.ts` | 17 | 74.5 | 4.38 |
| `e2e/editor-folder-workspace.e2e.ts` | 23 | 68.9 | 3.00 |
| `e2e/editor-opening-view.e2e.ts` | 12 | 68.0 | 5.67 |
| `e2e/editor-publish.e2e.ts` | 27 | 62.1 | 2.30 |
| `e2e/editor-transfer.e2e.ts` | 30 | 61.0 | 2.03 |
| `e2e/editor-workspace.e2e.ts` | 41 | 60.1 | 1.47 |
| `e2e/editor-remote-binding.e2e.ts` | 20 | 58.8 | 2.94 |
| `e2e/editor-clone-remote.e2e.ts` | 18 | 52.7 | 2.93 |
| `e2e/editor-project-screen.e2e.ts` | 20 | 51.6 | 2.58 |
| `e2e/editor-align-route.e2e.ts` | 15 | 48.9 | 3.26 |
| `e2e/editor-pwa.e2e.ts` | 23 | 41.7 | 1.81 |
| `e2e/editor-remote-conflict.e2e.ts` | 5 | 32.0 | 6.40 |
| `e2e/editor-stored-image-pane.e2e.ts` | 6 | 30.7 | 5.11 |
| `e2e/editor-warped-fetch.e2e.ts` | 3 | 26.8 | 8.94 |
| `e2e/editor-image-ingest.e2e.ts` | 9 | 25.8 | 2.87 |
| `e2e/editor-named-workspaces.e2e.ts` | 21 | 25.0 | 1.19 |
| `e2e/editor-review-remote.e2e.ts` | 20 | 24.2 | 1.21 |
| `e2e/editor-github-signin.e2e.ts` | 20 | 20.0 | 1.00 |
| `e2e/editor-backup.e2e.ts` | 6 | 14.0 | 2.33 |
| `e2e/editor-image-pane.e2e.ts` | 5 | 9.7 | 1.93 |
| `e2e/editor-historical-map-thumbnails.e2e.ts` | 4 | 5.5 | 1.36 |
| `e2e/editor-network-fence.e2e.ts` | 7 | 1.2 | 0.17 |
| `e2e/editor.e2e.ts` | 1 | 0.3 | 0.33 |
| `e2e/viewer.e2e.ts` | 2 | 0.3 | 0.14 |
| `e2e/editor-retry-budget-control.e2e.ts` | 0 | 0.0 | 0.00 |
| **total** | **636** | **2954.7** | **4.65** |

## The 5 costliest tests in each spec

### `e2e/editor-layers.e2e.ts` — 485.2s over 36 tests

- 39.0s — editor › editor-layers.e2e.ts › a Base Map that never finishes loading › says why the Layer cannot be drawn rather than leaving the list silent
- 32.3s — editor › editor-layers.e2e.ts › showing and hiding a Layer (SPEC story 50) › survives a reload, for both kinds
- 29.3s — editor › editor-layers.e2e.ts › showing and hiding a Layer (SPEC story 50) › draws the Historical Map warped, and takes it off the map when hidden
- 25.2s — editor › editor-layers.e2e.ts › adding an Annotation Layer (SPEC stories 55 and 56) › gives two clicks two Layers, and leaves no orphaned FeatureCollection
- 25.2s — editor › editor-layers.e2e.ts › leaving the Project screen and coming back › goes to Align from the Layer and lands back on the same Project

### `e2e/editor-annotations.e2e.ts` — 397.0s over 40 tests

- 23.5s — editor › editor-annotations.e2e.ts › drawing (SPEC stories 57, 58, 59) › all three appear on the map, each painted by the layer for its geometry
- 23.1s — editor › editor-annotations.e2e.ts › the keyboard alone (SPEC stories 95 and 96) › every drawing tool and style control is reachable and operable, and the tool is announced
- 20.5s — editor › editor-annotations.e2e.ts › drawing (SPEC stories 57, 58, 59) › a pin, a line, and a shape are drawn and land in the Annotation Layer’s own file
- 19.1s — editor › editor-annotations.e2e.ts › drawing (SPEC stories 57, 58, 59) › a polygon’s ring is closed, which is what other tools require
- 18.4s — editor › editor-annotations.e2e.ts › drawing into the Layer that is open (ticket 05) › with no Layer open, a click on the map writes into no Layer at all

### `e2e/viewer-reader.e2e.ts` — 330.1s over 63 tests

- 99.6s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › takes the notice down by itself when the map’s own record answers again
- 13.9s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › tells a Reader when a Historical Map’s tiles stop arriving, and keeps what arrived
- 12.1s — viewer › viewer-reader.e2e.ts › the Base Map a Reader sees › two Published Sites on different paths of one origin do not share a preference
- 11.0s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › falls back with a quiet notice when the Base Map id is absent from the catalog
- 9.8s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › names the host when a referenced Historical Map’s record cannot be read

### `e2e/editor-alignment-refinement.e2e.ts` — 177.4s over 21 tests

- 23.7s — editor › editor-alignment-refinement.e2e.ts › distortion (ADR-0013) › goes on colourising after every kind of Alignment edit, without rebuilding the map
- 17.2s — editor › editor-alignment-refinement.e2e.ts › the transformation picker (ADR-0013) › a chosen type survives a reload, order and all, and reaches the renderer
- 15.2s — editor › editor-alignment-refinement.e2e.ts › the transformation picker (ADR-0013) › never writes straight, linear, or the bare polynomial alias, under any interaction
- 15.0s — editor › editor-alignment-refinement.e2e.ts › distortion (ADR-0013) › is off by default, and colours the map by log2sigma from theme-derived colours
- 12.8s — editor › editor-alignment-refinement.e2e.ts › distortion (ADR-0013) › toggles the warped graticule

### `e2e/editor-undo.e2e.ts` — 172.3s over 14 tests

- 21.7s — editor › editor-undo.e2e.ts › what the one undo slot will and will not hold (ADR-0014) › the record is cleared when the Project is closed
- 17.9s — editor › editor-undo.e2e.ts › what the one undo slot will and will not hold (ADR-0014) › the visible control is reachable with the keyboard and operable from there
- 16.7s — editor › editor-undo.e2e.ts › a deleted map Layer does not come back (the resurrection trap) › is put back by undo, and one Alignment write later there is still exactly one
- 16.3s — editor › editor-undo.e2e.ts › what the one undo slot will and will not hold (ADR-0014) › Ctrl+Z inside a text field is the field’s own undo, not ours
- 16.1s — editor › editor-undo.e2e.ts › what the one undo slot will and will not hold (ADR-0014) › a visibility toggle and a rename leave the delete still undoable

### `e2e/editor-base-map.e2e.ts` — 117.3s over 36 tests

- 10.2s — editor › editor-base-map.e2e.ts › the theme › changes the Base Map flavor in the same action as the interface
- 6.8s — editor › editor-base-map.e2e.ts › making a Project available offline › is cleared from the hub, and the Projects then report themselves not available offline
- 6.6s — editor › editor-base-map.e2e.ts › making a Project available offline › draws the Base Map across the extent with the archive unreachable, at the lowest zoom and the highest
- 6.3s — editor › editor-base-map.e2e.ts › finding a place › says all four things, each driven by the condition that causes it
- 5.4s — editor › editor-base-map.e2e.ts › making a Project available offline › still answers “is this Project available offline?” with the archive unreachable

### `e2e/editor-add-historical-map.e2e.ts` — 111.2s over 18 tests

- 14.3s — editor › editor-add-historical-map.e2e.ts › the picker’s pictures (ADR-0030, SPEC story 3) › a Workspace-held candidate shows a picture that has actually decoded
- 13.2s — editor › editor-add-historical-map.e2e.ts › the dialog itself (ADR-0016, SPEC stories 111, 112) › is never handed to a caller while the panel inside it is still working
- 9.1s — editor › editor-add-historical-map.e2e.ts › adding a map this Workspace already holds › refuses one whose record cannot be read, in words, with the dialog still open
- 8.8s — editor › editor-add-historical-map.e2e.ts › the stack while a Historical Map is being prepared › does not say the Project has no Layers over a Layer that is being prepared
- 7.2s — editor › editor-add-historical-map.e2e.ts › the picker’s pictures (ADR-0030, SPEC story 3) › a candidate whose picture cannot be resolved shows the glyph and no broken image

### `e2e/editor-align-referenced.e2e.ts` — 109.5s over 17 tests

- 13.6s — editor › editor-align-referenced.e2e.ts › aligns a level 0 service that publishes tiles in place, drawing it warped from the library
- 13.4s — editor › editor-align-referenced.e2e.ts › aligns a level 2 service in place, drawing it warped from the library
- 9.7s — editor › editor-align-referenced.e2e.ts › warns only on the Historical Map the warning is about
- 8.7s — editor › editor-align-referenced.e2e.ts › writes an Alignment addressed at the library, which round-trips unchanged
- 8.4s — editor › editor-align-referenced.e2e.ts › an offline copy of a map aligned in place keeps every Control Point

### `e2e/editor-alignment.e2e.ts` — 98.0s over 18 tests

- 8.9s — editor › editor-alignment.e2e.ts › the Alignment on disk › restores every pair, its ordinal, and the warped render across a reload
- 8.2s — editor › editor-alignment.e2e.ts › the warped Historical Map › appears over the Base Map on the third pair, and not before
- 6.4s — editor › editor-alignment.e2e.ts › the Alignment on disk › excludes an incomplete pair while one is pending, and does not throw
- 6.3s — editor › editor-alignment.e2e.ts › Control Point pairing › Escape after the first click of the very first pair writes nothing at all
- 5.6s — editor › editor-alignment.e2e.ts › the Alignment on disk › is a valid Georeference Annotation naming the image and the transformation

### `e2e/editor-remote-iiif.e2e.ts` — 92.7s over 18 tests

- 8.2s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › re-adding a map after deleting its Layer keeps the Alignment already on it
- 8.1s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › adding the same referenced map again leaves the stack byte-identical
- 7.9s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › adding a map another Project has aligned keeps that Alignment, and says so
- 6.8s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › accepts a Manifest, a Collection, and a bare image service, and browses each
- 6.8s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › a deleted map Layer comes back when the same map is added again

### `e2e/editor-offline-copy.e2e.ts` — 74.5s over 17 tests

- 12.9s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › a copied map is one pyramid that two Projects both draw
- 11.4s — editor › editor-offline-copy.e2e.ts › making an offline copy › reports progress, and announces it to assistive technology
- 7.7s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › renders warped through the injection shim with no request to the library at all
- 5.6s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › survives a reload with the network switched off, drawing from the Project
- 4.0s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › shows the hub’s picture of it from the Workspace instead of from the library

### `e2e/editor-folder-workspace.e2e.ts` — 68.9s over 23 tests

- 5.3s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › leaves the browser Workspace’s Projects untouched, in both directions
- 5.0s — editor › editor-folder-workspace.e2e.ts › a bundle opened from a folder Workspace (ticket 14) › leaves the review copy even when it holds the name the exit goes back to
- 4.0s — editor › editor-folder-workspace.e2e.ts › an interrupted write to a real folder (ADR-0017 rule 4) › leaves the previous project.json intact, parseable, and with no litter beside it
- 3.7s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › writes a Project the browser backend reads with no conversion, once copied in
- 3.7s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › keeps the folder when "Use browser storage instead" is the escape from an unreachable one

### `e2e/editor-opening-view.e2e.ts` — 68.0s over 12 tests

- 11.9s — editor › editor-opening-view.e2e.ts › the alignment view › lands on the Control Points, and a moved Control Point leaves the map alone
- 9.3s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › a toggled Layer, a renamed Layer, and a new Annotation all leave the viewport alone
- 8.3s — editor › editor-opening-view.e2e.ts › a Project opens on its own content › opens on the deployment default when there are no Layers at all
- 8.1s — editor › editor-opening-view.e2e.ts › a Project opens on its own content › opens on the deployment default when its only Historical Map is unaligned
- 7.7s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › “Fit to this Project” re-frames on demand, and says so

### `e2e/editor-publish.e2e.ts` — 62.1s over 27 tests

- 5.8s — editor › editor-publish.e2e.ts › publishing a Workspace › announces progress from inside the modal, where the document is not inert
- 5.7s — editor › editor-publish.e2e.ts › publishing a Workspace › stamps every info.json id with the canonical address, and the editor still opens it
- 4.6s — editor › editor-publish.e2e.ts › publishing to a Remote › announces files done, files total and the requests left, and keeps focus
- 3.6s — editor › editor-publish.e2e.ts › publishing a Workspace › states the Base Map’s size before adding it, and adds those files only when asked
- 3.0s — editor › editor-publish.e2e.ts › publishing a Workspace › serves a working site from a domain root and from a subdirectory, from one build

### `e2e/editor-transfer.e2e.ts` — 61.0s over 30 tests

- 5.2s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › is explored as though it were the reader’s own: panned, toggled, and read
- 4.4s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › is absent from the user’s own Project list, backup, and size
- 4.0s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › two review copies show their own Alignment of the same sheet
- 3.4s — editor › editor-transfer.e2e.ts › the review banner is on every screen (workspace-and-layers SPEC story 92) › both exits work from the keyboard alone (workspace-and-layers SPEC story 95)
- 2.8s — editor › editor-transfer.e2e.ts › the review banner is on every screen (workspace-and-layers SPEC story 92) › the discard confirmation is a real modal, dismissible with Escape

### `e2e/editor-workspace.e2e.ts` — 60.1s over 41 tests

- 3.5s — editor › editor-workspace.e2e.ts › the save indicator (ADR-0017 rule 5) › transitions saved → unsaved → saving → saved as the Project name is typed
- 2.7s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › replays the last edit to a file, not an earlier one
- 2.6s — editor › editor-workspace.e2e.ts › opening a Project and closing it (ADR-0010) › tabbing and clicking through the name field writes nothing
- 2.6s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › does not put an edit back into a Project the user deleted
- 2.4s — editor › editor-workspace.e2e.ts › flushing on hide (ADR-0017 rule 3) › pagehide flushes a write that is still inside its debounce window

### `e2e/editor-remote-binding.e2e.ts` — 58.8s over 20 tests

- 23.9s — editor › editor-remote-binding.e2e.ts › a first visit › shows no sign-in affordance anywhere
- 4.7s — editor › editor-remote-binding.e2e.ts › a Review Workspace › arrives unbound, and reads no credential while it is open (stories 40, 42)
- 3.8s — editor › editor-remote-binding.e2e.ts › the pasted credential › survives a reload and is forgotten on signing out (stories 35, 37)
- 3.2s — editor › editor-remote-binding.e2e.ts › a restored Backup › arrives unbound
- 2.8s — editor › editor-remote-binding.e2e.ts › the pasted credential › can be supplied again for a Workspace that is already bound (story 30)

### `e2e/editor-clone-remote.e2e.ts` — 52.7s over 18 tests

- 6.3s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › binds the result to the repository it came from
- 5.3s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › the cloned Project lists on the hub, opens, and draws
- 5.2s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › needs no credential, and sends none
- 5.1s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › reads bytes only from the raw host, and never from codeload
- 4.2s — editor › editor-clone-remote.e2e.ts › what a Clone never does › goes on saying what it did after the dialog is closed and the Workspace changed

### `e2e/editor-project-screen.e2e.ts` — 51.6s over 20 tests

- 4.5s — editor › editor-project-screen.e2e.ts › the Project screen › every control on it is reachable by keyboard
- 4.1s — editor › editor-project-screen.e2e.ts › the Project screen › Align on a Historical Map Layer goes to /align/, and coming back reopens the Project
- 4.1s — editor › editor-project-screen.e2e.ts › the Project screen › Escape that closes the Project menu does not abandon a part-drawn shape
- 4.1s — editor › editor-project-screen.e2e.ts › the navigation bar › is on the hub, the Project and the alignment route, carrying exactly its things
- 3.9s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › typing a name coalesces into one write, committed when the edit ends

### `e2e/editor-align-route.e2e.ts` — 48.9s over 15 tests

- 10.7s — editor › editor-align-route.e2e.ts › the alignment route › opening it writes no Alignment and adds no Layer
- 5.3s — editor › editor-align-route.e2e.ts › “Check this alignment” › does not reopen after a reload, and is not in project.json
- 4.6s — editor › editor-align-route.e2e.ts › “Check this alignment” › keeps the overlay, the measure and the grid out of the accessibility tree until opened
- 3.9s — editor › editor-align-route.e2e.ts › the route from the keyboard › reaches every control by Tab, including the way back
- 3.7s — editor › editor-align-route.e2e.ts › the alignment route › names every state it can be opened in, with a way back

### `e2e/editor-pwa.e2e.ts` — 41.7s over 23 tests

- 8.0s — editor › editor-pwa.e2e.ts › the app with the network off › a Project with a local Historical Map is fully usable with the network off
- 6.2s — editor › editor-pwa.e2e.ts › a working session that reaches other people’s servers › reads a referenced Historical Map and a Base Map that needs the network, and caches neither
- 5.4s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › a referenced Historical Map says so, names its host, and breaks nothing else
- 4.8s — editor › editor-pwa.e2e.ts › an update, and who decides when › the prompt appears, nothing reloads, and the alignment in progress is untouched
- 3.3s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › the service worker does not serve the ProjectStore

### `e2e/editor-remote-conflict.e2e.ts` — 32.0s over 5 tests

- 10.8s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › says nothing needs changing when the Remote matches, even with no record of publishing it
- 10.4s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › names the file another machine wrote, and replaces it when told to
- 4.0s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › is refused with “we cannot tell” when this browser has no record of the Remote
- 4.0s — editor › editor-remote-conflict.e2e.ts › binding to a Remote that already carries somebody else’s Projects (story 23) › goes ahead when the Remote’s Projects are all here
- 2.9s — editor › editor-remote-conflict.e2e.ts › binding to a Remote that already carries somebody else’s Projects (story 23) › is refused, names the Project, and points at Clone

### `e2e/editor-stored-image-pane.e2e.ts` — 30.7s over 6 tests

- 10.4s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › renders the correct pyramid for each of two Historical Maps in one Project
- 5.2s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › deep-zooms the user’s own pyramid with nothing fetched from the network
- 5.1s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › surfaces a pyramid it refuses to draw, instead of a blank map
- 5.0s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › hands the ragged-edge drawing a fractional placement, on a real pyramid
- 4.6s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › is operable from the keyboard, and reports the pixel under the pointer

### `e2e/editor-warped-fetch.e2e.ts` — 26.8s over 3 tests

- 10.3s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › reaches the pyramid’s info.json AND its tiles through the shim
- 9.4s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › adds no warped layer below the minimum Control Point count, and asks the network for nothing
- 7.2s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › accepts the Alignment and reports bounds once there are three pairs, with nothing fetched from the network

### `e2e/editor-image-ingest.e2e.ts` — 25.8s over 9 tests

- 5.7s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › says so when a second file is picked while one is still being prepared
- 5.2s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › the Layer appears first, and reports its own preparation on its own card
- 2.9s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › shows an image that was already in the Project when it is opened
- 2.7s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › picking the same file twice in a row starts two preparations
- 2.5s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › turns a picked file into a pyramid in the Project, with progress announced

### `e2e/editor-named-workspaces.e2e.ts` — 25.0s over 21 tests

- 2.0s — editor › editor-named-workspaces.e2e.ts › switching Workspaces with work in flight › flushes the pending write to the Workspace being left, and writes nothing to the one entered
- 2.0s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › takes the Workspace’s unfinished deletions with it, not only its journal
- 2.0s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › confirms first, naming the Workspace and its size, and then removes it entirely
- 1.9s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › keeps the Workspace when the confirmation is declined
- 1.9s — editor › editor-named-workspaces.e2e.ts › the Workspace on the bar › creates a second Workspace, finds it empty, and finds the first one again

### `e2e/editor-review-remote.e2e.ts` — 24.2s over 20 tests

- 2.4s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › seals the GitHub sign-in for as long as it is open
- 1.7s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › two review copies from two repositories coexist, and my own Workspace is untouched
- 1.4s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › the reviewed Project lists on the hub, opens, and draws
- 1.3s — editor › editor-review-remote.e2e.ts › refusals, all before a byte is written › not enough room, named in bytes, with no review copy made at all
- 1.3s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › arrives unbound and unpublishable, and says why

### `e2e/editor-github-signin.e2e.ts` — 20.0s over 20 tests

- 2.0s — editor › editor-github-signin.e2e.ts › a Review Workspace, with a GitHub sign-in held › reads no sign-in, offers none, and spends nothing while it is open
- 1.7s — editor › editor-github-signin.e2e.ts › a sign-in that has run out › does not take a pasted token down with it
- 1.6s — editor › editor-github-signin.e2e.ts › signing in with GitHub › shows the account on the bar once the Workspace is bound
- 1.5s — editor › editor-github-signin.e2e.ts › with no broker served at all › the sign-in fails legibly, and the paste is offered on the same screen
- 1.1s — editor › editor-github-signin.e2e.ts › a sign-in that has run out › surfaces as “sign in again” when the refresh is refused, and is not kept

### `e2e/editor-backup.e2e.ts` — 14.0s over 6 tests

- 3.5s — editor › editor-backup.e2e.ts › backing up a folder Workspace › produces an archive that restores, rather than one that fails at restore
- 3.3s — editor › editor-backup.e2e.ts › restoring a Workspace › creates a new Workspace, switches to it, and leaves the old one untouched
- 3.3s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a backup from a newer version of the app, naming where to get it
- 1.9s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a file that is not a backup, in words, and creates no Workspace
- 1.3s — editor › editor-backup.e2e.ts › backing up a Workspace › downloads one tar named after the Workspace, holding the work and not the site

### `e2e/editor-image-pane.e2e.ts` — 9.7s over 5 tests

- 2.2s — editor › editor-image-pane.e2e.ts › is operable from the keyboard
- 2.2s — editor › editor-image-pane.e2e.ts › pans by the distance the pointer moved, in image pixels
- 2.1s — editor › editor-image-pane.e2e.ts › loads tiles at every scale factor, ragged edges included, with nothing failing
- 1.7s — editor › editor-image-pane.e2e.ts › reports the same pixel after zooming fully out and back in
- 1.4s — editor › editor-image-pane.e2e.ts › renders the fixture Historical Map and reports the pixel under the cursor

### `e2e/editor-historical-map-thumbnails.e2e.ts` — 5.5s over 4 tests

- 2.5s — editor › editor-historical-map-thumbnails.e2e.ts › a Historical Map added from a file shows a picture that has actually decoded
- 1.9s — editor › editor-historical-map-thumbnails.e2e.ts › a Workspace-held map whose coarsest tile was never written keeps the glyph
- 0.5s — editor › editor-historical-map-thumbnails.e2e.ts › a Historical Map referenced from a Library shows a picture drawn from that Library
- 0.5s — editor › editor-historical-map-thumbnails.e2e.ts › a referenced Historical Map whose record has no tile side keeps the glyph

### `e2e/editor-network-fence.e2e.ts` — 1.2s over 7 tests

- 0.4s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the service worker makes to an external origin
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the page makes to an external origin
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › leaves this suite’s own servers alone
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › lets a routed archive through, with its real bytes
- 0.0s — editor › editor-network-fence.e2e.ts › the network fence › reads a URL as local, external, or not a request at all

### `e2e/editor.e2e.ts` — 0.3s over 1 tests

- 0.3s — editor › editor.e2e.ts › the editor loads and renders its placeholder

### `e2e/viewer.e2e.ts` — 0.3s over 2 tests

- 0.3s — viewer › viewer.e2e.ts › the hub page loads
- 0.0s — viewer › viewer.e2e.ts › the built bundle carries no publishing machinery

### `e2e/editor-retry-budget-control.e2e.ts` — 0.0s over 0 tests



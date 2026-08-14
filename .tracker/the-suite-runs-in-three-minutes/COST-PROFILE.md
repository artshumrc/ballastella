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
| Tests | 633 |
| Skipped (not counted above) | 1 |
| Workers | 4 |
| Wall clock | 643.3s |
| Worker-seconds | 2551.3s |

| Spec | Tests | Worker-seconds | Per test |
| --- | ---: | ---: | ---: |
| `e2e/editor-annotations.e2e.ts` | 39 | 313.3 | 8.03 |
| `e2e/editor-layers.e2e.ts` | 36 | 254.9 | 7.08 |
| `e2e/viewer-reader.e2e.ts` | 63 | 254.7 | 4.04 |
| `e2e/editor-undo.e2e.ts` | 14 | 158.3 | 11.31 |
| `e2e/editor-alignment-refinement.e2e.ts` | 19 | 154.0 | 8.11 |
| `e2e/editor-remote-iiif.e2e.ts` | 18 | 134.9 | 7.50 |
| `e2e/editor-base-map.e2e.ts` | 36 | 128.0 | 3.56 |
| `e2e/editor-add-historical-map.e2e.ts` | 18 | 118.7 | 6.59 |
| `e2e/editor-project-screen.e2e.ts` | 20 | 104.6 | 5.23 |
| `e2e/editor-alignment.e2e.ts` | 18 | 95.7 | 5.32 |
| `e2e/editor-align-referenced.e2e.ts` | 17 | 80.6 | 4.74 |
| `e2e/editor-publish.e2e.ts` | 27 | 74.9 | 2.77 |
| `e2e/editor-folder-workspace.e2e.ts` | 23 | 70.3 | 3.06 |
| `e2e/editor-github-signin.e2e.ts` | 20 | 66.5 | 3.33 |
| `e2e/editor-offline-copy.e2e.ts` | 17 | 61.3 | 3.60 |
| `e2e/editor-workspace.e2e.ts` | 41 | 57.4 | 1.40 |
| `e2e/editor-align-route.e2e.ts` | 15 | 53.8 | 3.59 |
| `e2e/editor-transfer.e2e.ts` | 30 | 53.6 | 1.79 |
| `e2e/editor-remote-binding.e2e.ts` | 20 | 52.7 | 2.64 |
| `e2e/editor-pwa.e2e.ts` | 23 | 35.9 | 1.56 |
| `e2e/editor-backup.e2e.ts` | 6 | 35.5 | 5.92 |
| `e2e/editor-image-ingest.e2e.ts` | 9 | 29.5 | 3.27 |
| `e2e/editor-opening-view.e2e.ts` | 12 | 24.5 | 2.04 |
| `e2e/editor-stored-image-pane.e2e.ts` | 6 | 23.7 | 3.95 |
| `e2e/editor-named-workspaces.e2e.ts` | 21 | 23.1 | 1.10 |
| `e2e/editor-review-remote.e2e.ts` | 20 | 22.0 | 1.10 |
| `e2e/editor-warped-fetch.e2e.ts` | 3 | 20.9 | 6.97 |
| `e2e/editor-clone-remote.e2e.ts` | 18 | 19.6 | 1.09 |
| `e2e/editor-image-pane.e2e.ts` | 5 | 9.5 | 1.90 |
| `e2e/editor-remote-conflict.e2e.ts` | 5 | 9.3 | 1.86 |
| `e2e/editor-historical-map-thumbnails.e2e.ts` | 4 | 7.9 | 1.98 |
| `e2e/editor-network-fence.e2e.ts` | 7 | 1.2 | 0.17 |
| `e2e/viewer.e2e.ts` | 2 | 0.3 | 0.16 |
| `e2e/editor.e2e.ts` | 1 | 0.3 | 0.29 |
| `e2e/editor-retry-budget-control.e2e.ts` | 0 | 0.0 | 0.00 |
| **total** | **633** | **2551.3** | **4.03** |

## The 5 costliest tests in each spec

### `e2e/editor-annotations.e2e.ts` — 313.3s over 39 tests

- 22.3s — editor › editor-annotations.e2e.ts › placing a Pin at a Place › leaves the Pin draggable and arrow-key movable under a Historical Map
- 17.2s — editor › editor-annotations.e2e.ts › drawing (SPEC stories 57, 58, 59) › all three appear on the map, each painted by the layer for its geometry
- 16.2s — editor › editor-annotations.e2e.ts › drawing (SPEC stories 57, 58, 59) › a newly drawn Annotation is selected, and its row toggles the selection
- 16.2s — editor › editor-annotations.e2e.ts › drawing (SPEC stories 57, 58, 59) › “New Annotation” closes the Annotation that was open
- 14.5s — editor › editor-annotations.e2e.ts › drawing (SPEC stories 57, 58, 59) › the selected row wears the Layer’s own wash, and no rule of its own

### `e2e/editor-layers.e2e.ts` — 254.9s over 36 tests

- 18.4s — editor › editor-layers.e2e.ts › display state never reaches a portability document (ADR-0002) › reorder, rename, toggle, and opacity leave alignments and annotations byte-identical
- 18.4s — editor › editor-layers.e2e.ts › display state never reaches a portability document (ADR-0002) › a rename and an opacity change re-read no Layer document at all
- 16.0s — editor › editor-layers.e2e.ts › ordering, including across kinds (ADR-0002) › survives a reload
- 15.9s — editor › editor-layers.e2e.ts › a Base Map that never finishes loading › says why the Layer cannot be drawn rather than leaving the list silent
- 14.6s — editor › editor-layers.e2e.ts › display state never reaches a portability document (ADR-0002) › renaming a Layer changes only project.json

### `e2e/viewer-reader.e2e.ts` — 254.7s over 63 tests

- 23.1s — viewer › viewer-reader.e2e.ts › the Base Map a Reader sees › two Published Sites on different paths of one origin do not share a preference
- 19.5s — viewer › viewer-reader.e2e.ts › the Base Map a Reader sees › toggling the theme changes the Base Map flavor in the same action (ADR-0016)
- 19.4s — viewer › viewer-reader.e2e.ts › a Historical Map read unwarped › opens over HTTP by link, and the navigation throws nothing
- 15.2s — viewer › viewer-reader.e2e.ts › a Historical Map read unwarped › opens over HTTP by loading the URL, and the navigation throws nothing
- 12.6s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › tells a Reader when a Historical Map’s tiles stop arriving, and keeps what arrived

### `e2e/editor-undo.e2e.ts` — 158.3s over 14 tests

- 22.0s — editor › editor-undo.e2e.ts › a deleted map Layer does not come back (the resurrection trap) › is put back by undo, and one Alignment write later there is still exactly one
- 16.6s — editor › editor-undo.e2e.ts › what the one undo slot will and will not hold (ADR-0014) › the record is cleared when the Project is closed
- 15.6s — editor › editor-undo.e2e.ts › a deleted Layer (SPEC stories 38 and 49) › restores an Annotation Layer’s FeatureCollection byte-for-byte, with what was in it
- 14.7s — editor › editor-undo.e2e.ts › a deleted Layer (SPEC stories 38 and 49) › restores the project.json entry and the Alignment byte-for-byte
- 14.3s — editor › editor-undo.e2e.ts › what the one undo slot will and will not hold (ADR-0014) › a visibility toggle and a rename leave the delete still undoable

### `e2e/editor-alignment-refinement.e2e.ts` — 154.0s over 19 tests

- 20.0s — editor › editor-alignment-refinement.e2e.ts › the transformation picker (ADR-0013) › never writes straight, linear, or the bare polynomial alias, under any interaction
- 19.0s — editor › editor-alignment-refinement.e2e.ts › the transformation picker (ADR-0013) › a chosen type survives a reload, order and all, and reaches the renderer
- 16.7s — editor › editor-alignment-refinement.e2e.ts › the transformation picker (ADR-0013) › changing the type preserves every Control Point
- 15.1s — editor › editor-alignment-refinement.e2e.ts › distortion (ADR-0013) › is off by default, and colours the map by log2sigma from theme-derived colours
- 11.9s — editor › editor-alignment-refinement.e2e.ts › distortion (ADR-0013) › goes on colourising after every kind of Alignment edit, without rebuilding the map

### `e2e/editor-remote-iiif.e2e.ts` — 134.9s over 18 tests

- 20.4s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › adding a map another Project has aligned keeps that Alignment, and says so
- 17.2s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › imports the community Alignment over a starter nobody has touched
- 13.8s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › re-adding a map after deleting its Layer keeps the Alignment already on it
- 13.4s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › re-adding a map repairs a Project whose Alignment went missing
- 10.7s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › offers the community alignments it found, and importing one produces a working Alignment

### `e2e/editor-base-map.e2e.ts` — 128.0s over 36 tests

- 9.7s — editor › editor-base-map.e2e.ts › the Base Map pane › pans by dragging and zooms by wheel
- 9.1s — editor › editor-base-map.e2e.ts › the Base Map pane › renders, and pans and zooms from the keyboard
- 8.3s — editor › editor-base-map.e2e.ts › a Base Map archive that does not answer › is taken down when the archive starts answering again
- 6.6s — editor › editor-base-map.e2e.ts › making a Project available offline › draws the Base Map across the extent with the archive unreachable, at the lowest zoom and the highest
- 6.6s — editor › editor-base-map.e2e.ts › the Base Map pane › opens on the catalog’s initial view, which is what a Project with no work falls back to

### `e2e/editor-add-historical-map.e2e.ts` — 118.7s over 18 tests

- 18.2s — editor › editor-add-historical-map.e2e.ts › adding a Historical Map › adds an aligned Workspace map to another Project, drawing it and copying nothing
- 16.9s — editor › editor-add-historical-map.e2e.ts › the dialog itself (ADR-0016, SPEC stories 111, 112) › is never handed to a caller while the panel inside it is still working
- 16.2s — editor › editor-add-historical-map.e2e.ts › adding a Historical Map › offers a pyramid whose Alignment never landed, and adding it writes one
- 10.2s — editor › editor-add-historical-map.e2e.ts › the dialog itself (ADR-0016, SPEC stories 111, 112) › every control in it is reachable by keyboard
- 9.7s — editor › editor-add-historical-map.e2e.ts › adding a Historical Map › lists the Workspace’s other maps with their sizes, and leaves out the ones this Project has

### `e2e/editor-project-screen.e2e.ts` — 104.6s over 20 tests

- 14.0s — editor › editor-project-screen.e2e.ts › the navigation bar › is on the hub, the Project and the alignment route, carrying exactly its things
- 10.9s — editor › editor-project-screen.e2e.ts › what the app says when something is wrong (SPEC stories 111, 112) › the save indicator is the only role="status" in the app, on every screen
- 9.2s — editor › editor-project-screen.e2e.ts › the Layer stack and the Base Map are not pages of their own › nothing in the app links to /layers/, /base-map/ or /image-pane/
- 8.1s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › focusing the name field and tabbing away writes nothing
- 6.7s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › typing a name coalesces into one write, committed when the edit ends

### `e2e/editor-alignment.e2e.ts` — 95.7s over 18 tests

- 9.2s — editor › editor-alignment.e2e.ts › the Alignment on disk › restores every pair, its ordinal, and the warped render across a reload
- 7.9s — editor › editor-alignment.e2e.ts › the warped Historical Map › appears over the Base Map on the third pair, and not before
- 5.9s — editor › editor-alignment.e2e.ts › the Alignment on disk › excludes an incomplete pair while one is pending, and does not throw
- 5.9s — editor › editor-alignment.e2e.ts › Control Point pairing › Escape after the first click of the very first pair writes nothing at all
- 5.5s — editor › editor-alignment.e2e.ts › the Alignment on disk › is a valid Georeference Annotation naming the image and the transformation

### `e2e/editor-align-referenced.e2e.ts` — 80.6s over 17 tests

- 9.2s — editor › editor-align-referenced.e2e.ts › warns only on the Historical Map the warning is about
- 7.8s — editor › editor-align-referenced.e2e.ts › names a different set of Projects for a different map on the same screen
- 6.9s — editor › editor-align-referenced.e2e.ts › an offline copy of a map aligned in place keeps every Control Point
- 6.2s — editor › editor-align-referenced.e2e.ts › says when somebody else changed this Alignment, and puts their version back
- 5.7s — editor › editor-align-referenced.e2e.ts › keeps this session’s version when that is what the user chooses

### `e2e/editor-publish.e2e.ts` — 74.9s over 27 tests

- 6.7s — editor › editor-publish.e2e.ts › publishing a Workspace › serves a working site from a domain root and from a subdirectory, from one build
- 6.2s — editor › editor-publish.e2e.ts › publishing a Workspace › announces progress from inside the modal, where the document is not inert
- 5.9s — editor › editor-publish.e2e.ts › publishing a Workspace › stamps every info.json id with the canonical address, and the editor still opens it
- 4.7s — editor › editor-publish.e2e.ts › publishing to a Remote › announces files done, files total and the requests left, and keeps focus
- 4.6s — editor › editor-publish.e2e.ts › publishing a Workspace › states the Base Map’s size before adding it, and adds those files only when asked

### `e2e/editor-folder-workspace.e2e.ts` — 70.3s over 23 tests

- 5.3s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › leaves the browser Workspace’s Projects untouched, in both directions
- 5.2s — editor › editor-folder-workspace.e2e.ts › a bundle opened from a folder Workspace (ticket 14) › leaves the review copy even when it holds the name the exit goes back to
- 4.0s — editor › editor-folder-workspace.e2e.ts › an interrupted write to a real folder (ADR-0017 rule 4) › leaves the previous project.json intact, parseable, and with no litter beside it
- 3.8s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › writes a Project the browser backend reads with no conversion, once copied in
- 3.7s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › keeps the folder when "Use browser storage instead" is the escape from an unreachable one

### `e2e/editor-github-signin.e2e.ts` — 66.5s over 20 tests

- 6.5s — editor › editor-github-signin.e2e.ts › signing in with GitHub › shows the account on the bar once the Workspace is bound
- 5.2s — editor › editor-github-signin.e2e.ts › signing in with GitHub › keeps the sign-in in session storage and nothing in localStorage
- 5.0s — editor › editor-github-signin.e2e.ts › a page reached by a filename › sends the address it left from, not the one it came back to
- 3.6s — editor › editor-github-signin.e2e.ts › a sign-in that has run out › does not take a pasted token down with it
- 3.6s — editor › editor-github-signin.e2e.ts › a sign-in that has run out › is renewed through the broker without the scholar noticing

### `e2e/editor-offline-copy.e2e.ts` — 61.3s over 17 tests

- 10.1s — editor › editor-offline-copy.e2e.ts › making an offline copy › reports progress, and announces it to assistive technology
- 7.9s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › a copied map is one pyramid that two Projects both draw
- 6.5s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › renders warped through the injection shim with no request to the library at all
- 3.7s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › survives a reload with the network switched off, drawing from the Project
- 3.3s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › shows the hub’s picture of it from the Workspace instead of from the library

### `e2e/editor-workspace.e2e.ts` — 57.4s over 41 tests

- 3.0s — editor › editor-workspace.e2e.ts › the save indicator (ADR-0017 rule 5) › transitions saved → unsaved → saving → saved as the Project name is typed
- 2.7s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › does not put an edit back into a Project the user deleted
- 2.6s — editor › editor-workspace.e2e.ts › opening a Project and closing it (ADR-0010) › tabbing and clicking through the name field writes nothing
- 2.5s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › does not put an edit into a different named Workspace (ticket 12)
- 2.3s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › puts the edit back when the Workspace it was typed into is opened again

### `e2e/editor-align-route.e2e.ts` — 53.8s over 15 tests

- 11.3s — editor › editor-align-route.e2e.ts › the alignment route › opening it writes no Alignment and adds no Layer
- 6.2s — editor › editor-align-route.e2e.ts › “Check this alignment” › does not reopen after a reload, and is not in project.json
- 5.2s — editor › editor-align-route.e2e.ts › the route from the keyboard › reaches every control by Tab, including the way back
- 4.5s — editor › editor-align-route.e2e.ts › “Check this alignment” › keeps the overlay, the measure and the grid out of the accessibility tree until opened
- 4.1s — editor › editor-align-route.e2e.ts › the alignment route › opens from the Project at ?p= and ?layer=, and pairs by click-then-click

### `e2e/editor-transfer.e2e.ts` — 53.6s over 30 tests

- 4.4s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › is explored as though it were the reader’s own: panned, toggled, and read
- 4.0s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › is absent from the user’s own Project list, backup, and size
- 3.7s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › two review copies show their own Alignment of the same sheet
- 3.2s — editor › editor-transfer.e2e.ts › the review banner is on every screen (workspace-and-layers SPEC story 92) › both exits work from the keyboard alone (workspace-and-layers SPEC story 95)
- 2.6s — editor › editor-transfer.e2e.ts › the review banner is on every screen (workspace-and-layers SPEC story 92) › the discard confirmation is a real modal, dismissible with Escape

### `e2e/editor-remote-binding.e2e.ts` — 52.7s over 20 tests

- 22.3s — editor › editor-remote-binding.e2e.ts › a first visit › shows no sign-in affordance anywhere
- 3.6s — editor › editor-remote-binding.e2e.ts › a Review Workspace › arrives unbound, and reads no credential while it is open (stories 40, 42)
- 3.4s — editor › editor-remote-binding.e2e.ts › the pasted credential › survives a reload and is forgotten on signing out (stories 35, 37)
- 3.1s — editor › editor-remote-binding.e2e.ts › the pasted credential › can be supplied again for a Workspace that is already bound (story 30)
- 3.1s — editor › editor-remote-binding.e2e.ts › a restored Backup › arrives unbound

### `e2e/editor-pwa.e2e.ts` — 35.9s over 23 tests

- 5.5s — editor › editor-pwa.e2e.ts › a working session that reaches other people’s servers › reads a referenced Historical Map and a Base Map that needs the network, and caches neither
- 5.4s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › a referenced Historical Map says so, names its host, and breaks nothing else
- 4.8s — editor › editor-pwa.e2e.ts › the app with the network off › a Project with a local Historical Map is fully usable with the network off
- 4.5s — editor › editor-pwa.e2e.ts › an update, and who decides when › the prompt appears, nothing reloads, and the alignment in progress is untouched
- 3.1s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › the service worker does not serve the ProjectStore

### `e2e/editor-backup.e2e.ts` — 35.5s over 6 tests

- 8.0s — editor › editor-backup.e2e.ts › restoring a Workspace › creates a new Workspace, switches to it, and leaves the old one untouched
- 7.8s — editor › editor-backup.e2e.ts › backing up a folder Workspace › produces an archive that restores, rather than one that fails at restore
- 7.4s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a backup from a newer version of the app, naming where to get it
- 5.4s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a file that is not a backup, in words, and creates no Workspace
- 4.1s — editor › editor-backup.e2e.ts › backing up a Workspace › is reachable and operable from the keyboard alone

### `e2e/editor-image-ingest.e2e.ts` — 29.5s over 9 tests

- 6.4s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › says so when a second file is picked while one is still being prepared
- 6.1s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › the Layer appears first, and reports its own preparation on its own card
- 3.3s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › turns a picked file into a pyramid in the Project, with progress announced
- 3.0s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › picking the same file twice in a row starts two preparations
- 2.9s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › shows an image that was already in the Project when it is opened

### `e2e/editor-opening-view.e2e.ts` — 24.5s over 12 tests

- 6.0s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › a toggled Layer, a renamed Layer, and a new Annotation all leave the viewport alone
- 5.2s — editor › editor-opening-view.e2e.ts › the alignment view › lands on the Control Points, and a moved Control Point leaves the map alone
- 2.8s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › “Fit to this Project” re-frames on demand, and says so
- 1.5s — editor › editor-opening-view.e2e.ts › a Project opens on its own content › opens on the deployment default when there are no Layers at all
- 1.4s — editor › editor-opening-view.e2e.ts › a Project opens on its own content › opens on the deployment default when its only Historical Map is unaligned

### `e2e/editor-stored-image-pane.e2e.ts` — 23.7s over 6 tests

- 8.0s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › renders the correct pyramid for each of two Historical Maps in one Project
- 4.2s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › deep-zooms the user’s own pyramid with nothing fetched from the network
- 4.0s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › hands the ragged-edge drawing a fractional placement, on a real pyramid
- 3.9s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › surfaces a pyramid it refuses to draw, instead of a blank map
- 3.4s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › is operable from the keyboard, and reports the pixel under the pointer

### `e2e/editor-named-workspaces.e2e.ts` — 23.1s over 21 tests

- 2.0s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › confirms first, naming the Workspace and its size, and then removes it entirely
- 2.0s — editor › editor-named-workspaces.e2e.ts › the Workspace on the bar › creates a second Workspace, finds it empty, and finds the first one again
- 2.0s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › takes the Workspace’s unfinished deletions with it, not only its journal
- 1.9s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › keeps the Workspace when the confirmation is declined
- 1.8s — editor › editor-named-workspaces.e2e.ts › the Workspace on the bar › keeps the two Workspaces’ Projects in distinct OPFS directories

### `e2e/editor-review-remote.e2e.ts` — 22.0s over 20 tests

- 2.3s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › seals the GitHub sign-in for as long as it is open
- 1.6s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › two review copies from two repositories coexist, and my own Workspace is untouched
- 1.5s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › makes a review copy holding that one Project, and switches to it
- 1.4s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › the reviewed Project lists on the hub, opens, and draws
- 1.3s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › arrives unbound and unpublishable, and says why

### `e2e/editor-warped-fetch.e2e.ts` — 20.9s over 3 tests

- 9.3s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › reaches the pyramid’s info.json AND its tiles through the shim
- 5.9s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › accepts the Alignment and reports bounds once there are three pairs, with nothing fetched from the network
- 5.7s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › adds no warped layer below the minimum Control Point count, and asks the network for nothing

### `e2e/editor-clone-remote.e2e.ts` — 19.6s over 18 tests

- 2.0s — editor › editor-clone-remote.e2e.ts › what a Clone never does › goes on saying what it did after the dialog is closed and the Workspace changed
- 1.7s — editor › editor-clone-remote.e2e.ts › what a Clone never does › a second Clone of the same repository gets its own name, not the first one
- 1.6s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › the cloned Project lists on the hub, opens, and draws
- 1.4s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › binds the result to the repository it came from
- 1.3s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › makes a new Workspace, fills it, and switches to it

### `e2e/editor-image-pane.e2e.ts` — 9.5s over 5 tests

- 2.2s — editor › editor-image-pane.e2e.ts › pans by the distance the pointer moved, in image pixels
- 2.1s — editor › editor-image-pane.e2e.ts › loads tiles at every scale factor, ragged edges included, with nothing failing
- 2.1s — editor › editor-image-pane.e2e.ts › is operable from the keyboard
- 1.7s — editor › editor-image-pane.e2e.ts › reports the same pixel after zooming fully out and back in
- 1.4s — editor › editor-image-pane.e2e.ts › renders the fixture Historical Map and reports the pixel under the cursor

### `e2e/editor-remote-conflict.e2e.ts` — 9.3s over 5 tests

- 3.7s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › names the file another machine wrote, and replaces it when told to
- 2.7s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › says nothing needs changing when the Remote matches, even with no record of publishing it
- 1.0s — editor › editor-remote-conflict.e2e.ts › binding to a Remote that already carries somebody else’s Projects (story 23) › goes ahead when the Remote’s Projects are all here
- 1.0s — editor › editor-remote-conflict.e2e.ts › binding to a Remote that already carries somebody else’s Projects (story 23) › is refused, names the Project, and points at Clone
- 0.9s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › is refused with “we cannot tell” when this browser has no record of the Remote

### `e2e/editor-historical-map-thumbnails.e2e.ts` — 7.9s over 4 tests

- 3.5s — editor › editor-historical-map-thumbnails.e2e.ts › a Historical Map added from a file shows a picture that has actually decoded
- 2.5s — editor › editor-historical-map-thumbnails.e2e.ts › a Workspace-held map whose coarsest tile was never written keeps the glyph
- 1.1s — editor › editor-historical-map-thumbnails.e2e.ts › a Historical Map referenced from a Library shows a picture drawn from that Library
- 0.9s — editor › editor-historical-map-thumbnails.e2e.ts › a referenced Historical Map whose record has no tile side keeps the glyph

### `e2e/editor-network-fence.e2e.ts` — 1.2s over 7 tests

- 0.4s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the service worker makes to an external origin
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the page makes to an external origin
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › leaves this suite’s own servers alone
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › lets a routed archive through, with its real bytes
- 0.0s — editor › editor-network-fence.e2e.ts › the network fence › reads a URL as local, external, or not a request at all

### `e2e/viewer.e2e.ts` — 0.3s over 2 tests

- 0.3s — viewer › viewer.e2e.ts › the hub page loads
- 0.0s — viewer › viewer.e2e.ts › the built bundle carries no publishing machinery

### `e2e/editor.e2e.ts` — 0.3s over 1 tests

- 0.3s — editor › editor.e2e.ts › the editor loads and renders its placeholder

### `e2e/editor-retry-budget-control.e2e.ts` — 0.0s over 0 tests



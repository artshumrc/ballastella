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
| Tests | 627 |
| Skipped (not counted above) | 1 |
| Workers | 4 |
| Wall clock | 603.9s |
| Worker-seconds | 2395.2s |

| Spec | Tests | Worker-seconds | Per test |
| --- | ---: | ---: | ---: |
| `e2e/editor-annotations.e2e.ts` | 37 | 265.2 | 7.17 |
| `e2e/editor-layers.e2e.ts` | 35 | 233.1 | 6.66 |
| `e2e/viewer-reader.e2e.ts` | 63 | 225.6 | 3.58 |
| `e2e/editor-align-referenced.e2e.ts` | 17 | 154.9 | 9.11 |
| `e2e/editor-base-map.e2e.ts` | 36 | 148.0 | 4.11 |
| `e2e/editor-alignment-refinement.e2e.ts` | 19 | 136.5 | 7.18 |
| `e2e/editor-undo.e2e.ts` | 14 | 114.5 | 8.18 |
| `e2e/editor-publish.e2e.ts` | 27 | 109.7 | 4.06 |
| `e2e/editor-alignment.e2e.ts` | 18 | 95.3 | 5.29 |
| `e2e/editor-add-historical-map.e2e.ts` | 18 | 77.9 | 4.33 |
| `e2e/editor-workspace.e2e.ts` | 39 | 77.1 | 1.98 |
| `e2e/editor-remote-iiif.e2e.ts` | 18 | 76.6 | 4.26 |
| `e2e/editor-folder-workspace.e2e.ts` | 23 | 67.7 | 2.94 |
| `e2e/editor-offline-copy.e2e.ts` | 17 | 64.4 | 3.79 |
| `e2e/editor-transfer.e2e.ts` | 30 | 56.3 | 1.88 |
| `e2e/editor-stored-image-pane.e2e.ts` | 6 | 55.7 | 9.28 |
| `e2e/editor-align-route.e2e.ts` | 15 | 47.8 | 3.18 |
| `e2e/editor-project-screen.e2e.ts` | 19 | 42.2 | 2.22 |
| `e2e/editor-pwa.e2e.ts` | 23 | 41.9 | 1.82 |
| `e2e/editor-image-ingest.e2e.ts` | 9 | 41.1 | 4.56 |
| `e2e/editor-review-remote.e2e.ts` | 20 | 40.8 | 2.04 |
| `e2e/editor-warped-fetch.e2e.ts` | 3 | 40.5 | 13.51 |
| `e2e/editor-named-workspaces.e2e.ts` | 21 | 31.7 | 1.51 |
| `e2e/editor-remote-binding.e2e.ts` | 20 | 30.6 | 1.53 |
| `e2e/editor-image-pane.e2e.ts` | 5 | 26.3 | 5.26 |
| `e2e/editor-opening-view.e2e.ts` | 12 | 23.8 | 1.98 |
| `e2e/editor-github-signin.e2e.ts` | 20 | 21.3 | 1.07 |
| `e2e/editor-clone-remote.e2e.ts` | 18 | 18.5 | 1.03 |
| `e2e/editor-backup.e2e.ts` | 6 | 13.1 | 2.18 |
| `e2e/editor-remote-conflict.e2e.ts` | 5 | 9.2 | 1.84 |
| `e2e/editor-historical-map-thumbnails.e2e.ts` | 4 | 5.5 | 1.38 |
| `e2e/editor-network-fence.e2e.ts` | 7 | 1.4 | 0.20 |
| `e2e/viewer.e2e.ts` | 2 | 0.7 | 0.36 |
| `e2e/editor.e2e.ts` | 1 | 0.3 | 0.31 |
| `e2e/editor-retry-budget-control.e2e.ts` | 0 | 0.0 | 0.00 |
| **total** | **627** | **2395.2** | **3.82** |

## The 5 costliest tests in each spec

### `e2e/editor-annotations.e2e.ts` — 265.2s over 37 tests

- 20.2s — editor › editor-annotations.e2e.ts › title and description (SPEC stories 62 and 67) › typing does not rebuild the Layer stack, so the map does not thrash
- 18.9s — editor › editor-annotations.e2e.ts › title and description (SPEC stories 62 and 67) › both are editable and persist across a reload
- 14.8s — editor › editor-annotations.e2e.ts › editing a vertex costs exactly one write, on gesture end (ADR-0017 rule 1) › a polygon reshaped by a vertex stays a closed ring
- 13.9s — editor › editor-annotations.e2e.ts › editing a vertex costs exactly one write, on gesture end (ADR-0017 rule 1) › a held arrow key writes once, which is the keyboard’s pointer-up
- 10.1s — editor › editor-annotations.e2e.ts › title and description (SPEC stories 62 and 67) › the description reads as rendered Markdown, not as source

### `e2e/editor-layers.e2e.ts` — 233.1s over 35 tests

- 15.9s — editor › editor-layers.e2e.ts › a Base Map that never finishes loading › says why the Layer cannot be drawn rather than leaving the list silent
- 14.8s — editor › editor-layers.e2e.ts › a Layer for a Historical Map that has just been added › stops saying it once there are enough Control Points, and not before
- 10.4s — editor › editor-layers.e2e.ts › the Layer list reaches assistive technology (SPEC story 96) › every control of every Layer is reachable with the keyboard
- 10.4s — editor › editor-layers.e2e.ts › a Layer for a Historical Map that has just been added › does not add a second Layer, or a second write, for the next Control Point
- 10.2s — editor › editor-layers.e2e.ts › one Layer opens at a time (ticket 05) › opening a Layer writes nothing, and is nowhere in project.json or localStorage

### `e2e/viewer-reader.e2e.ts` — 225.6s over 63 tests

- 20.3s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › tells a server that is failing apart from a connection that is gone
- 18.4s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › tells a Reader when a Historical Map’s tiles stop arriving, and keeps what arrived
- 16.3s — viewer › viewer-reader.e2e.ts › a Reader using a keyboard › reaches and operates every control by tabbing, and hears what changed
- 10.1s — viewer › viewer-reader.e2e.ts › a Reader using a keyboard › opens the Annotation at the centre of the map with Enter, and closes it with Escape
- 8.3s — viewer › viewer-reader.e2e.ts › a Reader on a phone › an Annotation popup is readable inside the viewport

### `e2e/editor-align-referenced.e2e.ts` — 154.9s over 17 tests

- 18.9s — editor › editor-align-referenced.e2e.ts › writes an Alignment addressed at the library, which round-trips unchanged
- 18.5s — editor › editor-align-referenced.e2e.ts › aligns a level 0 service that publishes tiles in place, drawing it warped from the library
- 15.5s — editor › editor-align-referenced.e2e.ts › aligns a level 2 service in place, drawing it warped from the library
- 12.2s — editor › editor-align-referenced.e2e.ts › an offline copy of a map aligned in place keeps every Control Point
- 10.8s — editor › editor-align-referenced.e2e.ts › refuses to open the alignment view offline, and names the host

### `e2e/editor-base-map.e2e.ts` — 148.0s over 36 tests

- 15.8s — editor › editor-base-map.e2e.ts › making a Project available offline › draws the Base Map across the extent with the archive unreachable, at the lowest zoom and the highest
- 14.5s — editor › editor-base-map.e2e.ts › a Base Map archive that does not answer › is taken down when the archive starts answering again
- 14.0s — editor › editor-base-map.e2e.ts › making a Project available offline › still answers “is this Project available offline?” with the archive unreachable
- 12.6s — editor › editor-base-map.e2e.ts › making a Project available offline › does not answer from a record left by a different archive
- 7.7s — editor › editor-base-map.e2e.ts › making a Project available offline › keeps the OpenStreetMap attribution with the cache serving and the archive unreachable

### `e2e/editor-alignment-refinement.e2e.ts` — 136.5s over 19 tests

- 13.6s — editor › editor-alignment-refinement.e2e.ts › the Resource Mask (SPEC stories 46 and 47) › an edited mask narrows the warped render and survives a reload
- 11.6s — editor › editor-alignment-refinement.e2e.ts › the Resource Mask (SPEC stories 46 and 47) › writes a Resource Mask vertex below 1e-6 in plain decimal, and reads it back
- 10.1s — editor › editor-alignment-refinement.e2e.ts › the Resource Mask (SPEC stories 46 and 47) › is operable by keyboard, and refuses to go below three corners
- 9.0s — editor › editor-alignment-refinement.e2e.ts › the transformation picker (ADR-0013) › never writes straight, linear, or the bare polynomial alias, under any interaction
- 8.9s — editor › editor-alignment-refinement.e2e.ts › the Resource Mask (SPEC stories 46 and 47) › starts as the whole image and draws the whole map

### `e2e/editor-undo.e2e.ts` — 114.5s over 14 tests

- 12.7s — editor › editor-undo.e2e.ts › a moved Control Point (SPEC story 38) › ignores a pane that finishes opening after its alignment route was destroyed
- 10.4s — editor › editor-undo.e2e.ts › a deleted Annotation (SPEC stories 38 and 66) › goes back into the Layer it was deleted from, not the one chosen when Undo is pressed
- 10.0s — editor › editor-undo.e2e.ts › a moved Control Point (SPEC story 38) › reverses the pairing now on screen, keeping a pair made after the round trip
- 9.8s — editor › editor-undo.e2e.ts › a deleted Annotation (SPEC stories 38 and 66) › comes back with every property, and painted again
- 9.6s — editor › editor-undo.e2e.ts › what the one undo slot will and will not hold (ADR-0014) › the record is cleared when the Project is closed

### `e2e/editor-publish.e2e.ts` — 109.7s over 27 tests

- 14.6s — editor › editor-publish.e2e.ts › publishing a Workspace › stamps every info.json id with the canonical address, and the editor still opens it
- 9.9s — editor › editor-publish.e2e.ts › publishing to a Remote › announces files done, files total and the requests left, and keeps focus
- 9.8s — editor › editor-publish.e2e.ts › publishing to a Remote › sends the Workspace to its Remote, .nojekyll and all
- 8.9s — editor › editor-publish.e2e.ts › publishing to a Remote › says nothing needed changing on a second publish, and sends no blob
- 6.0s — editor › editor-publish.e2e.ts › publishing a Workspace › announces progress from inside the modal, where the document is not inert

### `e2e/editor-alignment.e2e.ts` — 95.3s over 18 tests

- 9.2s — editor › editor-alignment.e2e.ts › the Alignment on disk › restores every pair, its ordinal, and the warped render across a reload
- 7.7s — editor › editor-alignment.e2e.ts › the warped Historical Map › appears over the Base Map on the third pair, and not before
- 6.2s — editor › editor-alignment.e2e.ts › Control Point pairing › Escape after the first click of the very first pair writes nothing at all
- 5.8s — editor › editor-alignment.e2e.ts › the Alignment on disk › excludes an incomplete pair while one is pending, and does not throw
- 5.7s — editor › editor-alignment.e2e.ts › Control Point pairing › ordinals are visible and count up as pairs are made

### `e2e/editor-add-historical-map.e2e.ts` — 77.9s over 18 tests

- 12.3s — editor › editor-add-historical-map.e2e.ts › the dialog itself (ADR-0016, SPEC stories 111, 112) › is never handed to a caller while the panel inside it is still working
- 10.8s — editor › editor-add-historical-map.e2e.ts › the picker’s pictures (ADR-0030, SPEC story 3) › a Workspace-held candidate shows a picture that has actually decoded
- 7.9s — editor › editor-add-historical-map.e2e.ts › adding a Historical Map › adds an aligned Workspace map to another Project, drawing it and copying nothing
- 4.4s — editor › editor-add-historical-map.e2e.ts › adding a Historical Map › lists the Workspace’s other maps with their sizes, and leaves out the ones this Project has
- 4.1s — editor › editor-add-historical-map.e2e.ts › the dialog itself (ADR-0016, SPEC stories 111, 112) › every control in it is reachable by keyboard

### `e2e/editor-workspace.e2e.ts` — 77.1s over 39 tests

- 4.5s — editor › editor-workspace.e2e.ts › the Project hub › refuses a Project called “Images” and names the reservation
- 4.5s — editor › editor-workspace.e2e.ts › the Project hub › renaming to a name another Project already has succeeds
- 4.1s — editor › editor-workspace.e2e.ts › the Project hub › ?p= opens the Project it names
- 3.5s — editor › editor-workspace.e2e.ts › the Project hub › duplicating a Project adds a copy and leaves the original
- 3.3s — editor › editor-workspace.e2e.ts › the save indicator (ADR-0017 rule 5) › transitions saved → unsaved → saving → saved as the Project name is typed

### `e2e/editor-remote-iiif.e2e.ts` — 76.6s over 18 tests

- 8.0s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › re-adding a map after deleting its Layer keeps the Alignment already on it
- 7.3s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › adding the same referenced map again leaves the stack byte-identical
- 7.2s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › adding a map another Project has aligned keeps that Alignment, and says so
- 6.2s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › a deleted map Layer comes back when the same map is added again
- 5.5s — editor › editor-remote-iiif.e2e.ts › a referenced Historical Map, drawn from the library that holds it › draws a referenced Layer warped, from tiles the remote host served (reached by load)

### `e2e/editor-folder-workspace.e2e.ts` — 67.7s over 23 tests

- 5.4s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › leaves the browser Workspace’s Projects untouched, in both directions
- 5.0s — editor › editor-folder-workspace.e2e.ts › a bundle opened from a folder Workspace (ticket 14) › leaves the review copy even when it holds the name the exit goes back to
- 3.9s — editor › editor-folder-workspace.e2e.ts › an interrupted write to a real folder (ADR-0017 rule 4) › leaves the previous project.json intact, parseable, and with no litter beside it
- 3.8s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › writes a Project the browser backend reads with no conversion, once copied in
- 3.7s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › keeps the folder when "Use browser storage instead" is the escape from an unreachable one

### `e2e/editor-offline-copy.e2e.ts` — 64.4s over 17 tests

- 10.2s — editor › editor-offline-copy.e2e.ts › making an offline copy › reports progress, and announces it to assistive technology
- 8.0s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › a copied map is one pyramid that two Projects both draw
- 6.6s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › renders warped through the injection shim with no request to the library at all
- 3.9s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › survives a reload with the network switched off, drawing from the Project
- 3.3s — editor › editor-offline-copy.e2e.ts › a copied Historical Map, once it is copied › shows the hub’s picture of it from the Workspace instead of from the library

### `e2e/editor-transfer.e2e.ts` — 56.3s over 30 tests

- 4.2s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › is explored as though it were the reader’s own: panned, toggled, and read
- 4.0s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › is absent from the user’s own Project list, backup, and size
- 3.7s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › two review copies show their own Alignment of the same sheet
- 3.2s — editor › editor-transfer.e2e.ts › the review banner is on every screen (workspace-and-layers SPEC story 92) › both exits work from the keyboard alone (workspace-and-layers SPEC story 95)
- 2.7s — editor › editor-transfer.e2e.ts › the review banner is on every screen (workspace-and-layers SPEC story 92) › the discard confirmation is a real modal, dismissible with Escape

### `e2e/editor-stored-image-pane.e2e.ts` — 55.7s over 6 tests

- 16.3s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › renders the correct pyramid for each of two Historical Maps in one Project
- 12.7s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › deep-zooms the user’s own pyramid with nothing fetched from the network
- 10.6s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › hands the ragged-edge drawing a fractional placement, on a real pyramid
- 10.3s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › is operable from the keyboard, and reports the pixel under the pointer
- 5.3s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › surfaces a pyramid it refuses to draw, instead of a blank map

### `e2e/editor-align-route.e2e.ts` — 47.8s over 15 tests

- 10.1s — editor › editor-align-route.e2e.ts › the alignment route › opening it writes no Alignment and adds no Layer
- 5.3s — editor › editor-align-route.e2e.ts › “Check this alignment” › does not reopen after a reload, and is not in project.json
- 4.3s — editor › editor-align-route.e2e.ts › “Check this alignment” › keeps the overlay, the measure and the grid out of the accessibility tree until opened
- 4.2s — editor › editor-align-route.e2e.ts › the alignment route › opens from the Project at ?p= and ?layer=, and pairs by click-then-click
- 3.9s — editor › editor-align-route.e2e.ts › the route from the keyboard › reaches every control by Tab, including the way back

### `e2e/editor-project-screen.e2e.ts` — 42.2s over 19 tests

- 4.1s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › typing a name coalesces into one write, committed when the edit ends
- 3.6s — editor › editor-project-screen.e2e.ts › what the app says when something is wrong (SPEC stories 111, 112) › the save indicator is the only role="status" in the app, on every screen
- 3.2s — editor › editor-project-screen.e2e.ts › the navigation bar › is on the hub, the Project and the alignment route, carrying exactly its things
- 3.1s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › focusing the name field and tabbing away writes nothing
- 3.1s — editor › editor-project-screen.e2e.ts › the Layer stack and the Base Map are not pages of their own › nothing in the app links to /layers/, /base-map/ or /image-pane/

### `e2e/editor-pwa.e2e.ts` — 41.9s over 23 tests

- 6.8s — editor › editor-pwa.e2e.ts › a working session that reaches other people’s servers › reads a referenced Historical Map and a Base Map that needs the network, and caches neither
- 5.7s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › a referenced Historical Map says so, names its host, and breaks nothing else
- 5.4s — editor › editor-pwa.e2e.ts › the app with the network off › a Project with a local Historical Map is fully usable with the network off
- 4.9s — editor › editor-pwa.e2e.ts › an update, and who decides when › the prompt appears, nothing reloads, and the alignment in progress is untouched
- 3.4s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › the service worker does not serve the ProjectStore

### `e2e/editor-image-ingest.e2e.ts` — 41.1s over 9 tests

- 9.7s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › shows an image that was already in the Project when it is opened
- 8.6s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › the Layer appears first, and reports its own preparation on its own card
- 7.6s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › says so when a second file is picked while one is still being prepared
- 3.4s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › picking the same file twice in a row starts two preparations
- 3.1s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › turns a picked file into a pyramid in the Project, with progress announced

### `e2e/editor-review-remote.e2e.ts` — 40.8s over 20 tests

- 3.9s — editor › editor-review-remote.e2e.ts › refusals, all before a byte is written › a repository nobody can read anonymously
- 3.8s — editor › editor-review-remote.e2e.ts › refusals, all before a byte is written › a Project folder the Remote does not hold, naming the ones it does
- 3.7s — editor › editor-review-remote.e2e.ts › refusals, all before a byte is written › something that is not a repository address at all
- 3.4s — editor › editor-review-remote.e2e.ts › refusals, all before a byte is written › not enough room, named in bytes, with no review copy made at all
- 2.8s — editor › editor-review-remote.e2e.ts › refusals, all before a byte is written › a truncated file list, with no review copy made at all

### `e2e/editor-warped-fetch.e2e.ts` — 40.5s over 3 tests

- 17.4s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › reaches the pyramid’s info.json AND its tiles through the shim
- 14.0s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › accepts the Alignment and reports bounds once there are three pairs, with nothing fetched from the network
- 9.1s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › adds no warped layer below the minimum Control Point count, and asks the network for nothing

### `e2e/editor-named-workspaces.e2e.ts` — 31.7s over 21 tests

- 2.9s — editor › editor-named-workspaces.e2e.ts › the Workspace on the bar › creates a second Workspace, finds it empty, and finds the first one again
- 2.6s — editor › editor-named-workspaces.e2e.ts › the Workspace on the bar › names the Workspace on the hub and on the Project screen
- 2.5s — editor › editor-named-workspaces.e2e.ts › the Workspace on the bar › keeps the two Workspaces’ Projects in distinct OPFS directories
- 2.2s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › confirms first, naming the Workspace and its size, and then removes it entirely
- 2.1s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › takes the Workspace’s unfinished deletions with it, not only its journal

### `e2e/editor-remote-binding.e2e.ts` — 30.6s over 20 tests

- 3.6s — editor › editor-remote-binding.e2e.ts › a Review Workspace › arrives unbound, and reads no credential while it is open (stories 40, 42)
- 3.3s — editor › editor-remote-binding.e2e.ts › the pasted credential › survives a reload and is forgotten on signing out (stories 35, 37)
- 3.1s — editor › editor-remote-binding.e2e.ts › the pasted credential › can be supplied again for a Workspace that is already bound (story 30)
- 3.1s — editor › editor-remote-binding.e2e.ts › a restored Backup › arrives unbound
- 1.9s — editor › editor-remote-binding.e2e.ts › binding a Workspace to a repository › is done from the Workspace menu, and survives a reload (stories 4, 30)

### `e2e/editor-image-pane.e2e.ts` — 26.3s over 5 tests

- 7.1s — editor › editor-image-pane.e2e.ts › pans by the distance the pointer moved, in image pixels
- 5.6s — editor › editor-image-pane.e2e.ts › loads tiles at every scale factor, ragged edges included, with nothing failing
- 4.8s — editor › editor-image-pane.e2e.ts › is operable from the keyboard
- 4.4s — editor › editor-image-pane.e2e.ts › reports the same pixel after zooming fully out and back in
- 4.3s — editor › editor-image-pane.e2e.ts › renders the fixture Historical Map and reports the pixel under the cursor

### `e2e/editor-opening-view.e2e.ts` — 23.8s over 12 tests

- 5.3s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › a toggled Layer, a renamed Layer, and a new Annotation all leave the viewport alone
- 5.1s — editor › editor-opening-view.e2e.ts › the alignment view › lands on the Control Points, and a moved Control Point leaves the map alone
- 2.7s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › “Fit to this Project” re-frames on demand, and says so
- 1.6s — editor › editor-opening-view.e2e.ts › a Project opens on its own content › opens on the deployment default when its only Historical Map is unaligned
- 1.6s — editor › editor-opening-view.e2e.ts › a Project opens on its own content › opens on the deployment default when there are no Layers at all

### `e2e/editor-github-signin.e2e.ts` — 21.3s over 20 tests

- 2.3s — editor › editor-github-signin.e2e.ts › a Review Workspace, with a GitHub sign-in held › reads no sign-in, offers none, and spends nothing while it is open
- 1.8s — editor › editor-github-signin.e2e.ts › a sign-in that has run out › does not take a pasted token down with it
- 1.6s — editor › editor-github-signin.e2e.ts › signing in with GitHub › shows the account on the bar once the Workspace is bound
- 1.6s — editor › editor-github-signin.e2e.ts › with no broker served at all › the sign-in fails legibly, and the paste is offered on the same screen
- 1.3s — editor › editor-github-signin.e2e.ts › a sign-in that has run out › is caught before any work starts, rather than by a 401 partway through

### `e2e/editor-clone-remote.e2e.ts` — 18.5s over 18 tests

- 1.8s — editor › editor-clone-remote.e2e.ts › what a Clone never does › goes on saying what it did after the dialog is closed and the Workspace changed
- 1.6s — editor › editor-clone-remote.e2e.ts › what a Clone never does › a second Clone of the same repository gets its own name, not the first one
- 1.5s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › binds the result to the repository it came from
- 1.4s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › the cloned Project lists on the hub, opens, and draws
- 1.3s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › makes a new Workspace, fills it, and switches to it

### `e2e/editor-backup.e2e.ts` — 13.1s over 6 tests

- 3.4s — editor › editor-backup.e2e.ts › backing up a folder Workspace › produces an archive that restores, rather than one that fails at restore
- 3.1s — editor › editor-backup.e2e.ts › restoring a Workspace › creates a new Workspace, switches to it, and leaves the old one untouched
- 3.0s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a backup from a newer version of the app, naming where to get it
- 1.8s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a file that is not a backup, in words, and creates no Workspace
- 1.1s — editor › editor-backup.e2e.ts › backing up a Workspace › downloads one tar named after the Workspace, holding the work and not the site

### `e2e/editor-remote-conflict.e2e.ts` — 9.2s over 5 tests

- 3.7s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › names the file another machine wrote, and replaces it when told to
- 2.7s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › says nothing needs changing when the Remote matches, even with no record of publishing it
- 0.9s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › is refused with “we cannot tell” when this browser has no record of the Remote
- 0.9s — editor › editor-remote-conflict.e2e.ts › binding to a Remote that already carries somebody else’s Projects (story 23) › is refused, names the Project, and points at Clone
- 0.9s — editor › editor-remote-conflict.e2e.ts › binding to a Remote that already carries somebody else’s Projects (story 23) › goes ahead when the Remote’s Projects are all here

### `e2e/editor-historical-map-thumbnails.e2e.ts` — 5.5s over 4 tests

- 2.6s — editor › editor-historical-map-thumbnails.e2e.ts › a Historical Map added from a file shows a picture that has actually decoded
- 2.0s — editor › editor-historical-map-thumbnails.e2e.ts › a Workspace-held map whose coarsest tile was never written keeps the glyph
- 0.5s — editor › editor-historical-map-thumbnails.e2e.ts › a Historical Map referenced from a Library shows a picture drawn from that Library
- 0.4s — editor › editor-historical-map-thumbnails.e2e.ts › a referenced Historical Map whose record has no tile side keeps the glyph

### `e2e/editor-network-fence.e2e.ts` — 1.4s over 7 tests

- 0.4s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the service worker makes to an external origin
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the page makes to an external origin
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › lets a routed archive through, with its real bytes
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › leaves this suite’s own servers alone
- 0.0s — editor › editor-network-fence.e2e.ts › the network fence › reads a URL as local, external, or not a request at all

### `e2e/viewer.e2e.ts` — 0.7s over 2 tests

- 0.7s — viewer › viewer.e2e.ts › the hub page loads
- 0.0s — viewer › viewer.e2e.ts › the built bundle carries no publishing machinery

### `e2e/editor.e2e.ts` — 0.3s over 1 tests

- 0.3s — editor › editor.e2e.ts › the editor loads and renders its placeholder

### `e2e/editor-retry-budget-control.e2e.ts` — 0.0s over 0 tests



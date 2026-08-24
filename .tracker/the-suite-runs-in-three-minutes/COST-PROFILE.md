# Seam 2 cost profile

⚠ **Generated. Do not edit by hand** — regenerate with `pnpm test:e2e --profile`
(`scripts/cost-profile.mjs`), which appends a reporter rather than replacing the list, so a
profiled run keeps the retry budget and gives the gate’s verdict.

**Worker-seconds, not wall time.** A test’s cost is the time a worker spent inside it, summed
over every attempt. That is what moving the claim to another seam actually removes; wall time
depends on how the scheduler packed the run.

| Run | 2026-08-24 |
| --- | --- |
| Command | `pnpm test:e2e --profile` |
| Tests | 664 |
| Skipped (not counted above) | 1 |
| Workers | 8 |
| Wall clock | 234.4s |
| Worker-seconds | 1819.8s |

| Spec | Tests | Worker-seconds | Per test |
| --- | ---: | ---: | ---: |
| `e2e/editor-annotations.e2e.ts` | 43 | 179.9 | 4.18 |
| `e2e/viewer-reader.e2e.ts` | 65 | 129.3 | 1.99 |
| `e2e/editor-layers.e2e.ts` | 36 | 126.1 | 3.50 |
| `e2e/editor-transfer.e2e.ts` | 40 | 108.5 | 2.71 |
| `e2e/editor-review-remote.e2e.ts` | 21 | 101.6 | 4.84 |
| `e2e/editor-undo.e2e.ts` | 16 | 93.9 | 5.87 |
| `e2e/editor-folder-workspace.e2e.ts` | 26 | 88.3 | 3.40 |
| `e2e/editor-publish.e2e.ts` | 24 | 74.1 | 3.09 |
| `e2e/editor-stored-image-pane.e2e.ts` | 6 | 70.1 | 11.68 |
| `e2e/editor-remote-iiif.e2e.ts` | 19 | 69.1 | 3.64 |
| `e2e/editor-base-map.e2e.ts` | 36 | 64.0 | 1.78 |
| `e2e/editor-alignment.e2e.ts` | 18 | 63.1 | 3.51 |
| `e2e/editor-remote-binding.e2e.ts` | 22 | 61.4 | 2.79 |
| `e2e/editor-add-map-image.e2e.ts` | 18 | 55.4 | 3.08 |
| `e2e/editor-offline-copy.e2e.ts` | 17 | 54.6 | 3.21 |
| `e2e/editor-align-referenced.e2e.ts` | 17 | 53.9 | 3.17 |
| `e2e/editor-workspace.e2e.ts` | 40 | 53.5 | 1.34 |
| `e2e/editor-alignment-refinement.e2e.ts` | 20 | 53.1 | 2.65 |
| `e2e/editor-clone-remote.e2e.ts` | 18 | 41.2 | 2.29 |
| `e2e/editor-github-signin.e2e.ts` | 22 | 40.6 | 1.85 |
| `e2e/editor-align-route.e2e.ts` | 16 | 37.4 | 2.34 |
| `e2e/editor-project-screen.e2e.ts` | 19 | 33.1 | 1.74 |
| `e2e/editor-pwa.e2e.ts` | 23 | 32.9 | 1.43 |
| `e2e/editor-remote-conflict.e2e.ts` | 11 | 26.6 | 2.41 |
| `e2e/editor-named-workspaces.e2e.ts` | 21 | 23.1 | 1.10 |
| `e2e/editor-image-ingest.e2e.ts` | 9 | 21.2 | 2.36 |
| `e2e/editor-opening-view.e2e.ts` | 12 | 20.3 | 1.69 |
| `e2e/editor-backup.e2e.ts` | 7 | 17.0 | 2.43 |
| `e2e/editor-warped-fetch.e2e.ts` | 3 | 11.3 | 3.77 |
| `e2e/editor-image-pane.e2e.ts` | 5 | 8.3 | 1.66 |
| `e2e/editor-map-image-thumbnails.e2e.ts` | 4 | 4.6 | 1.16 |
| `e2e/editor-network-fence.e2e.ts` | 7 | 1.4 | 0.20 |
| `e2e/viewer.e2e.ts` | 2 | 0.4 | 0.21 |
| `e2e/editor.e2e.ts` | 1 | 0.3 | 0.34 |
| `e2e/editor-retry-budget-control.e2e.ts` | 0 | 0.0 | 0.00 |
| **total** | **664** | **1819.8** | **2.74** |

## The 5 costliest tests in each spec

### `e2e/editor-annotations.e2e.ts` — 179.9s over 43 tests

- 9.1s — editor › editor-annotations.e2e.ts › drawing (SPEC stories 57, 58, 59) › all three appear on the map, each painted by the layer for its geometry
- 8.0s — editor › editor-annotations.e2e.ts › the keyboard alone (SPEC stories 95 and 96) › every drawing tool and style control is reachable and operable, and the tool is announced
- 7.8s — editor › editor-annotations.e2e.ts › a Label is placed and its words typed (write-on-the-map stories 3, 4, 9, 10, 16, 26) › typed with the keyboard alone, the words draw and the file says label; its style is inherited and the Pin after it is a Pin
- 7.0s — editor › editor-annotations.e2e.ts › title and description (SPEC stories 62 and 67) › clicking the Annotation on the map opens its row, where the description is rendered
- 6.9s — editor › editor-annotations.e2e.ts › deleting an Annotation (SPEC story 66) › removes it from the file and leaves the others

### `e2e/viewer-reader.e2e.ts` — 129.3s over 65 tests

- 10.0s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › tells a Reader when a Map Image’s tiles stop arriving, and keeps what arrived
- 6.0s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › keeps the outage notice up when the archive answers its header and then stops
- 4.7s — viewer › viewer-reader.e2e.ts › exploring a Project › draws the stack in the author’s order with zoom at the bottom-left, the Annotation Layer above the map Layer, and the Inspector docked over the pane’s top-right
- 4.5s — viewer › viewer-reader.e2e.ts › the Base Map a Reader sees › two Published Sites on different paths of one origin do not share a preference
- 3.7s — viewer › viewer-reader.e2e.ts › a Reader using a keyboard › opens the Annotation at the centre of the map with Enter, and closes it with Escape

### `e2e/editor-layers.e2e.ts` — 126.1s over 36 tests

- 19.6s — editor › editor-layers.e2e.ts › a Base Map that never finishes loading › says why the Layer cannot be drawn rather than leaving the list silent
- 8.4s — editor › editor-layers.e2e.ts › a Layer for a Map Image that has just been added › stops saying it once there are enough Control Points, and not before
- 5.5s — editor › editor-layers.e2e.ts › a Layer for a Map Image that has just been added › draws the stack when the pane is reached by the link from the Project page
- 5.4s — editor › editor-layers.e2e.ts › a Layer for a Map Image that has just been added › does not add a second Layer, or a second write, for the next Control Point
- 5.4s — editor › editor-layers.e2e.ts › a Label obeys its Annotation Layer (write-on-the-map stories 44-46) › counts with every kind, follows visibility, and is untouched by a Map Image opacity change

### `e2e/editor-transfer.e2e.ts` — 108.5s over 40 tests

- 5.8s — editor › editor-transfer.e2e.ts › exporting a Project as a bundle (workspace-and-layers SPEC story 89) › downloads a tar named for the folder, rooted at the Project, and announces it
- 5.7s — editor › editor-transfer.e2e.ts › exporting a Project as a bundle (workspace-and-layers SPEC story 89) › leaves the Workspace’s other Map Images out of it
- 5.4s — editor › editor-transfer.e2e.ts › an Import that did not finish (ticket 05) › is swept, finished, or keeps the Workspace shut — before anything can list it
- 4.6s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › opens a bundled Label in the review copy with its words and colours drawn
- 4.5s — editor › editor-transfer.e2e.ts › Importing a Project into the Workspace that is open (SPEC stories 1–14) › distinguishes Import, Review, and New Project, and backing out of the offer changes nothing

### `e2e/editor-review-remote.e2e.ts` — 101.6s over 21 tests

- 10.2s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › seals the GitHub sign-in for as long as it is open
- 8.1s — editor › editor-review-remote.e2e.ts › arriving on a link from a Published Site › can Import that Project into the Workspace the reader is already in
- 6.4s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › two review copies from two repositories coexist, and my own Workspace is untouched
- 6.3s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › offers Import into the Workspace review began from, and nothing that promotes or merges
- 6.3s — editor › editor-review-remote.e2e.ts › arriving on a link from a Published Site › confirming makes the review copy, holding that one Project

### `e2e/editor-undo.e2e.ts` — 93.9s over 16 tests

- 10.3s — editor › editor-undo.e2e.ts › a moved Control Point (SPEC story 38) › ignores a pane that finishes opening after its alignment route was destroyed
- 7.7s — editor › editor-undo.e2e.ts › a moved Control Point (SPEC story 38) › reverses the pairing now on screen, keeping a pair made after the round trip
- 7.6s — editor › editor-undo.e2e.ts › a deleted Annotation (SPEC stories 38 and 66) › goes back into the Layer it was deleted from, not the one chosen when Undo is pressed
- 6.9s — editor › editor-undo.e2e.ts › a deleted Label (write-on-the-map stories 42 and 43) › an untitled Label is deleted and restored through the same Inspector path
- 6.8s — editor › editor-undo.e2e.ts › a deleted Annotation (SPEC stories 38 and 66) › comes back with every property, and painted again

### `e2e/editor-folder-workspace.e2e.ts` — 88.3s over 26 tests

- 13.9s — editor › editor-folder-workspace.e2e.ts › synchronizing a folder Workspace › sends the same bytes and reads the same states as browser storage does
- 5.4s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › leaves the browser Workspace’s Projects untouched, in both directions
- 5.1s — editor › editor-folder-workspace.e2e.ts › a bundle opened from a folder Workspace (ticket 14) › leaves the review copy even when it holds the name the exit goes back to
- 3.7s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › keeps the folder when "Use browser storage instead" is the escape from an unreachable one
- 3.7s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › forgets the folder when browser storage is chosen deliberately

### `e2e/editor-publish.e2e.ts` — 74.1s over 24 tests

- 7.9s — editor › editor-publish.e2e.ts › publishing a Workspace › announces progress from inside the modal, where the document is not inert
- 6.7s — editor › editor-publish.e2e.ts › publishing to a Remote › announces files done, files total and the requests left, and keeps focus
- 5.1s — editor › editor-publish.e2e.ts › publishing a Workspace › extends the hub page on a second publish and leaves the first Project untouched
- 4.9s — editor › editor-publish.e2e.ts › publishing a Workspace › refreshes a version stamp that has gone stale, and says so before it is refreshed
- 4.1s — editor › editor-publish.e2e.ts › publishing a Workspace › serves a working site from a domain root and from a subdirectory, from one build

### `e2e/editor-stored-image-pane.e2e.ts` — 70.1s over 6 tests

- 16.8s — editor › editor-stored-image-pane.e2e.ts › a Map Image read from the Project › renders the correct pyramid for each of two Map Images in one Project
- 15.6s — editor › editor-stored-image-pane.e2e.ts › a Map Image read from the Project › deep-zooms the user’s own pyramid with nothing fetched from the network
- 12.9s — editor › editor-stored-image-pane.e2e.ts › a Map Image read from the Project › hands the ragged-edge drawing a fractional placement, on a real pyramid
- 11.6s — editor › editor-stored-image-pane.e2e.ts › a Map Image read from the Project › surfaces a pyramid it refuses to draw, instead of a blank map
- 10.8s — editor › editor-stored-image-pane.e2e.ts › a Map Image read from the Project › is operable from the keyboard, and reports the pixel under the pointer

### `e2e/editor-remote-iiif.e2e.ts` — 69.1s over 19 tests

- 7.5s — editor › editor-remote-iiif.e2e.ts › adding a Map Image from a IIIF URL › re-adding a map after deleting its Layer keeps the Alignment already on it
- 6.4s — editor › editor-remote-iiif.e2e.ts › adding a Map Image from a IIIF URL › adding the same referenced map again leaves the stack byte-identical
- 6.2s — editor › editor-remote-iiif.e2e.ts › adding a Map Image from a IIIF URL › adding a map another Project has aligned keeps that Alignment, and says so
- 5.9s — editor › editor-remote-iiif.e2e.ts › adding a Map Image from a IIIF URL › a deleted map Layer comes back when the same map is added again
- 5.4s — editor › editor-remote-iiif.e2e.ts › a referenced Map Image, drawn from the library that holds it › draws a referenced Layer warped, from tiles the remote host served (reached by load)

### `e2e/editor-base-map.e2e.ts` — 64.0s over 36 tests

- 5.1s — editor › editor-base-map.e2e.ts › finding a place › says all four things, each driven by the condition that causes it
- 4.3s — editor › editor-base-map.e2e.ts › making a Project available offline › draws the Base Map across the extent with the archive unreachable, at the lowest zoom and the highest
- 4.0s — editor › editor-base-map.e2e.ts › a Base Map archive that does not answer › is withdrawn when the author switches to a Base Map it has not asked yet
- 3.7s — editor › editor-base-map.e2e.ts › making a Project available offline › is not listed on the hub, while the Project remains available offline
- 3.4s — editor › editor-base-map.e2e.ts › a Base Map archive that does not answer › is taken down when the archive starts answering again

### `e2e/editor-alignment.e2e.ts` — 63.1s over 18 tests

- 6.4s — editor › editor-alignment.e2e.ts › the Alignment on disk › restores every pair, its ordinal, and the warped render across a reload
- 5.9s — editor › editor-alignment.e2e.ts › the warped Map Image › appears over the Base Map on the third pair, and not before
- 4.7s — editor › editor-alignment.e2e.ts › Control Point pairing › Escape after the first click of the very first pair writes nothing at all
- 3.6s — editor › editor-alignment.e2e.ts › Control Point pairing › deleting removes both halves, never one
- 3.5s — editor › editor-alignment.e2e.ts › the Alignment on disk › is a valid Georeference Annotation naming the image and the transformation

### `e2e/editor-remote-binding.e2e.ts` — 61.4s over 22 tests

- 6.6s — editor › editor-remote-binding.e2e.ts › a Review Workspace › arrives unbound, and reads no credential while it is open (stories 40, 42)
- 6.5s — editor › editor-remote-binding.e2e.ts › a Workspace bound by an older build › is asked about when nothing corroborates it, and copied content cannot redirect it
- 5.9s — editor › editor-remote-binding.e2e.ts › the pasted credential › survives a reload and is forgotten on signing out (stories 35, 37)
- 5.6s — editor › editor-remote-binding.e2e.ts › the pasted credential › can be supplied again for a Workspace that is already bound (story 30)
- 4.5s — editor › editor-remote-binding.e2e.ts › a restored Backup › arrives unbound

### `e2e/editor-add-map-image.e2e.ts` — 55.4s over 18 tests

- 11.9s — editor › editor-add-map-image.e2e.ts › the dialog itself (ADR-0016, SPEC stories 111, 112) › is never handed to a caller while the panel inside it is still working
- 5.3s — editor › editor-add-map-image.e2e.ts › adding a Map Image › adds an aligned Workspace map to another Project, drawing it and copying nothing
- 3.5s — editor › editor-add-map-image.e2e.ts › adding a Map Image › lists the Workspace’s other maps with their sizes, and leaves out the ones this Project has
- 3.1s — editor › editor-add-map-image.e2e.ts › adding a map this Workspace already holds › does not leave the last add’s sentence in the live region across an unrelated open
- 3.1s — editor › editor-add-map-image.e2e.ts › adding a Map Image › offers a pyramid whose Alignment never landed, and adding it writes one

### `e2e/editor-offline-copy.e2e.ts` — 54.6s over 17 tests

- 9.8s — editor › editor-offline-copy.e2e.ts › making an offline copy › reports progress, and announces it to assistive technology
- 6.5s — editor › editor-offline-copy.e2e.ts › a copied Map Image, once it is copied › a copied map is one pyramid that two Projects both draw
- 5.6s — editor › editor-offline-copy.e2e.ts › a copied Map Image, once it is copied › renders warped through the injection shim with no request to the library at all
- 2.8s — editor › editor-offline-copy.e2e.ts › a copied Map Image, once it is copied › survives a reload with the network switched off, drawing from the Project
- 2.8s — editor › editor-offline-copy.e2e.ts › making an offline copy › copies a level-0 source from its own tiles, having warned that it means many requests

### `e2e/editor-align-referenced.e2e.ts` — 53.9s over 17 tests

- 5.0s — editor › editor-align-referenced.e2e.ts › warns only on the Map Image the warning is about
- 4.0s — editor › editor-align-referenced.e2e.ts › an offline copy of a map aligned in place keeps every Control Point
- 3.9s — editor › editor-align-referenced.e2e.ts › names a different set of Projects for each Map Image on the Workspace Home
- 3.8s — editor › editor-align-referenced.e2e.ts › refuses to open the alignment view offline, and names the host
- 3.7s — editor › editor-align-referenced.e2e.ts › aligns a level 0 service that publishes tiles in place, drawing it warped from the library

### `e2e/editor-workspace.e2e.ts` — 53.5s over 40 tests

- 3.0s — editor › editor-workspace.e2e.ts › the save indicator (ADR-0017 rule 5) › transitions saved → unsaved → saving → saved as the Project name is typed
- 2.3s — editor › editor-workspace.e2e.ts › opening a Project and closing it (ADR-0010) › tabbing and clicking through the name field writes nothing
- 2.3s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › does not put an edit back into a Project the user deleted
- 2.2s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › does not leak a deleted Project’s file into a new one that reused its folder
- 2.1s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › does not put an edit into a different named Workspace (ticket 12)

### `e2e/editor-alignment-refinement.e2e.ts` — 53.1s over 20 tests

- 4.0s — editor › editor-alignment-refinement.e2e.ts › the Resource Mask (SPEC stories 46 and 47) › an edited mask narrows the warped render and survives a reload
- 4.0s — editor › editor-alignment-refinement.e2e.ts › the transformation picker (ADR-0013) › a chosen type survives a reload, order and all, and reaches the renderer
- 3.7s — editor › editor-alignment-refinement.e2e.ts › distortion (ADR-0013) › goes on colourising after every kind of Alignment edit, without rebuilding the map
- 3.5s — editor › editor-alignment-refinement.e2e.ts › the Resource Mask (SPEC stories 46 and 47) › writes a Resource Mask vertex below 1e-6 in plain decimal, and reads it back
- 3.4s — editor › editor-alignment-refinement.e2e.ts › the transformation picker (ADR-0013) › changing the type preserves every Control Point

### `e2e/editor-clone-remote.e2e.ts` — 41.2s over 18 tests

- 8.8s — editor › editor-clone-remote.e2e.ts › what Open never does › goes on saying what it did after the dialog is closed and the Workspace changed
- 5.8s — editor › editor-clone-remote.e2e.ts › what Open never does › makes a second synchronized copy of a repository it has already opened
- 5.6s — editor › editor-clone-remote.e2e.ts › opening a published Workspace › records the selected Remote and a Baseline, and no stale binding can redirect it
- 3.3s — editor › editor-clone-remote.e2e.ts › opening a published Workspace › the opened Project lists on the hub, opens, and draws
- 3.0s — editor › editor-clone-remote.e2e.ts › opening a published Workspace › makes a new Workspace, fills it, and switches to it

### `e2e/editor-github-signin.e2e.ts` — 40.6s over 22 tests

- 5.0s — editor › editor-github-signin.e2e.ts › a Review Workspace, with a GitHub sign-in held › reads no sign-in, offers none, and spends nothing while it is open
- 4.4s — editor › editor-github-signin.e2e.ts › a sign-in that has run out › does not take a pasted token down with it
- 4.0s — editor › editor-github-signin.e2e.ts › signing in with GitHub › names the account in the Workspace menu once the Workspace is bound
- 3.2s — editor › editor-github-signin.e2e.ts › with no broker served at all › a bound Workspace survives a reload with its credential, broker or no broker
- 2.4s — editor › editor-github-signin.e2e.ts › with no broker served at all › the sign-in fails legibly, and the paste is offered on the same screen

### `e2e/editor-align-route.e2e.ts` — 37.4s over 16 tests

- 9.4s — editor › editor-align-route.e2e.ts › the alignment route › opening it writes no Alignment and adds no Layer
- 3.5s — editor › editor-align-route.e2e.ts › the alignment route › opens from the Project at ?p= and ?layer=, and pairs by click-then-click
- 2.8s — editor › editor-align-route.e2e.ts › “Check this alignment” › does not reopen after a reload, and is not in project.json
- 2.6s — editor › editor-align-route.e2e.ts › the alignment route › keeps a Control Point across a trip back to the Project and in again
- 2.6s — editor › editor-align-route.e2e.ts › the alignment route › names every state it can be opened in, with a way back

### `e2e/editor-project-screen.e2e.ts` — 33.1s over 19 tests

- 3.1s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › typing a name coalesces into one write, committed when the edit ends
- 2.5s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › focusing the name field and tabbing away writes nothing
- 2.4s — editor › editor-project-screen.e2e.ts › the Project screen › Escape that closes the Project-name editor does not abandon a part-drawn shape
- 2.2s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › opens as a modal dialog, closes on Escape, and gives focus back
- 2.2s — editor › editor-project-screen.e2e.ts › the Project screen › keeps the add-Layer buttons on screen under a stack taller than the rail

### `e2e/editor-pwa.e2e.ts` — 32.9s over 23 tests

- 4.7s — editor › editor-pwa.e2e.ts › the app with the network off › a Project with a local Map Image is fully usable with the network off
- 4.5s — editor › editor-pwa.e2e.ts › a working session that reaches other people’s servers › reads a referenced Map Image and a Base Map that needs the network, and caches neither
- 4.0s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › a referenced Map Image says so, names its host, and breaks nothing else
- 3.3s — editor › editor-pwa.e2e.ts › an update, and who decides when › the prompt appears, nothing reloads, and the alignment in progress is untouched
- 1.8s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › the service worker does not serve the ProjectStore

### `e2e/editor-remote-conflict.e2e.ts` — 26.6s over 11 tests

- 5.5s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › names the file another machine wrote, and replaces it when told to
- 4.2s — editor › editor-remote-conflict.e2e.ts › Importing a Project into a bound Workspace › reserves the Remote’s own directories, and publishes as ordinary local work
- 3.4s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › says nothing needs changing when the Remote matches, even with no record of publishing it
- 2.7s — editor › editor-remote-conflict.e2e.ts › Remote Status on the navigation bar › follows a bound Workspace through drift, staleness and a failed check
- 2.6s — editor › editor-remote-conflict.e2e.ts › Update from GitHub › brings the Remote’s work in when the author asks, and never before

### `e2e/editor-named-workspaces.e2e.ts` — 23.1s over 21 tests

- 2.1s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › confirms first, naming the Workspace and its size, and then removes it entirely
- 2.1s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › takes the Workspace’s unfinished deletions with it, not only its journal
- 2.0s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › keeps the Workspace when the confirmation is declined
- 1.6s — editor › editor-named-workspaces.e2e.ts › Workspace settings › carries the folder offer, the install offer, and what the browser said about keeping storage
- 1.6s — editor › editor-named-workspaces.e2e.ts › switching Workspaces with work in flight › flushes the pending write to the Workspace being left, and writes nothing to the one entered

### `e2e/editor-image-ingest.e2e.ts` — 21.2s over 9 tests

- 5.3s — editor › editor-image-ingest.e2e.ts › adding a Map Image from a file › says so when a second file is picked while one is still being prepared
- 4.9s — editor › editor-image-ingest.e2e.ts › adding a Map Image from a file › the Layer appears first, and reports its own preparation on its own card
- 2.2s — editor › editor-image-ingest.e2e.ts › adding a Map Image from a file › shows an image that was already in the Project when it is opened
- 2.0s — editor › editor-image-ingest.e2e.ts › adding a Map Image from a file › turns a picked file into a pyramid in the Project, with progress announced
- 1.7s — editor › editor-image-ingest.e2e.ts › adding a Map Image from a file › picking the same file twice in a row starts two preparations

### `e2e/editor-opening-view.e2e.ts` — 20.3s over 12 tests

- 5.5s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › a toggled Layer, a renamed Layer, and a new Annotation all leave the viewport alone
- 3.3s — editor › editor-opening-view.e2e.ts › the alignment view › lands on the Control Points, and a moved Control Point leaves the map alone
- 2.5s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › “Fit project” re-frames on demand, and says so
- 1.2s — editor › editor-opening-view.e2e.ts › opening a Project › writes nothing at all
- 1.2s — editor › editor-opening-view.e2e.ts › a Project opens on its own content › takes the short way round the antimeridian

### `e2e/editor-backup.e2e.ts` — 17.0s over 7 tests

- 4.0s — editor › editor-backup.e2e.ts › restoring a Workspace › restores a Label and draws it on the map
- 3.3s — editor › editor-backup.e2e.ts › restoring a Workspace › creates a new Workspace, switches to it, and leaves the old one untouched
- 3.3s — editor › editor-backup.e2e.ts › backing up a folder Workspace › produces an archive that restores, rather than one that fails at restore
- 3.0s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a backup from a newer version of the app, naming where to get it
- 1.7s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a file that is not a backup, in words, and creates no Workspace

### `e2e/editor-warped-fetch.e2e.ts` — 11.3s over 3 tests

- 6.2s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › reaches the pyramid’s info.json AND its tiles through the shim
- 2.9s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › accepts the Alignment and reports bounds once there are three pairs, with nothing fetched from the network
- 2.2s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › adds no warped layer below the minimum Control Point count, and asks the network for nothing

### `e2e/editor-image-pane.e2e.ts` — 8.3s over 5 tests

- 1.9s — editor › editor-image-pane.e2e.ts › is operable from the keyboard
- 1.9s — editor › editor-image-pane.e2e.ts › pans by the distance the pointer moved, in image pixels
- 1.8s — editor › editor-image-pane.e2e.ts › loads tiles at every scale factor, ragged edges included, with nothing failing
- 1.4s — editor › editor-image-pane.e2e.ts › reports the same pixel after zooming fully out and back in
- 1.3s — editor › editor-image-pane.e2e.ts › renders the fixture Map Image with zoom at the bottom-left, and reports the pixel under the cursor

### `e2e/editor-map-image-thumbnails.e2e.ts` — 4.6s over 4 tests

- 2.0s — editor › editor-map-image-thumbnails.e2e.ts › a Workspace-held map whose coarsest tile was never written keeps the glyph
- 1.7s — editor › editor-map-image-thumbnails.e2e.ts › a Map Image added from a file shows a picture that has actually decoded
- 0.5s — editor › editor-map-image-thumbnails.e2e.ts › a Map Image referenced from a Library shows a picture drawn from that Library
- 0.4s — editor › editor-map-image-thumbnails.e2e.ts › a referenced Map Image whose record has no tile side keeps the glyph

### `e2e/editor-network-fence.e2e.ts` — 1.4s over 7 tests

- 0.4s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the service worker makes to an external origin
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the page makes to an external origin
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › leaves this suite’s own servers alone
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › lets a routed archive through, with its real bytes
- 0.0s — editor › editor-network-fence.e2e.ts › the network fence › reads a URL as local, external, or not a request at all

### `e2e/viewer.e2e.ts` — 0.4s over 2 tests

- 0.4s — viewer › viewer.e2e.ts › the hub page loads
- 0.0s — viewer › viewer.e2e.ts › the built bundle carries no publishing machinery and no alignment route

### `e2e/editor.e2e.ts` — 0.3s over 1 tests

- 0.3s — editor › editor.e2e.ts › the editor loads and renders its placeholder

### `e2e/editor-retry-budget-control.e2e.ts` — 0.0s over 0 tests



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
| Wall clock | 388.3s |
| Worker-seconds | 1534.4s |

| Spec | Tests | Worker-seconds | Per test |
| --- | ---: | ---: | ---: |
| `e2e/editor-layers.e2e.ts` | 35 | 142.3 | 4.07 |
| `e2e/editor-annotations.e2e.ts` | 37 | 136.9 | 3.70 |
| `e2e/editor-add-map-image.e2e.ts` | 18 | 117.9 | 6.55 |
| `e2e/editor-base-map.e2e.ts` | 36 | 93.2 | 2.59 |
| `e2e/viewer-reader.e2e.ts` | 63 | 83.9 | 1.33 |
| `e2e/editor-undo.e2e.ts` | 14 | 83.2 | 5.94 |
| `e2e/editor-publish.e2e.ts` | 27 | 80.5 | 2.98 |
| `e2e/editor-folder-workspace.e2e.ts` | 23 | 68.5 | 2.98 |
| `e2e/editor-remote-iiif.e2e.ts` | 18 | 62.0 | 3.44 |
| `e2e/editor-alignment.e2e.ts` | 18 | 61.8 | 3.43 |
| `e2e/editor-align-referenced.e2e.ts` | 17 | 56.3 | 3.31 |
| `e2e/editor-transfer.e2e.ts` | 30 | 55.8 | 1.86 |
| `e2e/editor-offline-copy.e2e.ts` | 17 | 53.4 | 3.14 |
| `e2e/editor-remote-binding.e2e.ts` | 20 | 51.4 | 2.57 |
| `e2e/editor-alignment-refinement.e2e.ts` | 19 | 48.0 | 2.52 |
| `e2e/editor-workspace.e2e.ts` | 39 | 47.8 | 1.23 |
| `e2e/editor-align-route.e2e.ts` | 15 | 32.8 | 2.18 |
| `e2e/editor-project-screen.e2e.ts` | 19 | 31.9 | 1.68 |
| `e2e/editor-pwa.e2e.ts` | 23 | 29.5 | 1.28 |
| `e2e/editor-clone-remote.e2e.ts` | 18 | 24.0 | 1.33 |
| `e2e/editor-named-workspaces.e2e.ts` | 21 | 23.3 | 1.11 |
| `e2e/editor-image-ingest.e2e.ts` | 9 | 21.5 | 2.39 |
| `e2e/editor-opening-view.e2e.ts` | 12 | 20.6 | 1.72 |
| `e2e/editor-github-signin.e2e.ts` | 20 | 20.4 | 1.02 |
| `e2e/editor-stored-image-pane.e2e.ts` | 6 | 19.4 | 3.23 |
| `e2e/editor-review-remote.e2e.ts` | 20 | 19.2 | 0.96 |
| `e2e/editor-backup.e2e.ts` | 6 | 13.1 | 2.19 |
| `e2e/editor-warped-fetch.e2e.ts` | 3 | 11.4 | 3.81 |
| `e2e/editor-remote-conflict.e2e.ts` | 5 | 9.5 | 1.89 |
| `e2e/editor-image-pane.e2e.ts` | 5 | 8.1 | 1.63 |
| `e2e/editor-map-image-thumbnails.e2e.ts` | 4 | 5.0 | 1.24 |
| `e2e/editor-network-fence.e2e.ts` | 7 | 1.2 | 0.18 |
| `e2e/viewer.e2e.ts` | 2 | 0.3 | 0.15 |
| `e2e/editor.e2e.ts` | 1 | 0.3 | 0.27 |
| `e2e/editor-retry-budget-control.e2e.ts` | 0 | 0.0 | 0.00 |
| **total** | **627** | **1534.4** | **2.45** |

## The 5 costliest tests in each spec

### `e2e/editor-layers.e2e.ts` — 142.3s over 35 tests

- 15.7s — editor › editor-layers.e2e.ts › a Base Map that never finishes loading › says why the Layer cannot be drawn rather than leaving the list silent
- 10.9s — editor › editor-layers.e2e.ts › ordering, including across kinds (ADR-0002) › survives a reload
- 9.9s — editor › editor-layers.e2e.ts › ordering, including across kinds (ADR-0002) › holding a Layer over a card highlights it once, without flickering
- 9.4s — editor › editor-layers.e2e.ts › display state never reaches a portability document (ADR-0002) › reorder, rename, toggle, and opacity leave alignments and annotations byte-identical
- 7.5s — editor › editor-layers.e2e.ts › ordering, including across kinds (ADR-0002) › drags a picture of the card, not of the handle

### `e2e/editor-annotations.e2e.ts` — 136.9s over 37 tests

- 7.5s — editor › editor-annotations.e2e.ts › the keyboard alone (SPEC stories 95 and 96) › every drawing tool and style control is reachable and operable, and the tool is announced
- 6.8s — editor › editor-annotations.e2e.ts › display state never reaches the GeoJSON (ADR-0002, ADR-0010) › an unchanged Annotation Layer stays byte-identical across a session that only looked
- 6.3s — editor › editor-annotations.e2e.ts › drawing into the Layer that is open (ticket 05) › with no Layer open, a click on the map writes into no Layer at all
- 6.2s — editor › editor-annotations.e2e.ts › deleting an Annotation (SPEC story 66) › removes it from the file and leaves the others
- 5.4s — editor › editor-annotations.e2e.ts › style is on each Annotation (ADR-0009, as amended) › a newly drawn Annotation is drawn with the last one’s style

### `e2e/editor-add-map-image.e2e.ts` — 117.9s over 18 tests

- 30.8s — editor › editor-add-map-image.e2e.ts › the dialog itself (ADR-0016, SPEC stories 111, 112) › Escape that closes it does not abandon a part-drawn shape behind it
- 12.1s — editor › editor-add-map-image.e2e.ts › the dialog itself (ADR-0016, SPEC stories 111, 112) › is never handed to a caller while the panel inside it is still working
- 9.8s — editor › editor-add-map-image.e2e.ts › adding a map this Workspace already holds › says so afterwards, because the dialog it happened in is gone (SPEC story 112)
- 9.7s — editor › editor-add-map-image.e2e.ts › the dialog itself (ADR-0016, SPEC stories 111, 112) › says it is looking through the Workspace before it can say what is in it
- 9.7s — editor › editor-add-map-image.e2e.ts › the dialog itself (ADR-0016, SPEC stories 111, 112) › every control in it is reachable by keyboard

### `e2e/editor-base-map.e2e.ts` — 93.2s over 36 tests

- 10.7s — editor › editor-base-map.e2e.ts › making a Project available offline › draws the Base Map across the extent with the archive unreachable, at the lowest zoom and the highest
- 9.1s — editor › editor-base-map.e2e.ts › making a Project available offline › is cleared from the hub, and the Projects then report themselves not available offline
- 6.1s — editor › editor-base-map.e2e.ts › finding a place › says all four things, each driven by the condition that causes it
- 5.6s — editor › editor-base-map.e2e.ts › finding a place › issues no request at all while a query is being typed
- 4.3s — editor › editor-base-map.e2e.ts › a Base Map archive that does not answer › is taken down when the archive starts answering again

### `e2e/viewer-reader.e2e.ts` — 83.9s over 63 tests

- 5.8s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › keeps the outage notice up when the archive answers its header and then stops
- 3.5s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › says the same thing about its missing labels with no connection at all
- 3.5s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › makes no claim about the Base Map when the page is opened with no connection
- 3.5s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › withdraws the claim when the Reader switches to a Base Map it has not asked yet
- 3.1s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › tells a Reader when a Map Image’s tiles stop arriving, and keeps what arrived

### `e2e/editor-undo.e2e.ts` — 83.2s over 14 tests

- 10.9s — editor › editor-undo.e2e.ts › a moved Control Point (SPEC story 38) › ignores a pane that finishes opening after its alignment route was destroyed
- 8.6s — editor › editor-undo.e2e.ts › a moved Control Point (SPEC story 38) › reverses the pairing now on screen, keeping a pair made after the round trip
- 7.2s — editor › editor-undo.e2e.ts › a deleted Annotation (SPEC stories 38 and 66) › comes back with every property, and painted again
- 7.0s — editor › editor-undo.e2e.ts › a deleted Annotation (SPEC stories 38 and 66) › goes back into the Layer it was deleted from, not the one chosen when Undo is pressed
- 6.3s — editor › editor-undo.e2e.ts › a deleted Control Point pair (SPEC story 38) › comes back with its original ordinal, undone by keyboard after Saved

### `e2e/editor-publish.e2e.ts` — 80.5s over 27 tests

- 7.6s — editor › editor-publish.e2e.ts › publishing a Workspace › stamps every info.json id with the canonical address, and the editor still opens it
- 6.1s — editor › editor-publish.e2e.ts › publishing a Workspace › announces progress from inside the modal, where the document is not inert
- 5.9s — editor › editor-publish.e2e.ts › publishing to a Remote › announces files done, files total and the requests left, and keeps focus
- 5.1s — editor › editor-publish.e2e.ts › publishing a Workspace › refreshes a version stamp that has gone stale, and says so before it is refreshed
- 5.0s — editor › editor-publish.e2e.ts › publishing to a Remote › sends the Workspace to its Remote, .nojekyll and all

### `e2e/editor-folder-workspace.e2e.ts` — 68.5s over 23 tests

- 5.4s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › leaves the browser Workspace’s Projects untouched, in both directions
- 5.0s — editor › editor-folder-workspace.e2e.ts › a bundle opened from a folder Workspace (ticket 14) › leaves the review copy even when it holds the name the exit goes back to
- 3.7s — editor › editor-folder-workspace.e2e.ts › an interrupted write to a real folder (ADR-0017 rule 4) › leaves the previous project.json intact, parseable, and with no litter beside it
- 3.6s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › keeps the folder when "Use browser storage instead" is the escape from an unreachable one
- 3.6s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › writes a Project the browser backend reads with no conversion, once copied in

### `e2e/editor-remote-iiif.e2e.ts` — 62.0s over 18 tests

- 6.9s — editor › editor-remote-iiif.e2e.ts › adding a Map Image from a IIIF URL › re-adding a map after deleting its Layer keeps the Alignment already on it
- 6.5s — editor › editor-remote-iiif.e2e.ts › adding a Map Image from a IIIF URL › adding a map another Project has aligned keeps that Alignment, and says so
- 6.3s — editor › editor-remote-iiif.e2e.ts › adding a Map Image from a IIIF URL › adding the same referenced map again leaves the stack byte-identical
- 5.3s — editor › editor-remote-iiif.e2e.ts › adding a Map Image from a IIIF URL › a deleted map Layer comes back when the same map is added again
- 4.8s — editor › editor-remote-iiif.e2e.ts › adding a Map Image from a IIIF URL › imports the community Alignment over a starter nobody has touched

### `e2e/editor-alignment.e2e.ts` — 61.8s over 18 tests

- 6.6s — editor › editor-alignment.e2e.ts › the Alignment on disk › restores every pair, its ordinal, and the warped render across a reload
- 6.0s — editor › editor-alignment.e2e.ts › the warped Map Image › appears over the Base Map on the third pair, and not before
- 4.6s — editor › editor-alignment.e2e.ts › Control Point pairing › Escape after the first click of the very first pair writes nothing at all
- 3.4s — editor › editor-alignment.e2e.ts › the Alignment on disk › surfaces an Alignment that is there and cannot be read, rather than silently emptying it
- 3.2s — editor › editor-alignment.e2e.ts › choosing the Base Map while aligning › the switcher is on the alignment workspace, with no navigation

### `e2e/editor-align-referenced.e2e.ts` — 56.3s over 17 tests

- 5.9s — editor › editor-align-referenced.e2e.ts › names a different set of Projects for a different map on the same screen
- 5.5s — editor › editor-align-referenced.e2e.ts › warns only on the Map Image the warning is about
- 4.4s — editor › editor-align-referenced.e2e.ts › an offline copy of a map aligned in place keeps every Control Point
- 3.9s — editor › editor-align-referenced.e2e.ts › says when somebody else changed this Alignment, and puts their version back
- 3.9s — editor › editor-align-referenced.e2e.ts › refuses to open the alignment view offline, and names the host

### `e2e/editor-transfer.e2e.ts` — 55.8s over 30 tests

- 4.1s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › is absent from the user’s own Project list, backup, and size
- 3.7s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › two review copies show their own Alignment of the same sheet
- 3.0s — editor › editor-transfer.e2e.ts › the review banner is on every screen (workspace-and-layers SPEC story 92) › both exits work from the keyboard alone (workspace-and-layers SPEC story 95)
- 2.7s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › is explored as though it were the reader’s own: panned, toggled, and read
- 2.6s — editor › editor-transfer.e2e.ts › the review banner is on every screen (workspace-and-layers SPEC story 92) › the discard confirmation is a real modal, dismissible with Escape

### `e2e/editor-offline-copy.e2e.ts` — 53.4s over 17 tests

- 9.6s — editor › editor-offline-copy.e2e.ts › making an offline copy › reports progress, and announces it to assistive technology
- 6.4s — editor › editor-offline-copy.e2e.ts › a copied Map Image, once it is copied › a copied map is one pyramid that two Projects both draw
- 6.1s — editor › editor-offline-copy.e2e.ts › a copied Map Image, once it is copied › renders warped through the injection shim with no request to the library at all
- 2.8s — editor › editor-offline-copy.e2e.ts › a copied Map Image, once it is copied › survives a reload with the network switched off, drawing from the Project
- 2.7s — editor › editor-offline-copy.e2e.ts › making an offline copy › copies a level-0 source from its own tiles, having warned that it means many requests

### `e2e/editor-remote-binding.e2e.ts` — 51.4s over 20 tests

- 21.2s — editor › editor-remote-binding.e2e.ts › a first visit › shows no sign-in affordance anywhere
- 3.7s — editor › editor-remote-binding.e2e.ts › a Review Workspace › arrives unbound, and reads no credential while it is open (stories 40, 42)
- 3.2s — editor › editor-remote-binding.e2e.ts › the pasted credential › survives a reload and is forgotten on signing out (stories 35, 37)
- 3.1s — editor › editor-remote-binding.e2e.ts › a restored Backup › arrives unbound
- 3.0s — editor › editor-remote-binding.e2e.ts › the pasted credential › can be supplied again for a Workspace that is already bound (story 30)

### `e2e/editor-alignment-refinement.e2e.ts` — 48.0s over 19 tests

- 3.6s — editor › editor-alignment-refinement.e2e.ts › the transformation picker (ADR-0013) › a chosen type survives a reload, order and all, and reaches the renderer
- 3.5s — editor › editor-alignment-refinement.e2e.ts › the Resource Mask (SPEC stories 46 and 47) › an edited mask narrows the warped render and survives a reload
- 3.5s — editor › editor-alignment-refinement.e2e.ts › distortion (ADR-0013) › goes on colourising after every kind of Alignment edit, without rebuilding the map
- 3.4s — editor › editor-alignment-refinement.e2e.ts › the Resource Mask (SPEC stories 46 and 47) › writes a Resource Mask vertex below 1e-6 in plain decimal, and reads it back
- 3.0s — editor › editor-alignment-refinement.e2e.ts › the transformation picker (ADR-0013) › never writes straight, linear, or the bare polynomial alias, under any interaction

### `e2e/editor-workspace.e2e.ts` — 47.8s over 39 tests

- 2.9s — editor › editor-workspace.e2e.ts › the save indicator (ADR-0017 rule 5) › transitions saved → unsaved → saving → saved as the Project name is typed
- 2.2s — editor › editor-workspace.e2e.ts › opening a Project and closing it (ADR-0010) › tabbing and clicking through the name field writes nothing
- 2.1s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › does not put an edit back into a Project the user deleted
- 1.9s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › does not leak a deleted Project’s file into a new one that reused its folder
- 1.8s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › puts the edit back when the Workspace it was typed into is opened again

### `e2e/editor-align-route.e2e.ts` — 32.8s over 15 tests

- 9.0s — editor › editor-align-route.e2e.ts › the alignment route › opening it writes no Alignment and adds no Layer
- 2.7s — editor › editor-align-route.e2e.ts › the alignment route › keeps a Control Point across a trip back to the Project and in again
- 2.7s — editor › editor-align-route.e2e.ts › “Check this alignment” › does not reopen after a reload, and is not in project.json
- 2.5s — editor › editor-align-route.e2e.ts › the alignment route › opens from the Project at ?p= and ?layer=, and pairs by click-then-click
- 2.4s — editor › editor-align-route.e2e.ts › the alignment route › names every state it can be opened in, with a way back

### `e2e/editor-project-screen.e2e.ts` — 31.9s over 19 tests

- 3.2s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › typing a name coalesces into one write, committed when the edit ends
- 2.5s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › focusing the name field and tabbing away writes nothing
- 2.2s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › opens as a modal dialog, closes on Escape, and gives focus back
- 2.1s — editor › editor-project-screen.e2e.ts › what the app says when something is wrong (SPEC stories 111, 112) › a save that failed says why, in a region a screen reader is given
- 2.0s — editor › editor-project-screen.e2e.ts › the navigation bar › is on the hub, the Project and the alignment route, carrying exactly its things

### `e2e/editor-pwa.e2e.ts` — 29.5s over 23 tests

- 4.2s — editor › editor-pwa.e2e.ts › a working session that reaches other people’s servers › reads a referenced Map Image and a Base Map that needs the network, and caches neither
- 4.0s — editor › editor-pwa.e2e.ts › the app with the network off › a Project with a local Map Image is fully usable with the network off
- 3.3s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › a referenced Map Image says so, names its host, and breaks nothing else
- 3.1s — editor › editor-pwa.e2e.ts › an update, and who decides when › the prompt appears, nothing reloads, and the alignment in progress is untouched
- 1.7s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › the service worker does not serve the ProjectStore

### `e2e/editor-clone-remote.e2e.ts` — 24.0s over 18 tests

- 2.6s — editor › editor-clone-remote.e2e.ts › what a Clone never does › goes on saying what it did after the dialog is closed and the Workspace changed
- 2.1s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › binds the result to the repository it came from
- 2.1s — editor › editor-clone-remote.e2e.ts › what a Clone never does › a second Clone of the same repository gets its own name, not the first one
- 1.7s — editor › editor-clone-remote.e2e.ts › what a Clone never does › leaves the Workspace it was started from exactly as it was
- 1.6s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › the cloned Project lists on the hub, opens, and draws

### `e2e/editor-named-workspaces.e2e.ts` — 23.3s over 21 tests

- 2.0s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › takes the Workspace’s unfinished deletions with it, not only its journal
- 2.0s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › keeps the Workspace when the confirmation is declined
- 2.0s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › confirms first, naming the Workspace and its size, and then removes it entirely
- 1.7s — editor › editor-named-workspaces.e2e.ts › the Workspace on the bar › creates a second Workspace, finds it empty, and finds the first one again
- 1.7s — editor › editor-named-workspaces.e2e.ts › Workspace settings › carries the folder offer, the install offer, and what the browser said about keeping storage

### `e2e/editor-image-ingest.e2e.ts` — 21.5s over 9 tests

- 5.2s — editor › editor-image-ingest.e2e.ts › adding a Map Image from a file › says so when a second file is picked while one is still being prepared
- 5.1s — editor › editor-image-ingest.e2e.ts › adding a Map Image from a file › the Layer appears first, and reports its own preparation on its own card
- 2.2s — editor › editor-image-ingest.e2e.ts › adding a Map Image from a file › shows an image that was already in the Project when it is opened
- 2.0s — editor › editor-image-ingest.e2e.ts › adding a Map Image from a file › turns a picked file into a pyramid in the Project, with progress announced
- 1.8s — editor › editor-image-ingest.e2e.ts › adding a Map Image from a file › picking the same file twice in a row starts two preparations

### `e2e/editor-opening-view.e2e.ts` — 20.6s over 12 tests

- 5.4s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › a toggled Layer, a renamed Layer, and a new Annotation all leave the viewport alone
- 3.6s — editor › editor-opening-view.e2e.ts › the alignment view › lands on the Control Points, and a moved Control Point leaves the map alone
- 2.3s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › “Fit to this Project” re-frames on demand, and says so
- 1.2s — editor › editor-opening-view.e2e.ts › a Project opens on its own content › takes the short way round the antimeridian
- 1.2s — editor › editor-opening-view.e2e.ts › a Project opens on its own content › frames on the city its Annotations are in, not on the deployment default

### `e2e/editor-github-signin.e2e.ts` — 20.4s over 20 tests

- 2.2s — editor › editor-github-signin.e2e.ts › a Review Workspace, with a GitHub sign-in held › reads no sign-in, offers none, and spends nothing while it is open
- 1.7s — editor › editor-github-signin.e2e.ts › a sign-in that has run out › does not take a pasted token down with it
- 1.6s — editor › editor-github-signin.e2e.ts › signing in with GitHub › shows the account on the bar once the Workspace is bound
- 1.5s — editor › editor-github-signin.e2e.ts › with no broker served at all › the sign-in fails legibly, and the paste is offered on the same screen
- 1.2s — editor › editor-github-signin.e2e.ts › a sign-in that has run out › is caught before any work starts, rather than by a 401 partway through

### `e2e/editor-stored-image-pane.e2e.ts` — 19.4s over 6 tests

- 6.3s — editor › editor-stored-image-pane.e2e.ts › a Map Image read from the Project › renders the correct pyramid for each of two Map Images in one Project
- 3.6s — editor › editor-stored-image-pane.e2e.ts › a Map Image read from the Project › deep-zooms the user’s own pyramid with nothing fetched from the network
- 3.4s — editor › editor-stored-image-pane.e2e.ts › a Map Image read from the Project › hands the ragged-edge drawing a fractional placement, on a real pyramid
- 3.2s — editor › editor-stored-image-pane.e2e.ts › a Map Image read from the Project › surfaces a pyramid it refuses to draw, instead of a blank map
- 2.7s — editor › editor-stored-image-pane.e2e.ts › a Map Image read from the Project › is operable from the keyboard, and reports the pixel under the pointer

### `e2e/editor-review-remote.e2e.ts` — 19.2s over 20 tests

- 2.2s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › seals the GitHub sign-in for as long as it is open
- 1.6s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › two review copies from two repositories coexist, and my own Workspace is untouched
- 1.2s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › the reviewed Project lists on the hub, opens, and draws
- 1.1s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › arrives unbound and unpublishable, and says why
- 1.0s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › needs no credential, and sends none

### `e2e/editor-backup.e2e.ts` — 13.1s over 6 tests

- 3.4s — editor › editor-backup.e2e.ts › backing up a folder Workspace › produces an archive that restores, rather than one that fails at restore
- 3.2s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a backup from a newer version of the app, naming where to get it
- 3.0s — editor › editor-backup.e2e.ts › restoring a Workspace › creates a new Workspace, switches to it, and leaves the old one untouched
- 1.7s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a file that is not a backup, in words, and creates no Workspace
- 1.1s — editor › editor-backup.e2e.ts › backing up a Workspace › downloads one tar named after the Workspace, holding the work and not the site

### `e2e/editor-warped-fetch.e2e.ts` — 11.4s over 3 tests

- 6.2s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › reaches the pyramid’s info.json AND its tiles through the shim
- 2.7s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › accepts the Alignment and reports bounds once there are three pairs, with nothing fetched from the network
- 2.5s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › adds no warped layer below the minimum Control Point count, and asks the network for nothing

### `e2e/editor-remote-conflict.e2e.ts` — 9.5s over 5 tests

- 3.7s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › names the file another machine wrote, and replaces it when told to
- 2.9s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › says nothing needs changing when the Remote matches, even with no record of publishing it
- 1.0s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › is refused with “we cannot tell” when this browser has no record of the Remote
- 0.9s — editor › editor-remote-conflict.e2e.ts › binding to a Remote that already carries somebody else’s Projects (story 23) › is refused, names the Project, and points at Clone
- 0.9s — editor › editor-remote-conflict.e2e.ts › binding to a Remote that already carries somebody else’s Projects (story 23) › goes ahead when the Remote’s Projects are all here

### `e2e/editor-image-pane.e2e.ts` — 8.1s over 5 tests

- 2.0s — editor › editor-image-pane.e2e.ts › is operable from the keyboard
- 1.9s — editor › editor-image-pane.e2e.ts › pans by the distance the pointer moved, in image pixels
- 1.7s — editor › editor-image-pane.e2e.ts › loads tiles at every scale factor, ragged edges included, with nothing failing
- 1.4s — editor › editor-image-pane.e2e.ts › reports the same pixel after zooming fully out and back in
- 1.3s — editor › editor-image-pane.e2e.ts › renders the fixture Map Image and reports the pixel under the cursor

### `e2e/editor-map-image-thumbnails.e2e.ts` — 5.0s over 4 tests

- 2.1s — editor › editor-map-image-thumbnails.e2e.ts › a Map Image added from a file shows a picture that has actually decoded
- 1.9s — editor › editor-map-image-thumbnails.e2e.ts › a Workspace-held map whose coarsest tile was never written keeps the glyph
- 0.5s — editor › editor-map-image-thumbnails.e2e.ts › a Map Image referenced from a Library shows a picture drawn from that Library
- 0.4s — editor › editor-map-image-thumbnails.e2e.ts › a referenced Map Image whose record has no tile side keeps the glyph

### `e2e/editor-network-fence.e2e.ts` — 1.2s over 7 tests

- 0.4s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the service worker makes to an external origin
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › leaves this suite’s own servers alone
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the page makes to an external origin
- 0.3s — editor › editor-network-fence.e2e.ts › the network fence › lets a routed archive through, with its real bytes
- 0.0s — editor › editor-network-fence.e2e.ts › the network fence › reads a URL as local, external, or not a request at all

### `e2e/viewer.e2e.ts` — 0.3s over 2 tests

- 0.3s — viewer › viewer.e2e.ts › the hub page loads
- 0.0s — viewer › viewer.e2e.ts › the built bundle carries no publishing machinery

### `e2e/editor.e2e.ts` — 0.3s over 1 tests

- 0.3s — editor › editor.e2e.ts › the editor loads and renders its placeholder

### `e2e/editor-retry-budget-control.e2e.ts` — 0.0s over 0 tests



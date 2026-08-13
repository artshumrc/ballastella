# Seam 2 cost profile

⚠ **Generated. Do not edit by hand** — regenerate with `pnpm test:e2e --profile`
(`scripts/cost-profile.mjs`), which appends a reporter rather than replacing the list, so a
profiled run keeps the retry budget and gives the gate’s verdict.

**Worker-seconds, not wall time.** A test’s cost is the time a worker spent inside it, summed
over every attempt. That is what moving the claim to another seam actually removes; wall time
depends on how the scheduler packed the run.

| Run | 2026-08-13 |
| --- | --- |
| Command | `pnpm test:e2e --profile` |
| Tests | 668 |
| Skipped (not counted above) | 1 |
| Workers | 4 |
| Wall clock | 785.3s |
| Worker-seconds | 2998.6s |

| Spec | Tests | Worker-seconds | Per test |
| --- | ---: | ---: | ---: |
| `e2e/editor-annotations.e2e.ts` | 51 | 491.2 | 9.63 |
| `e2e/editor-layers.e2e.ts` | 36 | 367.0 | 10.19 |
| `e2e/viewer-reader.e2e.ts` | 63 | 260.6 | 4.14 |
| `e2e/editor-alignment-refinement.e2e.ts` | 21 | 189.9 | 9.04 |
| `e2e/editor-align-referenced.e2e.ts` | 17 | 175.7 | 10.34 |
| `e2e/editor-base-map.e2e.ts` | 47 | 174.8 | 3.72 |
| `e2e/editor-offline-copy.e2e.ts` | 17 | 135.0 | 7.94 |
| `e2e/editor-undo.e2e.ts` | 14 | 128.1 | 9.15 |
| `e2e/editor-alignment.e2e.ts` | 18 | 114.1 | 6.34 |
| `e2e/editor-pwa.e2e.ts` | 23 | 82.5 | 3.59 |
| `e2e/editor-publish.e2e.ts` | 30 | 81.3 | 2.71 |
| `e2e/editor-folder-workspace.e2e.ts` | 23 | 78.0 | 3.39 |
| `e2e/editor-remote-iiif.e2e.ts` | 18 | 77.3 | 4.30 |
| `e2e/editor-add-historical-map.e2e.ts` | 18 | 70.4 | 3.91 |
| `e2e/editor-transfer.e2e.ts` | 37 | 63.9 | 1.73 |
| `e2e/editor-workspace.e2e.ts` | 41 | 55.5 | 1.35 |
| `e2e/editor-github-signin.e2e.ts` | 20 | 53.8 | 2.69 |
| `e2e/editor-remote-binding.e2e.ts` | 20 | 52.0 | 2.60 |
| `e2e/editor-align-route.e2e.ts` | 15 | 51.7 | 3.44 |
| `e2e/editor-stored-image-pane.e2e.ts` | 6 | 49.5 | 8.24 |
| `e2e/editor-project-screen.e2e.ts` | 20 | 42.5 | 2.12 |
| `e2e/editor-review-remote.e2e.ts` | 20 | 41.5 | 2.07 |
| `e2e/editor-image-ingest.e2e.ts` | 9 | 32.2 | 3.58 |
| `e2e/editor-opening-view.e2e.ts` | 12 | 25.9 | 2.16 |
| `e2e/editor-named-workspaces.e2e.ts` | 21 | 25.5 | 1.21 |
| `e2e/editor-clone-remote.e2e.ts` | 18 | 19.0 | 1.06 |
| `e2e/editor-warped-fetch.e2e.ts` | 3 | 18.0 | 6.01 |
| `e2e/editor-backup.e2e.ts` | 6 | 13.8 | 2.31 |
| `e2e/editor-remote-conflict.e2e.ts` | 5 | 9.2 | 1.84 |
| `e2e/editor-image-pane.e2e.ts` | 5 | 8.8 | 1.77 |
| `e2e/editor-historical-map-thumbnails.e2e.ts` | 4 | 7.5 | 1.88 |
| `e2e/editor-network-fence.e2e.ts` | 7 | 1.6 | 0.23 |
| `e2e/editor.e2e.ts` | 1 | 0.4 | 0.37 |
| `e2e/viewer.e2e.ts` | 2 | 0.4 | 0.18 |
| `e2e/editor-retry-budget-control.e2e.ts` | 0 | 0.0 | 0.00 |
| **total** | **668** | **2998.6** | **4.49** |

## The 5 costliest tests in each spec

### `e2e/editor-annotations.e2e.ts` — 491.2s over 51 tests

- 25.9s — editor › editor-annotations.e2e.ts › solid, dashed, and dotted (SPEC story 61) › the three render distinctly, each by its own layer with its own dash pattern
- 25.8s — editor › editor-annotations.e2e.ts › style is on each Annotation (ADR-0009, as amended) › a defaultStyle from an earlier build is carried, not resolved and not deleted
- 20.6s — editor › editor-annotations.e2e.ts › solid, dashed, and dotted (SPEC story 61) › solid is the absence of stroke-dasharray, and the tuples are stored not keywords
- 19.3s — editor › editor-annotations.e2e.ts › drawing (SPEC stories 57, 58, 59) › a pin, a line, and a shape are drawn and land in the Annotation Layer’s own file
- 17.3s — editor › editor-annotations.e2e.ts › style is on each Annotation (ADR-0009, as amended) › a newly drawn Annotation is drawn with the last one’s style

### `e2e/editor-layers.e2e.ts` — 367.0s over 36 tests

- 27.7s — editor › editor-layers.e2e.ts › ordering, including across kinds (ADR-0002) › an Annotation Layer above a map Layer draws above it, and moving it down reverses that
- 27.4s — editor › editor-layers.e2e.ts › ordering, including across kinds (ADR-0002) › an opaque annotation above a map Layer still draws above it
- 26.9s — editor › editor-layers.e2e.ts › ordering, including across kinds (ADR-0002) › reorders by dragging, reaching the same render order
- 26.4s — editor › editor-layers.e2e.ts › ordering, including across kinds (ADR-0002) › drags a picture of the card, not of the handle
- 20.3s — editor › editor-layers.e2e.ts › a Base Map that never finishes loading › says why the Layer cannot be drawn rather than leaving the list silent

### `e2e/viewer-reader.e2e.ts` — 260.6s over 63 tests

- 52.2s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › takes the notice down by itself when the map’s own record answers again
- 12.1s — viewer › viewer-reader.e2e.ts › a Published Site that is not entirely well › tells a Reader when a Historical Map’s tiles stop arriving, and keeps what arrived
- 8.7s — viewer › viewer-reader.e2e.ts › a Published Site a Reader arrives at › serves the hub and one Project over plain HTTP, at a domain root and in a subdirectory
- 8.4s — viewer › viewer-reader.e2e.ts › untrusted text on a Published Site › an Annotation popup renders a scheme broken across a newline, which a browser still dispatches inert, and its prose visibly
- 7.9s — viewer › viewer-reader.e2e.ts › a Published Site a Reader arrives at › lists only the Projects on the Front Page, and still opens one that is not

### `e2e/editor-alignment-refinement.e2e.ts` — 189.9s over 21 tests

- 22.2s — editor › editor-alignment-refinement.e2e.ts › distortion (ADR-0013) › goes on colourising after every kind of Alignment edit, without rebuilding the map
- 18.6s — editor › editor-alignment-refinement.e2e.ts › distortion (ADR-0013) › is absent from project.json after being switched on and off
- 15.7s — editor › editor-alignment-refinement.e2e.ts › distortion (ADR-0013) › toggles the warped graticule
- 15.7s — editor › editor-alignment-refinement.e2e.ts › the fold warning (ADR-0013) › appears for a mirrored pair set under an affine transformation, with the overlay off
- 12.2s — editor › editor-alignment-refinement.e2e.ts › distortion (ADR-0013) › is off by default, and colours the map by log2sigma from theme-derived colours

### `e2e/editor-align-referenced.e2e.ts` — 175.7s over 17 tests

- 26.0s — editor › editor-align-referenced.e2e.ts › an offline copy of a map aligned in place keeps every Control Point
- 20.3s — editor › editor-align-referenced.e2e.ts › refuses to open the alignment view offline, and names the host
- 18.5s — editor › editor-align-referenced.e2e.ts › says when somebody else changed this Alignment, and puts their version back
- 17.4s — editor › editor-align-referenced.e2e.ts › keeps working offline once the pane exists, and says whose sheet has gone
- 13.8s — editor › editor-align-referenced.e2e.ts › warns only on the Historical Map the warning is about

### `e2e/editor-base-map.e2e.ts` — 174.8s over 47 tests

- 14.0s — editor › editor-base-map.e2e.ts › the Base Map pane › pans by dragging and zooms by wheel
- 9.1s — editor › editor-base-map.e2e.ts › a Base Map archive that does not answer › is taken down when the archive starts answering again
- 8.8s — editor › editor-base-map.e2e.ts › the Base Map pane › offers content-distinct variants that share one archive
- 7.1s — editor › editor-base-map.e2e.ts › the Base Map pane › offers the deployment catalog through a native select, marking what needs network
- 6.2s — editor › editor-base-map.e2e.ts › making a Project available offline › draws the Base Map across the extent with the archive unreachable, at the lowest zoom and the highest

### `e2e/editor-offline-copy.e2e.ts` — 135.0s over 17 tests

- 13.7s — editor › editor-offline-copy.e2e.ts › making an offline copy › reports progress, and announces it to assistive technology
- 12.0s — editor › editor-offline-copy.e2e.ts › making an offline copy › copies a level-2 source with a single full-image request and then tiles locally
- 11.9s — editor › editor-offline-copy.e2e.ts › making an offline copy › copies a level-0 source from its own tiles, having warned that it means many requests
- 11.4s — editor › editor-offline-copy.e2e.ts › making an offline copy › respects a declared maxWidth rather than making a request the service has said no to
- 10.6s — editor › editor-offline-copy.e2e.ts › making an offline copy › leaves a pyramid indistinguishable from a locally ingested one, under the id Allmaps keys it on

### `e2e/editor-undo.e2e.ts` — 128.1s over 14 tests

- 13.7s — editor › editor-undo.e2e.ts › a deleted map Layer does not come back (the resurrection trap) › is put back by undo, and one Alignment write later there is still exactly one
- 11.8s — editor › editor-undo.e2e.ts › a moved Control Point (SPEC story 38) › ignores a pane that finishes opening after its alignment route was destroyed
- 11.6s — editor › editor-undo.e2e.ts › a deleted Layer (SPEC stories 38 and 49) › restores the project.json entry and the Alignment byte-for-byte
- 10.5s — editor › editor-undo.e2e.ts › what the one undo slot will and will not hold (ADR-0014) › the record is cleared when the Project is closed
- 9.8s — editor › editor-undo.e2e.ts › what the one undo slot will and will not hold (ADR-0014) › a visibility toggle and a rename leave the delete still undoable

### `e2e/editor-alignment.e2e.ts` — 114.1s over 18 tests

- 10.9s — editor › editor-alignment.e2e.ts › choosing the Base Map while aligning › the choice survives a reload, and the workspace opens on it
- 10.7s — editor › editor-alignment.e2e.ts › the Alignment on disk › restores every pair, its ordinal, and the warped render across a reload
- 9.4s — editor › editor-alignment.e2e.ts › choosing the Base Map while aligning › choosing one records it as the Project default and leaves the pane live
- 7.9s — editor › editor-alignment.e2e.ts › the warped Historical Map › appears over the Base Map on the third pair, and not before
- 6.8s — editor › editor-alignment.e2e.ts › the Alignment on disk › excludes an incomplete pair while one is pending, and does not throw

### `e2e/editor-pwa.e2e.ts` — 82.5s over 23 tests

- 13.2s — editor › editor-pwa.e2e.ts › the app with the network off › a Project with a local Historical Map is fully usable with the network off
- 10.5s — editor › editor-pwa.e2e.ts › a working session that reaches other people’s servers › reads a referenced Historical Map and a Base Map that needs the network, and caches neither
- 8.1s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › a referenced Historical Map says so, names its host, and breaks nothing else
- 5.3s — editor › editor-pwa.e2e.ts › the app with the network off › a new Project explains the absent Base Map and still accepts a Historical Map file
- 5.3s — editor › editor-pwa.e2e.ts › what offline cannot fix, and what it must not break › the service worker does not serve the ProjectStore

### `e2e/editor-publish.e2e.ts` — 81.3s over 30 tests

- 7.8s — editor › editor-publish.e2e.ts › publishing to a Remote › leaves no result from one Workspace standing under the bar of the next
- 6.3s — editor › editor-publish.e2e.ts › publishing a Workspace › stamps every info.json id with the canonical address, and the editor still opens it
- 5.8s — editor › editor-publish.e2e.ts › publishing a Workspace › announces progress from inside the modal, where the document is not inert
- 5.0s — editor › editor-publish.e2e.ts › publishing to a Remote › announces files done, files total and the requests left, and keeps focus
- 3.5s — editor › editor-publish.e2e.ts › publishing a Workspace › removes a Base Map it published before, when the next publish leaves it out

### `e2e/editor-folder-workspace.e2e.ts` — 78.0s over 23 tests

- 7.8s — editor › editor-folder-workspace.e2e.ts › a bundle opened from a folder Workspace (ticket 14) › leaves the review copy even when it holds the name the exit goes back to
- 5.2s — editor › editor-folder-workspace.e2e.ts › a bundle opened from a folder Workspace (ticket 14) › discards the review copy and returns to the folder
- 4.8s — editor › editor-folder-workspace.e2e.ts › choosing a folder as the Workspace › leaves the browser Workspace’s Projects untouched, in both directions
- 4.8s — editor › editor-folder-workspace.e2e.ts › a bundle opened from a folder Workspace (ticket 14) › goes back to the folder, not to an OPFS Workspace invented for the purpose
- 4.5s — editor › editor-folder-workspace.e2e.ts › an interrupted write to a real folder (ADR-0017 rule 4) › leaves the previous project.json intact, parseable, and with no litter beside it

### `e2e/editor-remote-iiif.e2e.ts` — 77.3s over 18 tests

- 7.7s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › re-adding a map after deleting its Layer keeps the Alignment already on it
- 7.2s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › adding the same referenced map again leaves the stack byte-identical
- 6.8s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › adding a map another Project has aligned keeps that Alignment, and says so
- 6.1s — editor › editor-remote-iiif.e2e.ts › adding a Historical Map from a IIIF URL › a deleted map Layer comes back when the same map is added again
- 5.7s — editor › editor-remote-iiif.e2e.ts › a referenced Historical Map, drawn from the library that holds it › draws a referenced Layer warped, from tiles the remote host served (reached by load)

### `e2e/editor-add-historical-map.e2e.ts` — 70.4s over 18 tests

- 12.5s — editor › editor-add-historical-map.e2e.ts › the dialog itself (ADR-0016, SPEC stories 111, 112) › is never handed to a caller while the panel inside it is still working
- 6.4s — editor › editor-add-historical-map.e2e.ts › adding a Historical Map › adds an aligned Workspace map to another Project, drawing it and copying nothing
- 4.9s — editor › editor-add-historical-map.e2e.ts › adding a Historical Map › lists the Workspace’s other maps with their sizes, and leaves out the ones this Project has
- 4.9s — editor › editor-add-historical-map.e2e.ts › the picker’s pictures (ADR-0030, SPEC story 3) › a Workspace-held candidate shows a picture that has actually decoded
- 4.4s — editor › editor-add-historical-map.e2e.ts › adding a Historical Map › offers a pyramid whose Alignment never landed, and adding it writes one

### `e2e/editor-transfer.e2e.ts` — 63.9s over 37 tests

- 4.2s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › is explored as though it were the reader’s own: panned, toggled, and read
- 4.0s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › is absent from the user’s own Project list, backup, and size
- 3.8s — editor › editor-transfer.e2e.ts › opening a bundle lands in a review copy (workspace-and-layers SPEC stories 90–92) › two review copies show their own Alignment of the same sheet
- 3.1s — editor › editor-transfer.e2e.ts › the review banner is on every screen (workspace-and-layers SPEC story 92) › both exits work from the keyboard alone (workspace-and-layers SPEC story 95)
- 2.5s — editor › editor-transfer.e2e.ts › the review banner is on every screen (workspace-and-layers SPEC story 92) › the discard confirmation is a real modal, dismissible with Escape

### `e2e/editor-workspace.e2e.ts` — 55.5s over 41 tests

- 3.0s — editor › editor-workspace.e2e.ts › the save indicator (ADR-0017 rule 5) › transitions saved → unsaved → saving → saved as the Project name is typed
- 3.0s — editor › editor-workspace.e2e.ts › opening a Project and closing it (ADR-0010) › tabbing and clicking through the name field writes nothing
- 2.5s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › does not put an edit back into a Project the user deleted
- 2.2s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › does not leak a deleted Project’s file into a new one that reused its folder
- 2.1s — editor › editor-workspace.e2e.ts › surviving a real navigation (ADR-0017 rule 3, as amended) › says that it put the change back, in text a screen reader is given

### `e2e/editor-github-signin.e2e.ts` — 53.8s over 20 tests

- 4.9s — editor › editor-github-signin.e2e.ts › signing in with GitHub › puts the Project the sign-in left from back on the address bar
- 4.8s — editor › editor-github-signin.e2e.ts › signing in with GitHub › takes the code and state off the address bar, leaving the Workspace alone
- 4.6s — editor › editor-github-signin.e2e.ts › signing in with GitHub › completes the round trip and says whose account it is
- 4.3s — editor › editor-github-signin.e2e.ts › signing in with GitHub › shows the account on the bar once the Workspace is bound
- 3.8s — editor › editor-github-signin.e2e.ts › signing in with GitHub › keeps the sign-in in session storage and nothing in localStorage

### `e2e/editor-remote-binding.e2e.ts` — 52.0s over 20 tests

- 21.3s — editor › editor-remote-binding.e2e.ts › a first visit › shows no sign-in affordance anywhere
- 3.6s — editor › editor-remote-binding.e2e.ts › a Review Workspace › arrives unbound, and reads no credential while it is open (stories 40, 42)
- 3.4s — editor › editor-remote-binding.e2e.ts › the pasted credential › survives a reload and is forgotten on signing out (stories 35, 37)
- 3.1s — editor › editor-remote-binding.e2e.ts › a restored Backup › arrives unbound
- 3.1s — editor › editor-remote-binding.e2e.ts › the pasted credential › can be supplied again for a Workspace that is already bound (story 30)

### `e2e/editor-align-route.e2e.ts` — 51.7s over 15 tests

- 10.7s — editor › editor-align-route.e2e.ts › the alignment route › opening it writes no Alignment and adds no Layer
- 5.2s — editor › editor-align-route.e2e.ts › “Check this alignment” › does not reopen after a reload, and is not in project.json
- 4.5s — editor › editor-align-route.e2e.ts › “Check this alignment” › keeps the overlay, the measure and the grid out of the accessibility tree until opened
- 4.5s — editor › editor-align-route.e2e.ts › the alignment route › opens from the Project at ?p= and ?layer=, and pairs by click-then-click
- 4.1s — editor › editor-align-route.e2e.ts › the alignment route › names every state it can be opened in, with a way back

### `e2e/editor-stored-image-pane.e2e.ts` — 49.5s over 6 tests

- 14.2s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › renders the correct pyramid for each of two Historical Maps in one Project
- 11.5s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › deep-zooms the user’s own pyramid with nothing fetched from the network
- 9.6s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › hands the ragged-edge drawing a fractional placement, on a real pyramid
- 8.7s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › is operable from the keyboard, and reports the pixel under the pointer
- 5.0s — editor › editor-stored-image-pane.e2e.ts › a Historical Map read from the Project › surfaces a pyramid it refuses to draw, instead of a blank map

### `e2e/editor-project-screen.e2e.ts` — 42.5s over 20 tests

- 3.9s — editor › editor-project-screen.e2e.ts › Project settings (SPEC stories 10, 11) › typing a name coalesces into one write, committed when the edit ends
- 3.5s — editor › editor-project-screen.e2e.ts › what the app says when something is wrong (SPEC stories 111, 112) › the save indicator is the only role="status" in the app, on every screen
- 3.4s — editor › editor-project-screen.e2e.ts › the Project screen › Escape that closes the Project menu does not abandon a part-drawn shape
- 3.2s — editor › editor-project-screen.e2e.ts › the navigation bar › is on the hub, the Project and the alignment route, carrying exactly its things
- 3.2s — editor › editor-project-screen.e2e.ts › the Layer stack and the Base Map are not pages of their own › nothing in the app links to /layers/, /base-map/ or /image-pane/

### `e2e/editor-review-remote.e2e.ts` — 41.5s over 20 tests

- 4.0s — editor › editor-review-remote.e2e.ts › refusals, all before a byte is written › something that is not a repository address at all
- 4.0s — editor › editor-review-remote.e2e.ts › refusals, all before a byte is written › a repository nobody can read anonymously
- 3.8s — editor › editor-review-remote.e2e.ts › refusals, all before a byte is written › a Project folder the Remote does not hold, naming the ones it does
- 3.3s — editor › editor-review-remote.e2e.ts › refusals, all before a byte is written › not enough room, named in bytes, with no review copy made at all
- 2.8s — editor › editor-review-remote.e2e.ts › reviewing one Project from a Remote › seals the GitHub sign-in for as long as it is open

### `e2e/editor-image-ingest.e2e.ts` — 32.2s over 9 tests

- 7.4s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › says so when a second file is picked while one is still being prepared
- 6.8s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › the Layer appears first, and reports its own preparation on its own card
- 3.9s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › turns a picked file into a pyramid in the Project, with progress announced
- 3.4s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › picking the same file twice in a row starts two preparations
- 2.6s — editor › editor-image-ingest.e2e.ts › adding a Historical Map from a file › shows an image that was already in the Project when it is opened

### `e2e/editor-opening-view.e2e.ts` — 25.9s over 12 tests

- 5.8s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › a toggled Layer, a renamed Layer, and a new Annotation all leave the viewport alone
- 5.4s — editor › editor-opening-view.e2e.ts › the alignment view › lands on the Control Points, and a moved Control Point leaves the map alone
- 2.4s — editor › editor-opening-view.e2e.ts › the fit happens once, on open › “Fit to this Project” re-frames on demand, and says so
- 1.9s — editor › editor-opening-view.e2e.ts › a Project opens on its own content › opens on the deployment default when there are no Layers at all
- 1.8s — editor › editor-opening-view.e2e.ts › a Project opens on its own content › opens on the deployment default when its only Historical Map is unaligned

### `e2e/editor-named-workspaces.e2e.ts` — 25.5s over 21 tests

- 2.2s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › keeps the Workspace when the confirmation is declined
- 2.2s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › confirms first, naming the Workspace and its size, and then removes it entirely
- 2.1s — editor › editor-named-workspaces.e2e.ts › deleting a Workspace › takes the Workspace’s unfinished deletions with it, not only its journal
- 1.9s — editor › editor-named-workspaces.e2e.ts › the Workspace on the bar › creates a second Workspace, finds it empty, and finds the first one again
- 1.8s — editor › editor-named-workspaces.e2e.ts › switching Workspaces with work in flight › flushes the pending write to the Workspace being left, and writes nothing to the one entered

### `e2e/editor-clone-remote.e2e.ts` — 19.0s over 18 tests

- 1.8s — editor › editor-clone-remote.e2e.ts › what a Clone never does › goes on saying what it did after the dialog is closed and the Workspace changed
- 1.6s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › binds the result to the repository it came from
- 1.6s — editor › editor-clone-remote.e2e.ts › what a Clone never does › a second Clone of the same repository gets its own name, not the first one
- 1.6s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › the cloned Project lists on the hub, opens, and draws
- 1.1s — editor › editor-clone-remote.e2e.ts › cloning a published Workspace › makes a new Workspace, fills it, and switches to it

### `e2e/editor-warped-fetch.e2e.ts` — 18.0s over 3 tests

- 8.6s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › reaches the pyramid’s info.json AND its tiles through the shim
- 4.8s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › accepts the Alignment and reports bounds once there are three pairs, with nothing fetched from the network
- 4.6s — editor › editor-warped-fetch.e2e.ts › warped rendering reads through the ProjectStore › adds no warped layer below the minimum Control Point count, and asks the network for nothing

### `e2e/editor-backup.e2e.ts` — 13.8s over 6 tests

- 3.4s — editor › editor-backup.e2e.ts › backing up a folder Workspace › produces an archive that restores, rather than one that fails at restore
- 3.2s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a backup from a newer version of the app, naming where to get it
- 2.8s — editor › editor-backup.e2e.ts › restoring a Workspace › creates a new Workspace, switches to it, and leaves the old one untouched
- 1.9s — editor › editor-backup.e2e.ts › restoring a Workspace › refuses a file that is not a backup, in words, and creates no Workspace
- 1.6s — editor › editor-backup.e2e.ts › backing up a Workspace › downloads one tar named after the Workspace, holding the work and not the site

### `e2e/editor-remote-conflict.e2e.ts` — 9.2s over 5 tests

- 3.7s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › names the file another machine wrote, and replaces it when told to
- 2.7s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › says nothing needs changing when the Remote matches, even with no record of publishing it
- 1.0s — editor › editor-remote-conflict.e2e.ts › binding to a Remote that already carries somebody else’s Projects (story 23) › goes ahead when the Remote’s Projects are all here
- 0.9s — editor › editor-remote-conflict.e2e.ts › a publish that would overwrite work this browser has never seen › is refused with “we cannot tell” when this browser has no record of the Remote
- 0.9s — editor › editor-remote-conflict.e2e.ts › binding to a Remote that already carries somebody else’s Projects (story 23) › is refused, names the Project, and points at Clone

### `e2e/editor-image-pane.e2e.ts` — 8.8s over 5 tests

- 2.1s — editor › editor-image-pane.e2e.ts › pans by the distance the pointer moved, in image pixels
- 2.1s — editor › editor-image-pane.e2e.ts › is operable from the keyboard
- 1.9s — editor › editor-image-pane.e2e.ts › loads tiles at every scale factor, ragged edges included, with nothing failing
- 1.4s — editor › editor-image-pane.e2e.ts › reports the same pixel after zooming fully out and back in
- 1.3s — editor › editor-image-pane.e2e.ts › renders the fixture Historical Map and reports the pixel under the cursor

### `e2e/editor-historical-map-thumbnails.e2e.ts` — 7.5s over 4 tests

- 3.5s — editor › editor-historical-map-thumbnails.e2e.ts › a Historical Map added from a file shows a picture that has actually decoded
- 2.3s — editor › editor-historical-map-thumbnails.e2e.ts › a Workspace-held map whose coarsest tile was never written keeps the glyph
- 0.9s — editor › editor-historical-map-thumbnails.e2e.ts › a Historical Map referenced from a Library shows a picture drawn from that Library
- 0.8s — editor › editor-historical-map-thumbnails.e2e.ts › a referenced Historical Map whose record has no tile side keeps the glyph

### `e2e/editor-network-fence.e2e.ts` — 1.6s over 7 tests

- 0.5s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the service worker makes to an external origin
- 0.4s — editor › editor-network-fence.e2e.ts › the network fence › blocks a request the page makes to an external origin
- 0.4s — editor › editor-network-fence.e2e.ts › the network fence › lets a routed archive through, with its real bytes
- 0.4s — editor › editor-network-fence.e2e.ts › the network fence › leaves this suite’s own servers alone
- 0.0s — editor › editor-network-fence.e2e.ts › the network fence › reads a URL as local, external, or not a request at all

### `e2e/editor.e2e.ts` — 0.4s over 1 tests

- 0.4s — editor › editor.e2e.ts › the editor loads and renders its placeholder

### `e2e/viewer.e2e.ts` — 0.4s over 2 tests

- 0.3s — viewer › viewer.e2e.ts › the hub page loads
- 0.0s — viewer › viewer.e2e.ts › the built bundle carries no publishing machinery

### `e2e/editor-retry-budget-control.e2e.ts` — 0.0s over 0 tests



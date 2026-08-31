#!/usr/bin/env node
// The Seam 2 suite may not be larger than a recorded ceiling.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY THIS EXISTS: THIRTEEN MINUTES ARRIVED A HANDFUL OF TESTS AT A TIME.                    │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// Nobody decided to spend a quarter of an hour on every gate. Eighteen changes each added a handful
// of browser tests, every one of them defensible on its own, and 675 tests is what that looks like
// once nothing is watching the total. The suite took thirteen minutes; the work to bring it back
// under three was mostly moving claims down a seam, not deleting them.
//
// This makes regrowth a *decision*. The ceiling can be raised — it is a number in a file, not a
// principle — but raising it means editing {@link SEAM_2_CEILING} and writing down why, which is a
// thing a reviewer can see. Accretion is what it stops, not growth.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// A COUNT IS A PROXY FOR TIME, AND AN IMPERFECT ONE.
//
// What actually hurts is worker-seconds, and tests here differ by more than a factor of two: 4.14s
// per test in `viewer-reader` against 9.63s in `editor-annotations`
// (`docs/e2e-cost-profile.md`). So a run can lose ten cheap tests,
// gain two dear ones, and this check will call that an improvement when it was not. `pnpm test:e2e
// --profile` (`scripts/cost-profile.mjs`) is where cost per test is read; this is only the fence.
//
// It is still a count rather than a wall-clock budget, deliberately. A timing gate on a shared,
// unevenly-loaded box fails for reasons nobody can act on, which is exactly the argument
// `scripts/retry-budget.mjs` records about the 0.5% budget that fired on contention no code change
// removed. A gate that fires on something nobody can fix stops being a signal and becomes a toll.
// A count is at least a number the person who tripped it chose.
//
// The count is whatever `playwright test --list` reports, skips included — 628 today, one of which
// is a deliberate skip. Listing does not build the apps or start the web servers, which is what
// keeps this affordable inside `pnpm lint`; it costs about a second.
//
// Override with `BALLASTELLA_SEAM_2_CEILING` to watch the fence fail on purpose, which is the
// positive control this check's contract requires:
//
//     BALLASTELLA_SEAM_2_CEILING=627 node scripts/check-seam-2-size.mjs   # must fail

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * The most Seam 2 tests this repository will carry.
 *
 * | When | Ceiling | Why |
 * | --- | --- | --- |
 * | 2026-08-13 | 669 | Where the ledger starts: the count after scheduling and the first migration, so the fence holds the line before it starts moving it. |
 * | 2026-08-13 | 637 | The annotation document, Base Map catalog and arithmetic, Project Bundle refusal and publish output claims now live at Seam 1. |
 * | 2026-08-13 | 634 | The slow-test pass: a footnote-syntax claim already asserted six times at Seam 1 retired from `editor-annotations`, and the transformation picker's option list and disclosure rehoused to Seam 1c. |
 * | 2026-08-14 | 628 | The Annotation row, editor panel and tool announcements, the foreign Layer row and the problem-action gating, and the hub's wording all move to Seam 1c. |
 * | 2026-08-14 | 630 | Binding on the strength of a GitHub sign-in, and the grant record surviving it. The bug was that the *dialog* validated its paste field regardless, so a signed-in scholar was asked for a token anyway — a claim about a component reading a store, which Seam 1 cannot reach (no `WorkspaceStorage` harness exists) and which a fake store at Seam 1c would assert about the fake. |
 * | 2026-08-18 | 631 | A pasted address that is a plain image file, copied into the Workspace and tiled here. The download and its refusals are asserted at Seam 1 (`remote-image/fetch-remote-image.test.ts`) and the tiler at Seam 1 already; what only Seam 2 can see is that the three halves are wired together — the IIIF reader hands the address over, the dialog closes on the download, and a pyramid of this Workspace's own is what the Layer ends up drawing. |
 * | 2026-08-18 | 632 | A dragged Resource Mask corner and Annotation vertex must repaint MapLibre's real GeoJSON source before pointer-up. The transient geometry can only be proved against the renderer that draws the outline, not against the editing state that feeds it. |
 * | 2026-08-19 | 634 | The Label: two tests for a kind of Annotation whose whole product is pixels. That a Label's words are drawn at all, that the Pin beside it did not also draw as one, that an empty title draws nothing, and that the chip grew with the words are claims about glyphs, an SDF and `icon-text-fit` — happy-dom has none of the three, so they are Seam 2 or nowhere. Everything about the Label that is arithmetic went to Seam 1 (`label-chip.test.ts`, `stack-layers.test.ts`, `annotation-mark.test.ts`) and its row's wording to `packages/ui`; the two here are folded as far as they will go, one per fixture. |
 * | 2026-08-19 | 635 | A third Label test, for the geometry a browser proved and the chip then changed: the shape stops short of the image's border so the halo has somewhere to be, which moves `content`, both stretch zones and the icon's extent. Whether `icon-text-fit` still lands on the words after that is MapLibre's arithmetic over a shaped text block, so it is unreachable at Seam 1 — and it needs its own fixture, six Labels far enough apart that the widest chip cannot reach the next one's coordinate, which is why it did not fold into either test above. |
 * | 2026-08-19 | 636 | One test for the gesture that *makes* a Label, which every Label test before it seeded instead. It is the only place three things meet: the keyboard alone reaching the tool and placing at the crosshair, the coalesced write count for placing and then typing (real OPFS, and a count no fake can stand in for), and — the claim the inheritance carve-out exists for — that the Pin drawn straight after a Label is written and painted as a Pin. The style arithmetic behind all of it is asserted at Seam 1 (`annotation.test.ts`, `annotation-editing.svelte.test.ts`) and the toolbar's fourth button at Seam 1c; this is one browser test rather than the four the criteria could have been read as. |
 * | 2026-08-19 | 639 | Label portability needs three browser tests: opening a Project must leave its OPFS files untouched; a bundled Label must draw in a Review Workspace; and a restored Label must draw. Core asserts the bytes and the transfer paths without parsing them, but only the running applications can prove the real Project files and MapLibre rendering meet at each handoff. |
 * | 2026-08-19 | 641 | Two tests for the Reader's half of the Label, and both need a **served** site rather than a dev server: that publishing a Project changes nothing about how its Labels look is a claim only a real Published Site can falsify, since the glyphs their words are shaped from are files the publish copies, the stack is rebuilt from a Project parsed out of static HTTP, and the Inspector is compiled into a second application. One reads the drawing — the bucket, the coordinate, the chip's width per `marker-size`, and the two colours off the framebuffer, none of which exists outside a browser; the other clicks a Label and sweeps the Inspector for the author's controls, which is the absence-of-a-snippet rule holding on the app that actually ships. |
 * | 2026-08-19 | 645 | Four Label tests: the keyboard journey adds Tab-reachability with no pointer, plus the style and delete legs; the 636 row already covers reaching the tool and placing at the crosshair with Enter. The Layers test needs a browser for MapLibre visibility and for a neighbouring Map Image's opacity slider leaving Annotation paint untouched; its count rides along, already provable at Seam 1c in `packages/ui/src/annotation-list.dom.test.ts`. The other two use real OPFS to prove deletion restores the source Layer's exact bytes and position, including an untitled Label. |
 * | 2026-08-19 | 646 | One test for dragging an Annotation: onto another row to reorder it, and onto another Annotation Layer's card to move it between two GeoJSON files. happy-dom's `DragEvent` constructor drops `dataTransfer`, which is the member both decisions read — what tells an Annotation being dragged from a Layer being dragged is the format the drag carries — so a Seam 1c claim would be a fake agreeing with a fake about the one thing the fake gets wrong. The ordering arithmetic is at Seam 1 (`annotation.test.ts`), and the two-file write order, the hidden-target read and the refusal at Seam 1 too (`annotation-editing.svelte.test.ts`); the keyboard path — the Inspector's Move buttons and its Layer picker — needs no browser and is not here. |
 * | 2026-08-22 | 647 | One test for an Import that did not finish. Every decision recovery makes is asserted per durable boundary at Seam 1 (`project-import-recovery.test.ts`), including that both real backings agree, because the sweep and the reclaim are the shared adapter suite's subject. What no seam below can falsify is that the *applications* are gated on it: the Project list is an effect over `?p=` that runs the moment the layout mounts, the Map Image list and the Workspace's size are two more walks of real OPFS, and a Backup is a third — five readers of one Workspace, in a browser, none of which may see a provisional file. It is one test with three restarts in it rather than three, and the chosen-folder half folded into `editor-folder-workspace.e2e.ts`'s existing adoption sweep. |
 * | 2026-08-22 | 650 | Three tests for Remote Status. The six determinations, the table behind them, the bounded interval, the coalescing, the retained failure and the per-Workspace isolation are all exhausted at Seam 1 (`remote-status.test.ts`, `local-change-index.test.ts`, `synchronization-planner.test.ts`) with no browser. What no seam below can falsify is that the *bar* carries it: a signed-out session that polls nothing until a keyboard press, an authenticated one that checks itself on sign-in and on window focus without spending a request per focus, a persistent control that survives the route change onto a Project while `Saved locally` stays the page's one `status` region, and a pending listing that a Workspace switch cannot land on the arriving Workspace. Real IndexedDB metadata, real OPFS writes through the change index, and the real navigation bar are the three things being wired together, and there is no `WorkspaceStorage` harness at Seam 1c to reach any of them. |
 * | 2026-08-22 | 654 | Four tests for Import, the inverse of Export. The engine is exhausted at Seam 1 without a browser — fresh Map Image identities, repeated references, name and directory allocation against every namespace, the publication reset, provenance inheritance, and the atomic transaction with its quota and collision refusals are five test files there. What no seam below can falsify is that the *application* performs the operation it offers: that three actions on one screen mean three different things to real OPFS (Import writes into the Workspace that is open, Review creates a second one, New Project creates neither), that the Workspace named in the offer is the one written to and no other is created, that a Project arriving under an allocated name is reachable and ordinary afterwards, and that a refusal leaves every byte as it was. There is no `WorkspaceStorage` harness at Seam 1c to reach any of it, and "no second Workspace exists on disk" is the assertion that tells Import and Review apart at all. One test per claim that cannot fold: the successful copy, the three-way distinction with its two free exits, the two refusals, and the progress a pyramid's wait needs. |
 * | 2026-08-22 | 655 | One test for Update from GitHub, the inbound transfer. The three-way plan, the commit-pinned inventory, the SHA verification, the deletion refusal, the graph refusals, the rollback and the Baseline arithmetic are exhausted at Seam 1 against the same fake GitHub (`update-from-github.test.ts`), each refusal asserted against a complete before-and-after snapshot of the Workspace — none of it needs a browser. What no seam below can falsify is that the *application* only ever does this when asked: that a window focus and a status check apply nothing, that the one control on the bar does, and that afterwards a real OPFS Workspace holds the Remote's Project as ordinary work that opens while the author's own unpublished Project is untouched, GitHub's head has not moved, and the status beside it has been recomputed against what the Update left. The Workspace-switch leg rides along in the same workflow rather than as a second test, because it needs the same held raw-host response to reach the moment it is about. |
 * | 2026-08-22 | 656 | One test for a confirmed Remote deletion. The engine is exhausted at Seam 1 — the three-way row that makes a deletion a deletion, the Conflict row that makes it not one, the preview's grouping into Projects and Map Images, the transaction interrupted at all sixteen of its durable boundaries, and both real backings agreeing about the committed files, the recovery choice, the Project and Map Image lists and the Baseline (`update-transaction.test.ts`, `update-transaction-suite.ts`). What no seam below can falsify is the *question*: that a destructive inbound change reaches a scholar as a modal naming their Project by the name they gave it, that cancelling it writes nothing and puts focus back on the control that opened it, and that confirming it removes the Project from a real OPFS Workspace and leaves the two sides agreeing. Cancel and confirm are one test rather than two, because cancel's whole claim is that the state it leaves is the one confirm then starts from. |
 * | 2026-08-22 | 657 | One test for an Import into a bound Workspace. The evidence a bound Workspace's Remote adds to an Import is exhausted at Seam 1 against the fake repository and a real store (`project-import-own-remote.test.ts`): the current inventory taken before allocation, the refusal when GitHub cannot be listed authoritatively, the own-Remote refusal and its two remedies, and a complete Workspace, Baseline and Remote snapshot unchanged after every refusal. What no seam below can falsify is that the three halves are wired together in the application: that the hub's Import asks GitHub what this Workspace's Remote holds *before* it allocates a directory, that the arriving files register in the IndexedDB change index the navigation bar's status control reads, and that the ordinary Publish — which is told nothing about Imports — carries the imported closure while the Project only GitHub had survives it. One test rather than three: the reservation is only observable in what the publish afterwards contains, so the allocation, the status and the publish are one workflow or they are assertions about a fake. |
 * | 2026-08-22 | 658 | One test for Importing a published Project off the link that offered it. The source and its refusals are exhausted at Seam 1 against the fake repository (`project-import-source.test.ts`, `project-import-own-remote.test.ts`), and which controls the offer raises, which Workspace the Import one names and that declining calls nothing are asserted at Seam 1c against a fake store (`return-link-offer.dom.test.ts`) — neither needs a browser. What no seam below can falsify is the distinction the operation *is*: that the Project lands in the real OPFS Workspace the reader was already in, that no second Workspace was created — which is the only thing that tells Import from Review — and that the published tree's own `remote.json`, naming a repository nobody here has anything to do with, did not become this Workspace's Remote. Those are three readings of one Workspace after one workflow, so they are one test rather than three. |
 * | 2026-08-22 | 663 | Five tests for Importing the review copy back into the Workspace review began from. The metadata is exhausted at Seam 1 without a browser (`project-import-review.test.ts`, `review-workspace.test.ts`): which origins parse and which are no destination at all, that the recorded origin survives a round trip through the mark, every refusal's wording, and that the source reads the review copy's *current* bytes with the reviewer's edits in them. What no seam below can falsify is the thing this operation is made of, which is three real OPFS Workspaces and a real folder grant meeting at one press. In `editor-transfer`: the destination survives the reviewer wandering to a second Workspace and back, and the copy lands in the recorded one with a fresh Map Image identity while the author's own Alignment of the same sheet is byte-identical — and the review copy is gone only after; a recorded Workspace deleted behind the app's back refuses and leaves the review copy open, holding every byte, with no Workspace invented to receive the copy; and a mark with no origin offers no Import at all. In `editor-review-remote`, the same journey from a Published Site's link, folded into the no-promotion test it replaces, because the fence and the one route through it are the same claim. In `editor-folder-workspace`, the two the other two files cannot reach: a folder origin reopened through a real `requestPermission()` from the reviewer's own press, and that same grant declined — the case a remembered *name* cannot express and the reason a folder origin retains the handle. There is no `WorkspaceStorage` harness at Seam 1c, and "the review copy still holds every byte" is not a claim a fake store can carry. |
 * | 2026-08-23 | 664 | One test for a Remote and a chosen folder meeting. Every domain claim underneath it is already asserted over **both real backings** at Seam 1 and needs no browser: the shared adapter suite for the bytes, and `describeUpdateTransaction` — run from `opfs-project-store.browser.test.ts` and `file-system-access-project-store.browser.test.ts` — for the transaction, its sixteen durable boundaries, the interrupted-recovery choice and the resulting Baseline. What no seam below can falsify is that the *applications* branch on neither member of `WorkspaceBacking`: that a Workspace whose files are in a folder the user picked binds, publishes source bytes identical to what browser storage sends for the same seeded Project, earns a Baseline from that publish, reads `Update available` and `Up to date` off the same control, brings a Remote Project in through the File System Access adapter as real files, and refuses a destructive Update until it is confirmed — with the cancel leaving the folder's listing exactly as it was. It cannot fold into an existing scenario: `editor-folder-workspace` had no Remote at all, and the three files that do have one drive OPFS, so the comparison it is made of does not exist in any of them. It is one test rather than five because the publish is what earns the evidence every state after it is read from, and a real `FileSystemDirectoryHandle` is only obtainable from a user gesture that cannot be repeated cheaply per test. |
 * | 2026-08-23 | 665 | One test for the recovery notice not covering the Project screen. Whether a persistent notice and the Layer rail's pinned add pair can occupy the same corner of one viewport is a fact about layout and hit-testing between two independently positioned regions: nothing below a real browser lays either of them out, so no component seam can see the overlap, and a Seam 1c claim about the notice's own classes would assert the stylesheet back at itself. It is one press of the button the notice used to intercept, in the file that already reaches the notice — the cheapest test in this suite that can falsify it, and it rides on the journal fixture the tests around it already build. |
 * | 2026-08-25 | 666 | One test for adding and removing a Resource Mask corner as a Step of its own. Both handles wrote `alignments/<id>.json` through the plain save path, outside every Step and without discarding, which is exactly what ADR-0039's discard rule forbids — so an Undo aimed at an earlier Step wrote back an outline from before the corner existed and took it with them, and the Redo could not bring it back. The claim is about three things meeting that only meet in a browser: the overlay handles the gestures are performed on, which are laid out by the pane and have no representation below it; the Edit History the Align screen draws, which is keyed by Map Image; and the bytes on a real OPFS Workspace, because "the file the insert overwrote" is a byte-identity claim and not an equivalence one. There is no component harness for `AlignmentWorkspace` and no Seam 1 reach into the handlers — `editor-session.test.ts` drives `historyFor(…).step()` directly, so it would assert the fix back at itself. Insert, undo, redo and remove are one test rather than four because each one's starting state is the state the one before it leaves, and the cross-Step claim needs a Control Point move already standing underneath all of them. |
 * | 2026-08-27 | 667 | One test for the guided sequence that connects a Workspace to GitHub. Every step of it, every sentence it says and all three of `bindRemote`'s outcomes are asserted at Seam 1c against a reactive fake store (`connect-to-github.dom.test.ts`, 23 tests), and what the listing read and the bind do with what they are given at Seam 1 against the shared fake GitHub (`github-installations.test.ts`, `bind-remote.test.ts`). All of that stays green if the application never wires the component up, which is the one failure no seam below can see: the bar's control, a sign-in that replaces the document and has to come back *inside* the sequence, a list that is GitHub's own answer to a credential the redirect issued, and a press that reaches the real bind and then the real Publish. It is one test rather than five because each leg's starting state is the state the leg before it leaves. |
 * | 2026-08-27 | 668 | One test for the door a deployment with a GitHub App does *not* offer. Which fields `RemoteSettings` renders for which value of `signInWithGitHubOffered`, and that the guided sequence's first step is the paste where no App is configured, are asserted at Seam 1c against a reactive fake (`connect-to-github.dom.test.ts`); that the paste reaches GitHub with the broker never on its path is `github-sign-in.test.ts`'s at Seam 1. What no seam below can falsify is the value this deployment actually computes: `isGitHubAppConfigured(GITHUB_APP)` is read once by the real `WorkspaceStorage`, and every seam beneath Seam 2 is *given* it — so a gate wired to the wrong side of it, or to a second answer, is invisible everywhere else and shows up only as a student being asked for a token. It runs with the broker unreachable because that is both the fork's case and the state this deployment ships in, which makes the second half a real claim rather than a convenience: the paste is not deleted, it is one press behind a disclosure that closes itself again, and it still binds with no service of any kind involved. |
 * | 2026-08-27 | 668 | The same number, written down so that nothing is standing under this ceiling without a reason. The two raises above bought one net test rather than two: a Seam 2 test came out as well — `editor-remote-binding.e2e.ts`' *offers a link to create the repository, with the name prefilled* — when that deep link moved inside the guided sequence, so the suite gained the sequence's test and lost that one. Nothing shrank; the arithmetic was bookkeeping. The slack that left is what the publish dialog's own door then spent: *a bound Workspace pressed to Publish with no credential offers the GitHub sign-in and no token field*, in `editor-github-signin.e2e.ts`, which arrived under the 668 above with no row of its own, and this is its row. The count equals the ceiling again with nothing to spare, so the next Seam 2 test anywhere in this repository needs a raise and a reason of its own. |
 * | 2026-08-28 | 672 | Five tests for a sign-in kept past the tab (ADR-0041). The durable store, the preference that selects it, and the stripping that keeps the access token out of what is kept are asserted without a browser where they can be and against a **real IndexedDB** where they cannot (`credential-store-suite.ts` run from `credential-store.test.ts` and `durable-credential-store.browser.test.ts`) — including that nothing of either token reaches `localStorage`. What no seam below can falsify is what a tab close actually leaves behind, because a tab close is a browser event and `sessionStorage` is the storage it empties: that the default is unchanged and leaves nothing; that a ticked one leaves the refresh token in exactly one place, leaves the eight-hour token in none, and comes back signed in off the broker's refresh with no second trip to GitHub's authorise screen; that unticking, signing out and a refresh that will no longer renew each end it; that a Backup's archive bytes and a Publish's received files carry no part of it, which needs the real export and the real publish rather than a claim about either; and that the review seal still holds with the durable implementation underneath, which is where it would stop holding unnoticed. The three endings are one test because each starts from the state the last one leaves, and the Backup and the Publish are one because they read the same held sign-in two ways. |
 * | 2026-08-28 | 673 | One test for hydration as a landing of the door. That choosing a repository carrying Projects this Workspace has not got renders the offer, hands the Open the repository and nothing else, announces per-file progress, and is not a dead end either way is asserted at Seam 1c against a reactive fake store (`connect-to-github.dom.test.ts`, ten tests); the transfer and its refusals, the installation-local uniqueness lookup and the Baseline at Seam 1 (`clone-from-remote.test.ts`, `open-workspace-from-github.test.ts`), and the subset refusal itself in `bind-remote.test.ts`. What no seam below can falsify is three real stores meeting at one press: that the Workspace the author is standing in — which has work of its own, because the offer may not wait on an empty one — is **byte for byte** what it was after an operation that only adds; that the second Workspace is a real OPFS directory beside it; that the installation's own IndexedDB record makes a second Open of the same repository a way back rather than a second Publish button aimed at one site; and that nothing on the path carries the credential the author is necessarily signed in with, which is the one property no test that signs in first would otherwise see. It is one test rather than four because each leg starts from the state the leg before it leaves. |
 * | 2026-08-31 | 674 | One test for `Publish anyway` on a Remote that is not the author's alone (ADR-0043). Whether a Remote is shared, and the sentence naming what a confirmed replace would take off it — Projects and Map Images named rather than a file count — are asserted at Seam 1 against the shared fake GitHub (`shared-remote.test.ts`, 17 tests), and the pull-only relationship, the withdrawn publish affordance and the stated merge limit at Seam 1c against the reactive fake store (`connect-to-github.dom.test.ts`, eight tests). What no seam below can falsify is the publish dialog itself: there is no `PublishDialog` harness at Seam 1c — its input is a real `EditorSession` over a real store — so "the real forecast's `removed` becomes the named preview", "the confirm button still refuses while the question stands", and "answering it deletes the Project on the Remote and leaves the repository's own `README.md`" have no home but a browser. It is one test rather than three because each leg starts from the state the leg before it leaves, and it publishes to a repository the signed-in account does not own, which is story 68 end to end at the same time. |
 * | 2026-08-31 | 676 | Two tests for the Workspace roster (ADR-0042), and one retired. What comes out is *a Project page says the folder is not open yet* — the behaviour this Epic deletes, because `awaitingFolder` was true for any folder this installation merely remembered and the two route guards drew its notice **instead of** the screen, so one Workspace's state made every Project in every Workspace unopenable. Its replacement asserts the opposite and is not a raise. The two that are: *lists both kinds in one list, each opened and renamed from its own row*, which needs a real granted `FileSystemDirectoryHandle`, the installation's own IndexedDB record giving that folder an identity, and a real OPFS Workspace listed beside it — there is no `WorkspaceStorage` harness below Seam 2, and a roster asserted against a fake store is a list agreeing with the fake that produced it; and *names no kind anywhere in the switcher*, which turns on `showDirectoryPicker` being absent from a real `window` before the app's own scripts run, and is a claim about what a whole menu does **not** say rather than about any component's props. Each is one test rather than three because every leg starts from the state the leg before it leaves. |
 * | 2026-08-31 | 665 | One test for what the browser has promised about keeping the work (ADR-0042). The six-way derivation is exhausted at Seam 1 over injected capability answers (`storage-durability.test.ts`) and every sentence, disclosure and control is asserted at Seam 1c against the reactive fake (`keeping-your-work.dom.test.ts`, thirty-four tests), so what is left needs a real browser and nothing less: that a real `navigator.storage.persisted()` and a real `permissions.query({ name: 'persistent-storage' })` reach the screen as a line at all — including on the engine where the second one *rejects*, which is the state's whole signal and cannot be faked into existence by a run — and that the disclosure and the backup beside it survive real hydration. It cannot fold into `editor-named-workspaces`' Workspace Home test: that one asserts the line is present, and this one presses the browser for the grant and reads what it then says. |
 * | 2026-08-31 | 664 | Deleting the Workspace settings and Remote repository dialogs (ADR-0042) retires twelve Seam 2 tests and adds two, so the ceiling comes **down** twelve. What comes out: two that drove the settings dialog as a dialog — that it was a real `<dialog>` with focus restoration, and that the folder choice was reachable from it *and nowhere else*, which is the opposite of the arrangement this Epic ships; one about the single pre-plural folder slot being let go by *Use browser storage instead*, a control that no longer exists because switching to a browser Workspace is pressing its row; and nine that could only be driven through a token field or an address field, both of which are absent on a deployment with an App — the pasted credential's four (a paste of the wrong shape, a paste GitHub refuses, where a paste is kept, and a paste supplied again for a bound Workspace), the escape hatch's own test and the fork-shaped paste beside it, a typed whole-address bind and a typed repository that does not exist, and binding-with-a-notice on a repository that cannot be published to. Every one of those claims is asserted at Seam 1 (`credential-store.test.ts`, `bind-remote.test.ts`, `github-sign-in.test.ts`) or at Seam 1c against the reactive fake (`connect-to-github.dom.test.ts`, `repository-choice.dom.test.ts`), except the escape hatch itself: **ticket 17 owns re-establishing that surface and the Seam 2 test of the real `isGitHubAppConfigured` gate that goes with it**, and it will need a raise of its own. What goes in: *moves this Workspace into a folder, preserving every file and keeping the original*, which is the only route existing work has onto disk and needs a real granted `FileSystemDirectoryHandle` and a real OPFS Workspace to compare byte for byte; and the refusal beside it, a folder that already holds files, which is what keeps a move from being a merge. Workspace Home's re-homed sections moved *down* a seam rather than out: `keeping-your-work.dom.test.ts` is twenty-two tests at Seam 1c where sixteen browser boots used to be.
 *
 * Lowered as claims move down a seam. **Raising it needs a row above and a reason in it.**
 */
export const SEAM_2_CEILING = 665;

/**
 * Whether a suite of this size is over the ceiling, and the sentence saying so.
 *
 * A pure function of two numbers so the decision can be read, and tested, without a Playwright
 * process around it.
 */
export const sizeVerdict = ({ count, ceiling }) => {
	const overage = count - ceiling;
	return {
		overage,
		overCeiling: overage > 0,
		summary: `${count} Seam 2 tests against a ceiling of ${ceiling}`
	};
};

/**
 * The test count in `playwright test --list` output.
 *
 * Read from the `Total: N tests in M files` line rather than by counting printed lines, because the
 * listing carries a reporter summary underneath it and a line count would quietly include it. A
 * listing whose shape changed returns `null` rather than a number that happens to parse: this fence
 * dying silent is the failure mode worth spending a branch on.
 */
export const countInListing = (output) => {
	const match = /^Total:\s+(\d+)\s+tests?\s+in\s+\d+\s+files?$/m.exec(output);
	return match ? Number(match[1]) : null;
};

const CEILING_ENVIRONMENT_VARIABLE = 'BALLASTELLA_SEAM_2_CEILING';

const ceilingFromEnvironment = (environment) => {
	const raw = environment[CEILING_ENVIRONMENT_VARIABLE];
	if (raw === undefined || raw === '') return SEAM_2_CEILING;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		console.error(
			`\n${CEILING_ENVIRONMENT_VARIABLE} must be a whole number of tests, got ${JSON.stringify(raw)}.\n`
		);
		process.exit(1);
	}
	return parsed;
};

// ── Positive control ──────────────────────────────────────────────────────────────────────────
//
// A fence nobody has watched fail is a fence nobody should trust, and this one's way of dying is
// silent: if `sizeVerdict` ever stopped saying yes, a growing suite and a shrinking one would print
// the same success line. The end-to-end half of the control is the environment variable above.

const runControls = () => {
	const controlFailures = [];
	if (!sizeVerdict({ count: SEAM_2_CEILING + 1, ceiling: SEAM_2_CEILING }).overCeiling) {
		controlFailures.push('one test over the ceiling is no longer refused');
	}
	if (sizeVerdict({ count: SEAM_2_CEILING, ceiling: SEAM_2_CEILING }).overCeiling) {
		controlFailures.push('a suite exactly at the ceiling is now refused');
	}
	if (countInListing('Total: 669 tests in 35 files') !== 669) {
		controlFailures.push('the listing’s total is no longer being read');
	}
	if (controlFailures.length > 0) {
		console.error('\nThis check can no longer detect what it exists to detect.\n');
		for (const failure of controlFailures) console.error(`  ${failure}`);
		console.error('');
		process.exit(1);
	}
};

// ── The count ─────────────────────────────────────────────────────────────────────────────────

const main = () => {
	runControls();

	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const ceiling = ceilingFromEnvironment(process.env);

	let listing;
	try {
		// `--list` resolves and prints the suite without running anything, so no web server starts and no
		// app is built. Keep it that way: a `pnpm lint` that builds the editor is a `pnpm lint` nobody runs.
		//
		// ⚠ `--reporter` is pinned here, and `playwright.config.ts`'s warning against passing it does not
		// apply: that warning is about losing the retry budget on a *run*, and `--list` runs nothing and
		// retries nothing. It has to be pinned because this inherits `process.env`, and under `CI` the
		// config selects `github` + `html` instead of `list` — which prints no `Total:` line for the
		// parser below (so `pnpm lint` failed outright on CI) and writes a `playwright-report/`
		// describing a run that never happened, for a later e2e step to find.
		listing = execFileSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=list'], {
			cwd: repoRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		});
	} catch (error) {
		console.error(
			'\ncheck-seam-2-size: `playwright test --list` failed, so the suite was not counted.\n'
		);
		console.error(error.stdout ?? '');
		console.error(error.stderr ?? '');
		process.exit(1);
	}

	const count = countInListing(listing);
	if (count === null) {
		console.error(
			'\ncheck-seam-2-size: `playwright test --list` printed no `Total: N tests in M files` line,\n' +
				'so the count could not be read. This check is not guarding anything until that is fixed.\n'
		);
		process.exit(1);
	}

	const verdict = sizeVerdict({ count, ceiling });
	if (!verdict.overCeiling) {
		console.log(`check-seam-2-size: ${verdict.summary} (${ceiling - count} to spare).`);
		process.exit(0);
	}

	console.error(`\ncheck-seam-2-size: ${verdict.summary} — ${verdict.overage} over.\n`);
	console.error(
		'Seam 2 costs roughly four worker-seconds per test at its cheapest and ten at its dearest, and it\n' +
			'grew to thirteen minutes by adding a few tests at a time with nothing watching the total.\n\n' +
			'Put the claim at the highest seam at which it can still fail for the right reason: Seam 1 for\n' +
			'application logic, Seam 1c for what a component renders, announces and focuses, Seam 2 for the\n' +
			'application with real MapLibre, real OPFS, a real service worker and a real static server\n' +
			'underneath it. If it belongs here, move another claim down or raise the ceiling in\n' +
			`scripts/check-seam-2-size.mjs with a row saying why.\n`
	);
	process.exit(1);
};

// Importing this module must not spend a second listing the suite, which is what lets the two pure
// functions above be tested at all.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

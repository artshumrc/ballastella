# Import Projects and Synchronize Workspaces

## Problem Statement

Ballastella can export one Project as a Project Bundle, but a recipient can only open that bundle in a throwaway Review Workspace. A Project on a Published Site has the same limitation: the site can send a Reader to a review copy, but cannot add that Project to the Reader's current Workspace as editable work. The Projects screen therefore offers Review and New Project without the inverse of Export that users reasonably expect.

The existing GitHub flow also treats opening and publishing as isolated transfers rather than a continuing Workspace relationship. A second machine can open a Remote into another Workspace, but Ballastella does not establish the synchronization evidence needed to distinguish local changes, Remote changes, and Conflicts afterwards. Authors cannot see that GitHub changed out of band, bring those changes safely into an existing Workspace, or tell Remote drift apart from the fact that their latest edit is saved locally.

These are two different needs. Import must copy one Project into the current Workspace without retaining a relationship to its source. Synchronization must remain a relationship between one whole Workspace and its one Remote. Treating either as the other creates misleading ownership, ambiguous Map Image Alignments, or multiple Remotes inside one Workspace.

## Solution

Add **Import a Project** as a first-class action alongside **Review a Project** and **New Project**. Import accepts a Project Bundle, a Project from a Published Site, or the current state of a Project in a Review Workspace. It atomically copies the complete Project closure into the current ordinary Workspace, assigns every incoming Map Image a fresh identity, preserves its Alignment, remaps references, disambiguates names, records Import Provenance, clears the source publication address, and leaves the imported Project off the Front Page. The result is ordinary editable work with no Project-level Remote relationship.

A Published Project's **Open in Ballastella** link offers either **Import into “Workspace name”** or **Open a review copy**. Importing from Review copies the reviewed state into the ordinary Workspace from which review began, switches to the imported Project, and discards the Review Workspace only after the copy succeeds.

Turn the existing Workspace-level GitHub opening flow into **Open a Workspace from GitHub**. One Ballastella installation keeps at most one synchronized local Workspace for a repository; opening it again returns to that Workspace. Establish a local-only Synchronization Baseline at successful Open, Update, Publish, or Publish anyway. A persistent **Remote Status**, separate from **Saved locally**, compares the current Workspace and Remote against that Baseline and reports **Up to date**, **Changes to publish**, **Update available**, **Changes on both sides**, **Conflict**, or **Cannot tell** when no trustworthy Baseline exists.

Keep the two transfer directions explicit. **Update from GitHub** atomically applies Remote-only additions, changes, and confirmed deletions while preserving local-only changes. **Publish** remains the only action that makes local work public and requires Remote changes to be incorporated first. A path changed differently on both sides, or a prospective combination that violates a Workspace invariant, is a Conflict and changes neither side. No content merger or new per-file conflict-resolution interface is introduced; the existing **Publish anyway** remains the deliberate local-wins escape hatch.

## User Stories

1. As an author, I want Import a Project, Review a Project, and New Project presented as distinct actions, so that I understand whether I am copying, examining, or creating work.
2. As an author, I want Import a Project available from the Workspace Home, so that I can add outside work to the Workspace already open.
3. As an author, I want to choose a Project Bundle as an Import source, so that I can keep a Project someone sent me.
4. As an author, I want to choose a published GitHub Project as an Import source, so that I can keep public scholarly work without downloading and re-uploading it manually.
5. As a reader, I want to import a public GitHub Project without authenticating, so that receiving public work does not require a GitHub account.
6. As an unauthenticated author, I want Import and Review to avoid prompting for GitHub credentials, so that identity is requested only for an operation that needs it.
7. As an author, I want an Import offer to name its destination Workspace, so that I know where the Project will be added.
8. As an author, I want Import to add work without creating or switching to another ordinary Workspace, so that Import means adding a Project to my current Workspace.
9. As an author, I want an imported Project to become ordinary editable work, so that I can continue developing it with the normal authoring tools.
10. As an author, I want an imported Project detached from its source, so that later changes never travel automatically in either direction.
11. As an author, I want the interface to distinguish Import from Review, Update from GitHub, Restore, and Open a Workspace from GitHub, so that each operation has one predictable meaning.
12. As an author, I want New Project kept separate from Import, so that copied work is not mistaken for newly created work.
13. As an author, I want progress while a large Project is imported, so that copying a Map Image pyramid is not a silent wait.
14. As an author, I want canceling before Import begins to leave my Workspace unchanged, so that inspecting the offer is harmless.
15. As an author, I want malformed or incomplete Import sources refused before installation, so that invalid work is not added to my Workspace.
16. As an author, I want a Project format newer than the application understands refused plainly, so that an older Ballastella does not damage unfamiliar work.
17. As an author using browser storage, I want available storage checked for one incoming Project closure plus transaction metadata before a large Import begins, so that quota exhaustion is reported without requiring space for a second pyramid copy.
18. As an author, I want Import to commit atomically, so that either the complete Project is added or none of it is.
19. As an author, I want a failed or interrupted Import recovered before my Workspace opens, so that no provisional Project, Map Image, Alignment, or Annotation appears in the Workspace or its Map Image list.
20. As an author, I want Import to leave the source Project and source Workspace untouched, so that receiving work never modifies its origin.
21. As an author, I want Import to copy the Project file, so that the Layer stack and Project settings are preserved.
22. As an author, I want Import to copy every referenced Annotation, so that the imported scholarly content is complete.
23. As an author, I want Import to copy every referenced Map Image, so that every imported map Layer can render.
24. As an author, I want Import to copy every referenced Alignment, so that each Map Image retains its incoming placement on the earth.
25. As an author, I want Import limited to the selected Project and its referenced closure, so that unrelated Projects and unused assets are not copied.
26. As an author, I want generated Published Site files excluded from Project Import, so that a Project does not carry stale viewer output into my Workspace.
27. As an author, I want every incoming Map Image assigned a fresh identity, so that an imported Alignment cannot alter an existing Map Image.
28. As an author, I want a fresh identity even when the incoming Map Image appears identical to one I already have, so that Import never creates hidden sharing.
29. As an author, I want repeated references to one incoming Map Image mapped to one fresh identity, so that Layers within the imported Project continue sharing that Map Image.
30. As an author, I want distinct incoming Map Images kept distinct, so that Import does not collapse separate scholarly objects.
31. As an author, I want every imported map Layer rewritten to its fresh Map Image identity, so that no Layer points back to the source Workspace.
32. As an author, I want a stored pyramid's stamped source publication identifier reset to Ballastella's local placeholder for its fresh identity, so that the imported copy neither claims the source Published Site nor breaks local tile resolution.
33. As an author, I want each imported Alignment stored under its fresh Map Image identity, so that one Alignment still belongs to one Map Image.
34. As an author, I want a local Alignment resource identifier rewritten through the Alignment model, so that its content and its stored Map Image agree.
35. As an author, I want an imported Alignment's Control Points, Resource Mask, and transformation type preserved, so that Import does not change the scholarly interpretation.
36. As an author, I want a genuine Library IIIF service, rights, attribution, Manifest, and Canvas metadata preserved separately from a stored pyramid's publication stamp, so that an imported referenced or Offline Copy remains citable without retaining the source Workspace's IIIF identity.
37. As an author, I want Layer, Annotation, and unknown forward-compatible Project fields preserved, so that Import does not discard supported source content.
38. As an author, I want the prospective imported closure validated as a graph, so that every committed reference resolves.
39. As an author, I want an Import with a missing Map Image, Alignment, or Annotation refused, so that no dangling Layer is installed.
40. As an author, I want imported Project names to respect reserved Workspace names, so that a Project cannot occupy `images`, `alignments`, or `base-map`.
41. As an author, I want a display-name collision resolved with the suffix “(imported)”, so that both Projects remain visibly distinguishable.
42. As an author, I want further collisions resolved as “Name (imported 2)” and later available variants, so that repeated detached copies can coexist.
43. As an author, I want the imported Project assigned a collision-free directory independently of its display name, so that existing files are never overwritten.
44. As an author, I want Import never to overwrite an existing Project, so that outside work cannot destroy my work.
45. As an author, I want Import never to overwrite an existing Map Image, so that Map Images already used by my Projects remain unchanged.
46. As an author, I want Import never to overwrite an existing Alignment, so that somebody else's interpretation cannot move my maps.
47. As an author, I want Import never to overwrite an existing Annotation, so that my scholarly content remains intact.
48. As an author, I want Import reported successful only after the complete closure is durable, so that success never describes a partial Project.
49. As an author in a bound Workspace, I want Import to register as local work to publish, so that Remote Status reflects the new Project.
50. As an author, I want a later Workspace Publish to include the imported Project, so that I can publish it deliberately as part of my Workspace.
51. As an author, I want an imported Project to have no Remote relationship of its own, so that synchronization remains a Workspace concern.
52. As an author, I want an imported Project initially kept off the Front Page, so that copying work does not feature it automatically.
53. As an author, I want the source Project's Front Page choice ignored, so that another publisher's editorial choice does not become mine.
54. As an author, I want Front Page absence still described as public after Publish, so that I do not mistake it for access control.
55. As an author, I want the source publication address removed from the imported Project's publication identity, so that the copy does not claim the source address as its own.
56. As an author, I want the source publication address retained in Import Provenance, so that the historical route remains inspectable.
57. As an author, I want Import Provenance visible with the imported Project, so that I can see how the copy reached my Workspace.
58. As an author, I want Import Provenance read-only, so that observed transfer history is not presented as ordinary editable metadata.
59. As an author, I want a GitHub provenance entry to record the observed repository, Project address, and commit, so that the copied state is identifiable.
60. As an author, I want a Project Bundle provenance entry to record the observed filename and embedded Project name, so that the handoff artifact is identifiable.
61. As an author, I want provenance limited to facts Ballastella observed, so that it never turns a filename or account into an unsupported claim.
62. As a scholar, I want Import Provenance to avoid authorship claims, so that transfer history is not mistaken for scholarly attribution.
63. As an author, I want inherited provenance preserved when a Project is transferred again, so that earlier handoffs are not erased.
64. As an author, I want inherited provenance identified as inherited rather than independently verified, so that its evidentiary status is honest.
65. As an author, I want each transfer to append provenance instead of replacing it, so that the Project retains a transfer history.
66. As an author, I want ordinary edits to preserve Import Provenance, so that developing the Project does not erase its history.
67. As an author, I want exporting and re-importing a Project to preserve and extend provenance, so that a chain of handoffs remains visible.
68. As an author, I want repeated imports of the same source to create distinct Projects and Map Images, so that detached copies never acquire hidden coupling.
69. As an author, I want Import from my current Workspace's own Remote refused, so that I do not duplicate synchronized work.
70. As an author, I want an own-Remote Import attempt to direct me to the existing Project or Update from GitHub, so that I use the appropriate synchronized copy.
71. As an author, I want an own-Remote refusal to leave my Workspace unchanged, so that an accidental choice has no side effects.
72. As a reader, I want one Open in Ballastella link on a Published Project, so that the navbar does not present competing editor links.
73. As a reader, I want following Open in Ballastella to show an offer before downloading, so that a URL cannot rearrange my editor automatically.
74. As a reader, I want the offer to provide Import into my named current Workspace, so that I can keep the Project deliberately.
75. As a reader, I want the offer to provide Open in a review copy, so that I can inspect the Project without adding it.
76. As a reader, I want declining the offer to download nothing and change nothing, so that following a link remains safe.
77. As a reader, I want a Workspace-level Published Site link to offer Open a Workspace from GitHub, so that whole-Workspace synchronization is distinct from Project Import.
78. As a reader of an older Published Site, I want its existing editor return links still understood, so that already-published work does not lose its route back to Ballastella.
79. As a publisher, I want Publish to generate the repository address required by new return links, so that copied repository content cannot choose my local Remote.
80. As an author, I want opening published content never to import its embedded Remote binding, so that a copied or forked repository cannot silently rebind my Workspace.
81. As a reviewer, I want a Review Workspace to remain isolated from my ordinary Workspace, so that examining work cannot change mine.
82. As a reviewer, I want the persistent Review banner to remain visible, so that I cannot forget I am in throwaway storage.
83. As a reviewer, I want Import into my Workspace available from the Review banner, so that I can keep the state I have examined.
84. As a reviewer, I want that action to state that it imports the current reviewed state, so that edits made during review are not mistaken for the original source.
85. As a reviewer, I want that action to state that the Review Workspace will be discarded after success, so that its lifecycle is clear.
86. As a reviewer, I want a successful review Import to return to the specific ordinary Workspace recorded when review began, so that a later Workspace switch cannot redirect the copy.
87. As a reviewer, I want a successful review Import to open or identify the imported Project, so that I can find the copy immediately.
88. As a reviewer, I want the Review Workspace discarded only after Import commits, so that a failed copy cannot destroy the reviewed state.
89. As a reviewer, I want a failed or canceled review Import to leave the Review Workspace available, so that I can retry or leave normally.
90. As a reviewer, I want review Import to use fresh Map Image identities and append provenance, so that it follows the same detached-copy rules as every Import.
91. As a reviewer, I want Review Workspaces to remain unpublishable and unbindable, so that Import is the only deliberate route into owned work.
92. As a keyboard user, I want every Import, Review, and New Project action operable without a pointer, so that all entry paths are available to me.
93. As a screen-reader user, I want Import progress and outcomes announced politely, so that a long transfer is not silent.
94. As a screen-reader user, I want Import refusals announced as errors and expressed in domain language, so that failures are perceivable and understandable.
95. As a keyboard user, I want focus restored or moved to the imported result after dialogs and Workspace switches, so that Import does not strand focus on the document body.
96. As an author, I want the Workspace-level action called Open a Workspace from GitHub rather than Clone, so that Ballastella does not promise Git behavior.
97. As a signed-out author, I want to open a public Workspace from GitHub without authenticating, so that public work remains readable.
98. As an author, I want Open a Workspace from GitHub to create a named local Workspace when none is bound to that repository, so that unrelated local work is untouched.
99. As an author, I want Open to establish a Synchronization Baseline only after the complete Workspace is valid, so that later drift has trustworthy evidence.
100. As an author, I want opening the same repository again to return to its existing local Workspace, so that one installation does not create competing synchronized copies.
101. As an author, I want one Ballastella installation to keep at most one synchronized Workspace for a repository, so that local duplicates cannot unknowingly publish over each other.
102. As an author using another machine, I want that installation to hold its own synchronized Workspace and Baseline, so that the same Remote can support deliberate cross-machine work.
103. As an author, I want an invalid or incomplete Remote refused before a local Workspace is adopted, so that Open cannot present a partial copy as usable.
104. As an author, I want an interrupted Open to preserve existing Workspaces and resume safely where supported, so that a large transfer does not damage local work.
105. As an author without write permission, I want an opened public Workspace to receive Updates, so that inbound synchronization is not confused with publishing authority.
106. As an author without write permission, I want Publish refused before upload begins, so that I do not wait for a transfer that cannot complete.
107. As an author, I want a Workspace to have at most one Remote, so that synchronization always has one unambiguous counterpart.
108. As an author, I want the Remote relationship stored as local-only state, so that it never arrives through a Published Site, Backup, or Project Bundle.
109. As an author opening a copied or forked repository, I want the repository I selected to determine the Remote, so that stale published metadata cannot redirect me.
110. As an author, I want the Synchronization Baseline stored as local-only per-path evidence, so that another installation cannot inherit my synchronization history.
111. As an author, I want Remote Status shown separately from Saved locally, so that local durability is not mistaken for GitHub agreement.
112. As an author, I want Remote Status persistently available in the navigation bar, so that drift remains visible while I edit a Project.
113. As an author, I want Remote Status expressed as Up to date, Changes to publish, Update available, Changes on both sides, Conflict, or Cannot tell, so that missing synchronization evidence is never presented as safety.
114. As an authenticated author, I want Remote Status checked automatically with bounded frequency without rereading and hashing every local file, so that I learn about out-of-band GitHub changes without repeatedly scanning a multi-gigabyte Workspace.
115. As a signed-out author, I want to check a public Remote explicitly, so that status remains available without automatic unauthenticated polling.
116. As an author, I want a status check to transfer no files, so that observation cannot change either side.
117. As an author, I want a status check never to advance the Synchronization Baseline, so that checking cannot hide drift.
118. As an author, I want a failed check distinguished from Up to date while preserving the last successful status, so that network failure is not reported as agreement.
119. As an author, I want synchronization status computed across authored Workspace files and Offline Copies, so that Projects, Map Images, Alignments, Annotations, and offline Base Map data remain one Workspace state.
120. As an author, I want generated-viewer differences described separately as a Published Site needing republishing, so that Publish-owned output is not mistaken for changed scholarship or an inbound Update.
121. As an author, I want Update from GitHub to remain an explicit inbound action, so that Remote work never changes my Workspace silently.
122. As an author, I want Update from GitHub never to Publish local work, so that receiving changes cannot make my edits public.
123. As an author, I want Update to bring Remote-only additions into my Workspace, so that newly published Projects and assets become available locally.
124. As an author, I want Update to replace locally unchanged files with Remote changes, so that another machine's published work can become current locally.
125. As an author, I want Update to apply Remote deletions when the corresponding local content is unchanged, so that synchronized deletions do not reappear.
126. As an author, I want destructive inbound changes previewed and confirmed, so that I know which Projects and Map Images will be removed.
127. As an author, I want canceling a deletion preview to leave Workspace, Remote, and Baseline unchanged, so that inspection is harmless.
128. As an author, I want Update to preserve local-only changes on other paths, so that receiving Remote work does not discard unpublished work.
129. As an author, I want Update to combine non-conflicting Remote changes with local changes on different paths, so that two machines can work on separate files without a content merger.
130. As an author, I want successful Update to advance the Baseline only for state made shared, so that remaining local work still appears as Changes to publish.
131. As an author, I want Remote Status recomputed after Update, so that the next required action is immediately clear.
132. As an author, I want Publish to remain the only explicit outbound action, so that saved work never becomes public automatically.
133. As an author, I want ordinary Publish to require Remote changes to be incorporated first, so that the Remote becomes the complete current Workspace rather than a state absent locally.
134. As an author, I want successful Publish and Publish anyway to store their result as the Baseline when local evidence can be retained, and report Cannot tell when it cannot, so that a successful publication never implies evidence the browser failed to keep.
135. As an author, I want a path changed differently both locally and remotely reported as Conflict, so that neither version wins silently.
136. As an author, I want a combination of individually separate changes reported as Conflict when it would violate a Workspace invariant, so that file-level safety cannot create a broken graph.
137. As an author, I want Conflict to stop Update or ordinary Publish without changing Workspace, Remote, or Baseline, so that refusal is safe.
138. As an author, I want no content merger or per-file conflict-resolution editor, so that Ballastella does not invent reconciled scholarship.
139. As an author, I want the existing Publish anyway action retained as an explicit local-wins escape hatch, so that intentional replacement remains possible.
140. As an author, I want malformed, unsupported, or unreadable Remote content reported as an operation failure rather than Up to date or Conflict, so that invalid content is described honestly.
141. As an author, I want Update committed atomically, so that either the complete valid inbound change set is visible or the old Workspace remains.
142. As an author, I want failed Open, Update, Publish, and Publish anyway operations to leave the Baseline unchanged, so that unsuccessful work never becomes synchronization evidence.
143. As an author, I want Project directories recognized from the local Workspace, current Remote inventory, and Baseline, so that Import allocation, additions, and deletions cannot manufacture a collision with unseen Remote work.
144. As a repository owner, I want Publish to continue preserving README, LICENSE, CNAME, workflows, and other files outside Ballastella's namespace, so that synchronization does not take ownership of my repository.
145. As an author, I want Offline Copies synchronized with authored data while generated Published Site files remain Publish-owned output, so that another editor version cannot create perpetual inbound viewer churn.
146. As a publisher, I want repository return-link metadata generated during Publish rather than synchronized as a local binding, so that the Published Site can point back without controlling my Workspace.
147. As a screen-reader user, I want Remote Status, progress, success, and failure conveyed as text and with appropriate live semantics, so that synchronization is not communicated by color or icons alone.
148. As a keyboard user, I want Open, Update, Publish, and confirmation controls operable with predictable focus, so that synchronization does not require a pointer.
149. As an author transferring a large Workspace, I want per-file progress and bounded network activity, so that a long operation remains understandable and does not appear frozen.
150. As an author using browser storage or a chosen folder, I want the same Import and synchronization behavior, so that the Workspace backing does not change the domain contract.
151. As an author, I want Cannot tell reported when no valid Synchronization Baseline exists for the bound Remote, so that absence, corruption, repository mismatch, or failed Baseline storage is visible.
152. As an author, I want Publish without a Baseline to retain today's safe refusal for a non-empty Remote and offer Publish anyway, so that unknown Remote work is never overwritten silently.
153. As an author, I want Update without a Baseline to refuse when differing non-empty local and Remote work cannot be attributed, so that unknown history is not treated as a safe inbound change.
154. As an author, I want an empty side or a byte-for-byte equal deliberate Update or Publish plan to establish a Baseline safely, so that Cannot tell can be resolved without inventing history.
155. As an existing user, I want a valid v1 publish manifest migrated into the Synchronization Baseline for the same Workspace and Remote, so that prior successful Publish evidence is not discarded.
156. As an existing user, I want a bound Workspace with no valid v1 manifest to remain bound but report Cannot tell, so that migration does not fabricate a Baseline.
157. As an existing user, I want a legacy Workspace binding lifted into installation-local metadata only when corroborated or explicitly confirmed, so that copied folder content cannot bind itself silently.
158. As an author restoring a Backup, I want the restored Workspace to remain unbound, so that local-only Remote relationships do not travel through Backup and Restore.
159. As an author, I want Remote Status to derive local drift from a durable index of successful writes and deletions since the Baseline, so that automatic checks do not hash every Workspace file.
160. As an author using a chosen folder, I want deliberate Update and Publish planning to hash the complete local Workspace, so that out-of-band file edits invisible to Ballastella's write index are detected before transfer.
161. As an author, I want a bound Workspace's current Remote Project directories reserved during Import allocation, so that an imported local Project cannot collide with a Project already present only on GitHub.
162. As a reviewer, I want Review metadata to record the stable identity and backing of the ordinary Workspace review began from, so that Import has one explicit destination.
163. As a reviewer, I want Review Import refused without discarding the review when its recorded destination was deleted or cannot be reopened, so that Ballastella neither loses reviewed work nor guesses another Workspace.
164. As a maintainer, I want Review source readers to remain unable to write into an ordinary Workspace, so that only the Import engine can cross the structural boundary from outside work into owned work.
165. As a reader, I want the shipped `clone` and `review` invitation URLs retained with their new Open and Import-or-Review meanings, so that one URL builder and parser serve old and new Published Sites.
166. As an author, I want Update to ignore Publish-owned viewer output while synchronizing Offline Copies and authored files, so that different editor versions do not exchange obsolete `_app` bundles.
167. As a maintainer, I want any Seam 2 test-count increase recorded with a dated ceiling row and an argument for why the behavior cannot live lower, so that this epic does not bypass the suite-size fence.

## Implementation Decisions

- Implement one core Project Import engine shared by three source adapters: Project Bundle, Published GitHub Project, and Review Workspace. A source adapter gathers and validates the Project closure plus directly observed provenance; the shared engine owns naming, identity remapping, graph validation, and commit semantics.
- Preserve the existing structural Review fence while extracting shared reading. Project Bundle and GitHub Review readers remain read-only source capabilities whose types cannot receive an ordinary writable destination. Only the Import engine may hold both a validated Project closure and a writable ordinary Workspace. Replace every permanent no-promotion comment, module contract, test name, and user-facing sentence with the new boundary rather than leaving ADR-0024's prohibition in place.
- Import always targets an existing ordinary Workspace. Direct Import targets the Workspace currently open. Review Import targets the ordinary Workspace from which review began, switches back to it after success, opens or identifies the imported Project, and only then discards the Review Workspace.
- Define the incoming closure as `project.json`, every referenced Annotation, and each distinct referenced Map Image with its Alignment and image metadata or pyramid. Generated Published Site files, Base Map files, Workspace settings, Remote relationship, and unrelated source assets are not part of Project Import.
- Allocate a fresh Map Image identity for every distinct incoming Map Image without source or content deduplication. Maintain one old-to-new map for the duration of the Import so repeated Layers referencing one incoming Map Image continue to share one fresh Map Image.
- Rewrite Map Layers, image paths, Alignment paths, and identity-bearing references through their domain parsers and serializers. A stored local or Offline Copy pyramid whose `info.json` was stamped with the source Published Site is reset to Ballastella's local placeholder under the fresh Map Image identity and may be stamped with the destination address only by a later Publish. A genuine Library service recorded in referenced-image metadata is preserved, including for an Offline Copy, together with rights, attribution, source Manifest and Canvas evidence, Control Points, Resource Masks, transformation types, Annotation content, and unknown forward-compatible fields.
- Resolve a display-name collision with the first available `Name (imported)`, `Name (imported 2)`, and subsequent variant. Allocate the Project directory independently through the existing slug and reserved-name rules against the union of local, current Remote, and Baseline Project directories. A bound Workspace obtains a current Remote directory inventory before allocation; if it cannot, Import refuses without writing rather than manufacturing a future Conflict. Import never overwrites an existing path.
- Add optional Import Provenance to Project metadata. Its conceptual contract is:

```ts
type ImportProvenanceEntry =
	| {
			kind: 'github';
			repository: string;
			projectAddress: string;
			commit: string;
			observedAt: string;
			evidence: 'observed' | 'inherited';
	  }
	| {
			kind: 'project-bundle';
			filename: string;
			projectName: string;
			observedAt: string;
			evidence: 'observed' | 'inherited';
	  }
	| {
			kind: 'review';
			projectName: string;
			observedAt: string;
			evidence: 'observed' | 'inherited';
	  };
```

- The concrete schema may normalize repository coordinates into separate owner, repository, and branch fields, but it must not contain an author, owner-of-the-scholarship, credential, or active Remote. On each transfer, carried entries become inherited and the current transfer appends one observed entry.
- Extend Review metadata with directly observed GitHub or Project Bundle evidence and a stable locator for the ordinary Workspace and backing from which review began. Review Import uses that locator rather than the installation's single last-used Workspace slot. If the destination was deleted, its folder permission cannot be regained, or its backing cannot be opened, Import refuses and preserves the Review Workspace; it neither chooses nor creates another destination. Older Review metadata without an origin remains reviewable but cannot be imported until it has an explicit ordinary destination.
- Set imported Front Page membership to false. Clear the source publication address from the imported Project and retain that address only in Import Provenance. Import does not itself change authorship timestamps merely to claim the transfer as an edit.
- Refuse a GitHub Import when the normalized repository identity and Project directory identify the destination Workspace's own Remote. Offer the local Project when present or Update from GitHub when the Remote is newer. A Project Bundle is not treated as an own-Remote source unless its directly observed evidence can establish that fact.
- Import uses one-copy recoverable staging. Because every destination path is freshly allocated, provisional bytes are written once at their final paths under a reserved transaction marker while the Workspace is unavailable. The marker lists every provisional path; Project and Map Image enumeration cannot run until commit or recovery removes it, and `project.json` remains the final domain file written. Failure keeps the Workspace unavailable until all listed paths are removed. Startup recovery sweeps an uncommitted transaction before exposing the Workspace and completes a committed one. The quota check covers one incoming closure plus bounded transaction metadata, not a second pyramid copy.
- Update is likewise observationally atomic for every supported Workspace backing, but may require recoverable before-images for paths it replaces or deletes. Its preflight includes that temporary storage. Failure or interruption exposes either the old Workspace and Baseline or the complete new state, never a mixture.
- Keep the shipped invitation URL shapes. `?clone=owner/repository` now means Open a Workspace from GitHub, while `?review=owner/repository&p=directory` becomes a Project invitation whose editor offer provides Import or Review. The shared builder, parser, and cleanup path retain those parameters; only their user-facing vocabulary and Project offer change.
- Replace user-facing Clone with Open a Workspace from GitHub. Normalize GitHub repository identity and maintain an installation-local reverse lookup so reopening a repository selects its existing synchronized Workspace rather than creating another. The uniqueness rule applies within one Ballastella installation, not across devices.
- Open reads a public Remote without authentication, creates a new browser-backed Workspace only when no local binding exists, validates it before adoption, and establishes the complete initial Synchronization Baseline only after success. Preserve the existing resumable download behavior and truncated-tree refusal.
- Keep the Remote relationship, Synchronization Baseline, and local-change index in durable installation-local metadata keyed by stable Workspace identity and backing, in storage sized for tens of thousands of paths rather than origin-wide `localStorage`. None belongs to Workspace content, a Backup, a Project Bundle, a Review Workspace, or synchronized repository files.
- On first open after this feature ships, migrate a valid v1 publish manifest into the Baseline only when its Workspace, repository, and branch match. A matching legacy binding plus matching manifest is sufficient to lift the relationship automatically. A legacy binding without corroborating installation-local evidence requires explicit confirmation; confirmation preserves the binding but leaves the Baseline absent and Remote Status at Cannot tell. A restored Backup remains unbound. Once migration succeeds, remove the binding role from Workspace `remote.json`; do not infer it when opening copied or forked repository content.
- Evolve the existing publish manifest into a versioned Synchronization Baseline containing repository identity, branch, commit evidence, and `path -> blob SHA` for the last state shared at each source path. Open establishes it; Update advances successfully incorporated inbound state; Publish and Publish anyway attempt to record successfully published state. If durable Baseline storage fails after Remote publication succeeds, report that Publish succeeded but status is now Cannot tell; never report the Publish as failed and never retain stale evidence.
- Cannot tell is the Remote Status when no valid Baseline exists because evidence is absent, unreadable, for another Remote, or could not be stored. A check may inventory both sides but cannot classify historical drift. A deliberate Update or Publish planning pass may establish a Baseline when both source namespaces are byte-for-byte equal or one side is empty. With differing non-empty sides, Update and ordinary Publish refuse; Publish retains the existing confirmed Publish anyway remedy.
- Define per-path status against Baseline `B`, local `L`, and Remote `R`:

```text
no valid B                 Cannot tell
L = B and R = B          Up to date
L != B and R = B         Changes to publish
L = B and R != B         Update available
L != B and R != B
  and L = R              shared bytes; operation may advance the Baseline
L != B and R != B
  and L != R             Conflict
safe changes on both
  sides at other paths   Changes on both sides
```

- Compute over the union of local, current Remote, and Baseline-owned source paths. A Project directory is owned when recognized by a local, Remote, or Baseline `project.json`; its whole directory remains in scope until synchronization establishes complete deletion. Import directory allocation uses the same union.
- Validate the prospective Workspace graph after applying planned per-path choices and before transfer. A dangling Project reference, missing Map Image or Alignment, unsupported format, or other Workspace invariant violation is a Conflict or operation failure as appropriate even when no individual path changed on both sides.
- Maintain a durable local-change index at the managed ProjectStore write/delete seam. Every successful Ballastella write or deletion since the Baseline marks its path; Baseline advancement clears only paths made shared. Automatic Remote Status combines that index with the Remote tree and never reads or hashes every local file. Because external edits to a chosen folder bypass the seam, deliberate Update and Publish planning retain the existing complete read-and-hash pass and may revise the previously displayed status before transfer.
- Remote Status is observational. Authenticated bound Workspaces check on open and window focus with bounded throttling; signed-out users may check a public Remote explicitly. Check failures preserve the last successful status and timestamp but report that current status is unavailable. Cannot tell is a successful determination that evidence is absent, not a network failure.
- Remote Status is a persistent navigation-bar control separate from the local save indicator. It displays text for Up to date, Changes to publish, Update available, Changes on both sides, Conflict, and Cannot tell. Publish-owned viewer differences are additionally classified as Published Site staleness rather than changed scholarship.
- Update from GitHub is the explicit inbound operation. With a Baseline, it applies Remote-only additions, replacements, and deletions, retains local-only changes, confirms named destructive changes, validates the resulting graph, commits atomically, and advances only state made shared. Without a Baseline it follows the Cannot tell rules above. It never writes the Remote, publishes local work, or imports Publish-owned viewer output.
- Ordinary Publish remains the explicit outbound operation and the existing exact-mirror operation over Ballastella's Remote-owned namespace. If Remote-only or Changes-on-both-sides source state exists, Publish refuses and directs the author to Update first. Without a Baseline it retains the existing unknown-conflict refusal and confirmed Publish anyway remedy. A Conflict retains the same local-wins path; no Remote-wins replacement, content merger, or per-file resolution UI is added.
- Synchronization source content includes Projects, Workspace Map Images and Alignments, Annotations, Offline Copies, and `base-map/tiles/**`. Generated Published Site output — including `_app/**`, `index.html`, `.nojekyll`, `robots.txt`, `ballastella-site.json`, and generated Base Map fonts, sprites, and extracts — is Publish-owned. It contributes only Published Site staleness, Update never imports it, and it cannot create a source Conflict. Publish regenerates and mirrors it while preserving repository files outside Ballastella's Remote-owned namespace.
- Separate local Remote relationship metadata from Published Site return-link metadata. A Publish writes the repository address and editor address required by the viewer into generated Published Site metadata. Opening, Updating, restoring, or importing never derives a local binding from those published fields.
- Treat the legacy root repository metadata as published-site compatibility evidence only when reading old sites; it must not silently bind a Workspace opened from a copied or forked repository. New publishes stop relying on that file as the local relationship contract.
- Public Open and Update do not require write permission. Publish checks the authenticated account's repository permission before starting a large transfer. Review Workspaces remain unable to bind, Update, or Publish, and credentials remain outside every Workspace and transfer artifact.
- Preserve existing progress, GitHub rate-limit warnings, exact-tree commit behavior, and files-outside-the-owned-namespace protection. This epic changes the synchronization contract, not the OAuth broker or repository ownership boundary.

## Testing Decisions

- A good test asserts externally observable files, rendered choices, Workspace selection, Remote commits, status text, and refusal outcomes. It does not assert private call order, component state, staging layout, or a particular implementation of the transaction mechanism.
- Use two test seams. The primary acceptance seam is the existing Playwright editor/viewer workflow. The exhaustive engine seam is core over `MemoryProjectStore` and the existing fake GitHub transport. Do not add component-only seams for behavior that can be proved at either of these levels.
- At the browser seam, extend the existing editor transfer scenarios to prove Project Bundle Import into the current Workspace, visible name disambiguation, successful Project opening, and failure leaving the Project list unchanged.
- At the browser seam, extend the existing Remote Review scenarios to prove a Published Project offer contains Import and Review, public Import needs no credential, Review Import uses the recorded origin rather than the latest ordinary Workspace, successful Review Import discards the Review Workspace, and an unavailable origin or failed Import preserves it.
- At the browser seam, adapt the existing Clone/Open scenario to prove the new Open vocabulary, initial Baseline, and reopening the same repository into the same local Workspace.
- At the browser seam, extend the existing Remote conflict scenario with one complete status lifecycle: Cannot tell without a Baseline, Up to date after evidence is established, local Changes to publish, Remote Update available, non-conflicting Changes on both sides, confirmed Update, Conflict refusal, and Publish anyway. Keep this one workflow rather than duplicating the planner matrix through the UI.
- At the browser seam, assert keyboard operation, focus after dialogs and Workspace switches, visible text independent of color, polite progress and status announcements, and alert semantics for newly inserted failures. Poll until transitions and live announcements settle rather than sampling mid-transition.
- Browser tests use the existing network fence and fixture routing; no test reaches GitHub or another external host. Rebuild both app artifacts before browser verification, and run Playwright through `pnpm test:e2e` by spec name.
- At the core store seam, run the complete Import contract once through the shared engine: fresh Map Image identities, repeated-reference preservation, Alignment rewrites, stamped-pyramid reset versus genuine Library service preservation, local/Remote/Baseline directory collisions, reserved names, publication reset, provenance inheritance, own-Remote refusal, complete closure, one-copy quota refusal, and no overwrite.
- Test each source adapter only for source-specific closure gathering and observed provenance. Do not repeat the shared remapping matrix for Project Bundle, Published Site, and Review sources.
- At the core fake-GitHub seam, exercise the complete three-way planner table for additions, replacements, deletions, equal changes, different same-path changes, changes on different paths, missing Baseline, generated-only staleness, locally and remotely recognized Project directories, and prospective graph-invalid combinations.
- Assert Baseline advancement as observable persisted evidence: Open establishes complete shared state; Update advances incorporated inbound state; Publish and Publish anyway advance their successful results when storage succeeds; checks, refusals, cancelation, authentication failure, network failure, validation failure, and failed Baseline writes fabricate nothing. A failed post-Publish Baseline write yields Cannot tell while the Remote commit remains successful.
- Cover migration from a matching v1 publish manifest and binding, a binding with no manifest, a manifest for another repository or branch, an over-capacity legacy manifest store, an explicitly declined legacy binding, and a restored Backup that remains unbound.
- Assert that an automatic status check reads no Workspace file bytes, using the durable change index for Ballastella writes and deletions, while deliberate Update and Publish planning still detects an out-of-band chosen-folder edit through full hashing.
- Reuse existing Remote publish tests for atomic branch visibility, non-owned repository-file preservation, truncated-tree refusal, branch movement, request budgeting, and permission checks. Add only synchronization assertions; do not restate the existing Publish epic.
- Exercise transaction fault injection at each durable boundary for Import and Update. For Import, assert that provisional final-path Map Images never reach the Map Image list, Workspace size, Backup, or Publish because the Workspace cannot open before marker recovery; assert one-copy quota accounting and cleanup after restart. For Update, compare Workspace and Baseline with complete before and after snapshots and accept only one of those states, never a mixture.
- Run adapter conformance where the backing changes observable behavior: browser storage and chosen-folder Workspaces must produce the same committed files, cleanup, and recovery result. Reuse the shared browser adapter suite rather than creating feature-specific adapter mocks.
- Extend Published Site and return-link tests for new repository metadata, old-site fallback, the unchanged `clone` and `review` invitation parameters with their new meanings, declining without transfer, and the existing single query-parameter cleanup path.
- Prove that generated viewer and generated Base Map assets can report Published Site staleness but are not downloaded by Update, do not enter the source Baseline, and do not create Conflict between editor versions; prove that `base-map/tiles/**` still updates as Workspace data.
- Before adding any browser test, run the Seam 2 size check and consolidate with an existing workflow where possible. If the 646 ceiling must rise, add a dated row to the ceiling table with the specific behavior that cannot be tested at a lower seam and profile the resulting suite cost.
- Mutation-check every new refusal and rollback assertion by breaking the behavior it claims to protect. A test that still passes when a reference rewrite, Conflict check, or cleanup step is removed is not sufficient.

## Out of Scope

- Content-level merging of `project.json`, Annotations, Alignments, or any other file.
- A per-file Conflict resolver, Remote-wins replacement control, or Git history interface.
- Project-level Remotes, Project-level Publish, or synchronization between an imported Project and its provenance source.
- Reusing or deduplicating imported Map Images based on IIIF service, bytes, title, provenance, or an apparent matching Alignment.
- Automatic Update, automatic Publish, background transfer while the application is closed, or a generic “Sync” button that combines inbound and outbound transfer.
- Treating absence from the Front Page as privacy or access control.
- Authorship verification, signed Project Bundles, cryptographic provenance, or attribution policy beyond preserving source metadata and recording observed transfer facts.
- Importing arbitrary GitHub repositories that are not recognizable Ballastella Published Sites, or importing private unpublished repository content as a Project.
- Combining two ordinary Workspaces, restoring a Backup into an existing Workspace, or changing Backup and Restore semantics.
- Replacing tar as the Project Bundle or Backup format.
- Implementing Git locally, exposing commits or branches as authoring concepts, or requiring Git command-line tools.
- Redesigning OAuth, the credential broker, personal-access-token support, GitHub Pages deployment, hosting budgets, or the existing non-Ballastella repository-file preservation rules.
- Solving the existing rate-limited first-Publish resumption gap; this epic must not claim that already-uploaded loose blobs make such a Publish resumable.
- More than one Alignment per Map Image. Import preserves the existing invariant by creating fresh Map Image identities.

## Further Notes

- The domain decisions are recorded in ADR-0037, Import copies a Project into the current Workspace, and ADR-0038, Workspace synchronization is explicit and baseline-based. They amend the prior review-only and publish-only decisions rather than weakening Review isolation or the one-Alignment-per-Map-Image invariant.
- The current Project Bundle and GitHub Review engines already gather the two Project closures this feature needs. Extract a read-only source capability without handing either review engine an ordinary destination store. The Import engine is the sole structural crossing, and all ADR-0024 no-promotion headers and user-facing claims must be rewritten with it.
- The existing publish manifest already contains valid per-path evidence for the last successful Publish, but it can be absent and its `localStorage` write can fail after publication succeeds. Matching v1 evidence migrates; missing or mismatched evidence produces Cannot tell. Open a Workspace from GitHub must write the initial Baseline, fixing the known missing Clone manifest without pretending every existing binding has one.
- Root repository metadata currently serves both local binding and Published Site return links. Existing bindings require a guarded first-open migration into installation-local metadata; restored Backups remain unbound. The viewer reads new repository evidence from `ballastella-site.json` and falls back to legacy `remote.json` only for old sites.
- The shipped `clone` and `review` query parameters already express the two invitation shapes needed. Their meanings broaden without renaming them; adding a parallel URL vocabulary would create compatibility work with no domain benefit.
- Import atomicity uses fresh-path provisional writes under a recoverable marker, so it neither exposes orphan Map Images nor requires two pyramid copies. Update has a different rollback cost because it replaces existing paths; its preflight accounts for recoverable before-images.
- Generated Published Site output is not inbound Workspace state. It is regenerated by Publish and contributes a separate staleness condition; only authored data, Map Image data, Alignments, Annotations, Offline Copies, and offline Base Map tiles participate in Update and source Conflicts.
- The implementation should retain the current highest-risk fences: no network in tests, full-tree truncation refusal, one final Remote ref movement, viewer dependency limits, relative published asset paths, and credentials outside the Workspace.

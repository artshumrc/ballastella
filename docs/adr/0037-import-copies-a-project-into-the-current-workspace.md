# Import copies a Project into the current Workspace

> **Amends [ADR-0008](./0008-projects-live-in-a-workspace.md), [ADR-0023](./0023-map-images-and-alignments-live-in-the-workspace.md), [ADR-0024](./0024-backup-and-handoff-are-different-artefacts.md), and [ADR-0032](./0032-publish-means-the-remote.md).**

A Project from outside the current Workspace may be **imported** as detached work the user owns. Import accepts a Project Bundle, a Project from a Published Site, or the current state of a Project in a Review Workspace; unlike Review, it adds the Project to the current ordinary Workspace. Import from Review returns to that ordinary Workspace and discards the Review Workspace after the copy succeeds.

Import is not a merge. It copies the complete Project closure atomically, assigns every incoming Map Image a fresh identity, preserves its incoming Alignment, and rewrites every Layer and local placeholder that referred to the old identity. A conflicting Project name receives a visible `(imported)` variant and a collision-free directory rather than overwriting anything. This preserves ADR-0023's one-Alignment-per-Map-Image invariant: two scholars' readings of the same scan coexist because Import represents them as distinct Map Images.

The imported Project is off the Front Page, has no publication address, and retains no Remote relationship. It carries an append-only, read-only Import Provenance history containing only facts observed during each transfer; inherited entries remain identified as inherited and never become authorship claims. Importing a Project from the current Workspace's own Remote is refused in favour of opening the local Project or updating the Workspace.

The previous review-only rule avoided Alignment collisions by forbidding ownership. Creating a new Workspace for every received Project was rejected because Import means adding a Project to the Workspace already open. Reusing an apparently identical Map Image was also rejected: it would make later Alignment edits propagate into pre-existing Projects and would make Import behave differently based on provenance Ballastella cannot authenticate.

The Workspace Home therefore distinguishes **Import a Project**, **Review a Project**, and **New Project**. A Published Project's **Open in Ballastella** link offers Import into the named current Workspace or Open in a review copy; a successful review import states that it imports the reviewed state and discards the review copy.

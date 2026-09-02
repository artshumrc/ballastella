// Where an imported Project lands: the name the author sees, the directory it occupies, and one
// destination path for every file of its closure (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO NAMESPACES, AND FORCING THEM TO AGREE IS THE BUG
//
// A Project has a **display name**, which is what the author reads on the hub, and a **directory**,
// which is its identity (ADR-0008) and a folder on somebody's disk. They are allocated against
// different evidence and they are allowed to disagree:
//
//   * The display name is allocated against the display names the Workspace *shows*. Two Projects may
//     legitimately share one — renaming can never collide (ADR-0008) — so the only thing at stake is
//     that the author can tell the copy from the original, which is what `(imported)` says.
//   * The directory is allocated against every name a folder could already be, which is a strictly
//     wider question and includes names no Project holds: the Workspace's own shared directories, a
//     `docs/` somebody keeps beside their Projects, and — the part that is easy to miss — Project
//     directories that exist only on the Remote or only in the Synchronization Baseline.
//
// So `Amsterdam 1625 (imported)` can land in `amsterdam-1625-imported` while plain `Amsterdam 1625`
// lands in `amsterdam-1625-2`. An implementation that derived one suffix and used it in both places
// would have to pick which question to answer with it, and would get the other one wrong.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE REMOTE AND THE BASELINE ARE EVIDENCE
//
// A bound Workspace's Remote may hold a Project this installation has never seen — sent from
// another machine, or added by a collaborator. Allocating `amsterdam-1625` locally because nothing
// local holds it manufactures a Conflict the author did not create and cannot understand: two
// unrelated Projects at one directory, discovered at the next Sync. The Baseline covers the third
// case, a directory both live sides have already lost sight of but whose files are still ours.
//
// `recognisedProjectDirectories` is the one rule for that union and is asked here rather than
// restated. ⚠ **Recognised Projects only from the two remote inventories**, not their top-level
// names: a repository's `README.md`, its `docs/`, its workflows are somebody else's files in the
// same repository (ADR-0033) and reserving them would refuse names that are free.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PURE, AND WHAT THAT COSTS THE CALLER
//
// Nothing here reads a store or a network: the three inventories arrive as arguments, and acquiring
// the current Remote one — with the refusal for a bound Workspace that cannot — is
// `project-import-own-remote.ts`'s. That is what makes the allocation table a table, and it is also
// why {@link commitProjectImport} asks the live store the same question again before it writes the
// marker. The two checks are not redundant: this one is the plan, that one is the guarantee, and
// between them the author may have opened another tab.

import { PROJECT_FILE_NAME } from '../project/project-file.js';
import { foldName, takenDirectoryNames, unusedDirectoryName } from '../project/workspace.js';
import { recognisedProjectDirectories } from '../remote/synchronization-paths.js';
import type { StorePath } from '../store/project-store.js';
import {
	isSharedClosurePath,
	type ClosurePath,
	type ProjectImportSource
} from './project-import-source.js';
import { ImportRefusedError } from './project-import-transaction.js';

/**
 * What the destination Workspace and its Remote already hold.
 *
 * Every member is optional and an absent one means "no evidence of that kind", which is the honest
 * reading for an unbound Workspace: it has no Remote and no Baseline. ⚠ It is *not* the reading for a
 * bound Workspace whose Remote could not be read — that Import is refused before it reaches here
 * (`project-import-own-remote.ts`) rather than allocated against a Remote treated as empty.
 */
export interface ImportDestination {
	/**
	 * The display names of the Projects the Workspace shows now.
	 *
	 * Names rather than directories, because this is the namespace the author reads. A Project whose
	 * `project.json` will not parse shows the fallback name the hub gives it, and that name counts
	 * here like any other: what matters is what is on the screen.
	 */
	readonly names?: Iterable<string>;
	/** Every path the Workspace holds now, Project material or not. */
	readonly local?: Iterable<string>;
	/** Every path the current Remote tree holds. */
	readonly remote?: Iterable<string>;
	/** Every path the valid Synchronization Baseline records. */
	readonly baseline?: Iterable<string>;
}

/** Where one imported Project is going. */
export interface ProjectImportAllocation {
	/**
	 * The display name the imported Project takes.
	 *
	 * ⚠ **Returned rather than written into the closure.** `project-import-provenance.ts` owns the one
	 * rewrite of `project.json` — the publication reset, the Front Page choice and the provenance
	 * entry — and a second module re-serialising the manifest to set one field is how a Project comes
	 * to be imported with two of the three applied.
	 */
	readonly name: string;
	/** The Project's directory, which is its identity (ADR-0008). */
	readonly directory: string;
	/**
	 * Every closure path and the Workspace path it is written to, ready for
	 * {@link commitProjectImport}.
	 *
	 * The Project's own files — `project.json`, `annotations/…` — go inside
	 * {@link ProjectImportAllocation.directory}; the shared material — `images/<id>/…`,
	 * `alignments/<id>.json` — stays at the top level, because it belongs to the Workspace rather than
	 * to the Project (ADR-0023) and its identities are already fresh (`project-import-remapping.ts`).
	 */
	readonly destinations: ReadonlyMap<ClosurePath, StorePath>;
}

/**
 * The suffix an author sees when a copy has to be told apart from the original.
 *
 * `Name (imported)` first, then `Name (imported 2)`, `Name (imported 3)` — the *first available*
 * variant rather than the next number, so a Workspace that has had `(imported 2)` renamed away offers
 * the shorter name again instead of counting past it forever.
 */
const importedVariant = (name: string, suffix: number): string =>
	suffix === 1 ? `${name} (imported)` : `${name} (imported ${suffix})`;

/**
 * Plan where one remapped closure goes, without touching anything.
 *
 * Both allocations are deterministic in the evidence given, so running this twice against a Workspace
 * that has since gained the first Import's Project produces a *different* Project directory and — the
 * closure's identities being `remapProjectImport`'s, minted per Import — a disjoint set of Map Image,
 * Alignment and Annotation destinations. Nothing here recognises the second run's source as the
 * first's; an Import is a copy, and two copies are two Projects.
 *
 * @throws ImportRefusedError `'destination-exists'` when an allocated path is, or folds onto,
 *   something the Workspace already holds. Every Project file and Annotation is inside a directory
 *   this function has just proved free, so in practice this is the shared material: a fresh Map Image
 *   identity is minted without consulting the destination, and a one-in-astronomical collision must
 *   refuse rather than overwrite an Alignment the author's other Projects draw through.
 */
export function allocateProjectImport(
	closure: ProjectImportSource,
	destination: ImportDestination = {}
): ProjectImportAllocation {
	const name = allocateName(closure.project.name, destination.names ?? []);
	const directory = allocateDirectory(name, destination);
	const destinations = new Map<ClosurePath, StorePath>(
		closure.paths.map((path) => [
			path,
			(isSharedClosurePath(path) ? path : `${directory}/${path}`) as StorePath
		])
	);
	assertNothingIsOverwritten(destinations, destination.local ?? []);
	return { name, directory, destinations };
}

/**
 * The incoming name, or the first `(imported…)` variant no Project shows.
 *
 * Compared through {@link foldName} like every other name in this codebase: two display names that
 * differ only in case or in Unicode composition are the same name to a reader, and one of them will be
 * the other's folder on APFS anyway. Conservative in the direction that costs a suffix rather than the
 * one that costs the author the ability to tell two Projects apart.
 */
function allocateName(incoming: string, shown: Iterable<string>): string {
	const taken = new Set([...shown].map(foldName));
	if (!taken.has(foldName(incoming))) return incoming;
	for (let suffix = 1; ; suffix += 1) {
		const candidate = importedVariant(incoming, suffix);
		if (!taken.has(foldName(candidate))) return candidate;
	}
}

/**
 * The first free directory for the final display name, against the folded union of all the evidence.
 *
 * The reserved Workspace directories and every top-level local name come from
 * {@link takenDirectoryNames}, which is what `createProject` allocates against; the Remote's and the
 * Baseline's *recognised Project directories* are added to it. So an imported Project called "Images"
 * keeps its display name and lands in `images-2` — the refusal `createProject` raises is not available
 * here, because there is nobody to ask for another name and refusing the Import over the author's
 * choice of title would refuse the work.
 */
function allocateDirectory(name: string, destination: ImportDestination): string {
	const taken = takenDirectoryNames(destination.local ?? []);
	const shared = recognisedProjectDirectories({
		remote: destination.remote ?? [],
		baseline: destination.baseline ?? []
	});
	for (const directory of shared) taken.add(foldName(directory));
	return unusedDirectoryName(name, taken);
}

/**
 * Refuse the whole allocation if any destination is already the author's, folded on both sides.
 *
 * The **entire** closure, not `project.json`: every Annotation, every tile of every pyramid and every
 * Alignment is a path somebody's work could be at, and `foldName` is unaffected by `/` so a path folds
 * segment by segment for free (its own note says so). Refusal rather than a re-allocation, because
 * there is nothing to re-allocate — the identity is `remapProjectImport`'s and the directory has
 * already been proved free — and refusing before the transaction is what keeps the marker off a
 * Workspace that was never going to receive this Project.
 */
function assertNothingIsOverwritten(
	destinations: ReadonlyMap<ClosurePath, StorePath>,
	local: Iterable<string>
): void {
	const existing = new Map<string, string>();
	for (const path of local) existing.set(foldName(path), path);

	for (const [closure, destination] of destinations) {
		const held = existing.get(foldName(destination));
		if (held === undefined) continue;
		throw new ImportRefusedError(
			'destination-exists',
			`This Workspace already holds “${held}”, and the Import would write ` +
				`${closure === PROJECT_FILE_NAME ? 'the Project' : `“${closure}”`} to “${destination}”. ` +
				'Nothing has been added to your Workspace.'
		);
	}
}

// How a Project reached this Workspace: the transfer history `project.json` carries (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS NOT
//
// **It is not attribution, and every field here is chosen so that it cannot be read as attribution.**
// A Project Bundle's filename is a filename — the user picked a file, and that is the whole of what
// Ballastella saw. A repository owner is the account the bytes were fetched from, not the scholar who
// made the maps. So there is no author, no owner-of-the-scholarship, no signature and nothing to
// verify one with: an entry records a *route*, and a route is not a claim about who wrote what.
//
// It is not a relationship either. An imported Project keeps none with its source (ADR-0037), so
// there is no credential and no Remote in an entry, and a `canonicalUrl` cleared at Import time
// survives only here — as a historical address, in a field nothing fetches from.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY EVERY ENTRY CARRIES ITS EVIDENCE
//
// A Project transferred twice holds two entries, and only one of them was witnessed by the build
// that wrote it: the other arrived inside the Project and was carried forward. Both are worth
// keeping — the chain of handoffs is the point — but they are not the same kind of fact, and a
// history that presented them alike would let a claim nobody checked pass for something this
// application saw. So a transfer marks its own entry `observed` and everything it carried
// `inherited`, and the editor says which is which.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TOLERANCE, FOR THE SAME REASON `ProjectFile.unknownFields` EXISTS
//
// History that a build erases is not history. An entry of a kind this build has never heard of is
// carried as {@link ForeignImportProvenance} rather than dropped, and a member it does not model is
// carried per entry — the discipline `parseLayers` applies to a Layer, applied to the one array in
// this file whose whole contract is that nothing removes from it (ADR-0010).

/**
 * Whether Ballastella saw this transfer itself, or was handed a record of one.
 *
 * `observed` means the fields beside it were read off the source at the moment of Import.
 * `inherited` means they came in with the Project and were carried forward unverified.
 */
export type ImportProvenanceEvidence = 'observed' | 'inherited';

/** What every entry says, whatever kind of source it records. */
interface ImportProvenanceCommon {
	/** When the transfer this entry records was observed, ISO 8601. */
	readonly observedAt: string;
	readonly evidence: ImportProvenanceEvidence;
	/** Members this build does not model, kept so that writing the file back cannot drop them. */
	readonly unknownFields?: Readonly<Record<string, unknown>>;
}

/**
 * A Project copied out of a repository on GitHub.
 *
 * The repository coordinates are normalised into their three parts rather than kept as one string,
 * which is how every other GitHub identity in this codebase is spelled. Together with `directory` —
 * a Project's identity (ADR-0008) — and the commit the branch stood at, they say *which state of
 * which Project* was copied, which is the only thing this entry is for.
 */
export interface GitHubImportProvenance extends ImportProvenanceCommon {
	readonly kind: 'github';
	readonly owner: string;
	readonly repository: string;
	readonly branch: string;
	/** The Project's directory on the Remote: the address it was published at. */
	readonly directory: string;
	/** The commit the branch stood at when the Project was read. */
	readonly commit: string;
}

/** A Project copied out of a Project Bundle somebody handed the user. */
export interface ProjectBundleImportProvenance extends ImportProvenanceCommon {
	readonly kind: 'project-bundle';
	/** The name of the file that was picked. **A filename, and nothing more than one.** */
	readonly filename: string;
	/** The display name inside the bundle's `project.json`. Not a claim about its author. */
	readonly projectName: string;
}

/** A Project copied out of the Review Workspace it was being read in. */
export interface ReviewImportProvenance extends ImportProvenanceCommon {
	readonly kind: 'review';
	readonly projectName: string;
}

/**
 * An entry of a kind this build has never heard of, kept exactly as it arrived.
 *
 * `kind` is the literal `'foreign'` so that narrowing on the discriminator still works, and the kind
 * the file carried is {@link declaredKind} — the same arrangement `ForeignLayer` uses, so a future
 * real kind must not be called `'foreign'`. It exists because a fourth source added by a later build
 * would otherwise have its entry silently deleted by this one, which is the single thing an
 * append-only history may not do.
 */
export interface ForeignImportProvenance extends ImportProvenanceCommon {
	readonly kind: 'foreign';
	/** The `kind` the file carried. Never one of the kinds this build knows. */
	readonly declaredKind: string;
}

/** One transfer in a Project's history. */
export type ImportProvenanceEntry =
	| GitHubImportProvenance
	| ProjectBundleImportProvenance
	| ReviewImportProvenance
	| ForeignImportProvenance;

/** The key `project.json` spells the history under. */
export const IMPORT_PROVENANCE_KEY = 'importProvenance';

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** `unknownFields` only when there is something in it, so `exactOptionalPropertyTypes` holds. */
const carried = (rest: Record<string, unknown>): { unknownFields?: Record<string, unknown> } =>
	Object.keys(rest).length === 0 ? {} : { unknownFields: rest };

/**
 * Read one entry, or `null` for a value that is not an entry at all.
 *
 * ⚠ **Only the literal `'observed'` is observed.** An entry with no `evidence`, a misspelled one, or
 * a third value from a later build reads as `inherited`, because the direction that costs nothing is
 * the one that does not assert this build saw something. Reading it the other way would
 * manufacture a witness.
 */
function parseEntry(raw: unknown): ImportProvenanceEntry | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const { kind, observedAt, evidence, ...rest } = raw as Record<string, unknown>;
	const common = {
		observedAt: readString(observedAt),
		evidence: (evidence === 'observed' ? 'observed' : 'inherited') as ImportProvenanceEvidence
	};

	switch (kind) {
		case 'github': {
			const { owner, repository, branch, directory, commit, ...unknown } = rest;
			return {
				kind: 'github',
				owner: readString(owner),
				repository: readString(repository),
				branch: readString(branch),
				directory: readString(directory),
				commit: readString(commit),
				...common,
				...carried(unknown)
			};
		}
		case 'project-bundle': {
			const { filename, projectName, ...unknown } = rest;
			return {
				kind: 'project-bundle',
				filename: readString(filename),
				projectName: readString(projectName),
				...common,
				...carried(unknown)
			};
		}
		case 'review': {
			const { projectName, ...unknown } = rest;
			return {
				kind: 'review',
				projectName: readString(projectName),
				...common,
				...carried(unknown)
			};
		}
		default:
			// A `kind` that is not a string at all still becomes a foreign entry rather than being
			// dropped: the bytes say something happened, and this build's inability to say what is not a
			// reason to remove it from the record.
			return { kind: 'foreign', declaredKind: readString(kind), ...common, ...carried(rest) };
	}
}

/**
 * Read the `importProvenance` array of a `project.json`.
 *
 * **Tolerant, and never throws**, like `parseLayers`: a Project must open whatever its history looks
 * like. A value that is not an array is no history at all — {@link parseProjectFile} keeps such a
 * value verbatim in `unknownFields`, so nothing is lost by this returning nothing.
 */
export function parseImportProvenance(raw: unknown): readonly ImportProvenanceEntry[] {
	if (!Array.isArray(raw)) return [];
	const entries: ImportProvenanceEntry[] = [];
	for (const element of raw) {
		const entry = parseEntry(element);
		if (entry !== null) entries.push(entry);
	}
	return entries;
}

/**
 * Write one entry.
 *
 * `unknownFields` is spread last, as in `serialiseLayer` and for the same reason: every key this
 * function writes is destructured out on the way in, so nothing carried can shadow a field an edit
 * changed.
 */
function serialiseEntry(entry: ImportProvenanceEntry): Record<string, unknown> {
	const common = { observedAt: entry.observedAt, evidence: entry.evidence };
	switch (entry.kind) {
		case 'github':
			return {
				kind: 'github',
				owner: entry.owner,
				repository: entry.repository,
				branch: entry.branch,
				directory: entry.directory,
				commit: entry.commit,
				...common,
				...entry.unknownFields
			};
		case 'project-bundle':
			return {
				kind: 'project-bundle',
				filename: entry.filename,
				projectName: entry.projectName,
				...common,
				...entry.unknownFields
			};
		case 'review':
			return { kind: 'review', projectName: entry.projectName, ...common, ...entry.unknownFields };
		// No `default:`. A fifth kind added to the union lands here as a compile error in the one
		// function that writes entries, rather than being written out as a foreign one at runtime.
		case 'foreign':
			return { kind: entry.declaredKind, ...common, ...entry.unknownFields };
	}
}

/** Write the `importProvenance` array of a `project.json`, oldest transfer first. */
export function serialiseImportProvenance(
	entries: readonly ImportProvenanceEntry[]
): readonly unknown[] {
	return entries.map(serialiseEntry);
}

/**
 * The same history, with nothing in it claiming to have been witnessed here.
 *
 * What a transfer does to the entries it carries forward, and the reason an entry's evidence is a
 * field rather than a position in the array: after two handoffs the array holds two `observed`
 * entries written by two different builds, and only the last one was observed by the build that
 * wrote *this* file.
 */
export function inheritImportProvenance(
	entries: readonly ImportProvenanceEntry[]
): readonly ImportProvenanceEntry[] {
	return entries.map((entry) =>
		entry.evidence === 'inherited' ? entry : { ...entry, evidence: 'inherited' as const }
	);
}

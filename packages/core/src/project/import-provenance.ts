import { isRecord, textField } from '../store/project-store.js';

type ImportProvenanceEvidence = 'observed' | 'inherited';

interface ImportProvenanceCommon {
	readonly observedAt: string;
	readonly evidence: ImportProvenanceEvidence;
	readonly unknownFields?: Readonly<Record<string, unknown>>;
}

interface GitHubImportProvenance extends ImportProvenanceCommon {
	readonly kind: 'github';
	readonly owner: string;
	readonly repository: string;
	readonly branch: string;
	readonly directory: string;
	readonly commit: string;
}

interface ProjectBundleImportProvenance extends ImportProvenanceCommon {
	readonly kind: 'project-bundle';
	readonly filename: string;
	readonly projectName: string;
}

interface ReviewImportProvenance extends ImportProvenanceCommon {
	readonly kind: 'review';
	readonly projectName: string;
}

interface ForeignImportProvenance extends ImportProvenanceCommon {
	readonly kind: 'foreign';
	readonly declaredKind: string;
}

export type ImportProvenanceEntry =
	| GitHubImportProvenance
	| ProjectBundleImportProvenance
	| ReviewImportProvenance
	| ForeignImportProvenance;

export const IMPORT_PROVENANCE_KEY = 'importProvenance';

const KIND_FIELDS: Readonly<Record<string, readonly string[]>> = {
	github: ['owner', 'repository', 'branch', 'directory', 'commit'],
	'project-bundle': ['filename', 'projectName'],
	review: ['projectName']
};

const fieldsOf = (kind: unknown): readonly string[] | undefined =>
	typeof kind === 'string' && Object.hasOwn(KIND_FIELDS, kind) ? KIND_FIELDS[kind] : undefined;

function parseEntry(raw: unknown): ImportProvenanceEntry | null {
	if (!isRecord(raw)) return null;
	const { kind, observedAt, evidence, ...rest } = raw;
	const fields = fieldsOf(kind);
	const named: Record<string, string> = fields
		? { kind: kind as string }
		: { kind: 'foreign', declaredKind: textField(kind) };
	for (const field of fields ?? []) {
		named[field] = textField(rest[field]);
		delete rest[field];
	}
	return {
		...named,
		observedAt: textField(observedAt),
		evidence: evidence === 'observed' ? 'observed' : 'inherited',
		...(Object.keys(rest).length === 0 ? {} : { unknownFields: rest })
	} as ImportProvenanceEntry;
}

export function parseImportProvenance(raw: unknown): readonly ImportProvenanceEntry[] {
	return Array.isArray(raw) ? raw.map(parseEntry).filter((entry) => entry !== null) : [];
}

function serialiseEntry(entry: ImportProvenanceEntry): Record<string, unknown> {
	const record = entry as unknown as Record<string, unknown>;
	const named =
		entry.kind === 'foreign'
			? { kind: entry.declaredKind }
			: Object.fromEntries([
					['kind', entry.kind],
					...(fieldsOf(entry.kind) ?? []).map((field) => [field, record[field]])
				]);
	return {
		...named,
		observedAt: entry.observedAt,
		evidence: entry.evidence,
		...entry.unknownFields
	};
}

export function serialiseImportProvenance(
	entries: readonly ImportProvenanceEntry[]
): readonly unknown[] {
	return entries.map(serialiseEntry);
}

export function inheritImportProvenance(
	entries: readonly ImportProvenanceEntry[]
): readonly ImportProvenanceEntry[] {
	return entries.map((entry) =>
		entry.evidence === 'inherited' ? entry : { ...entry, evidence: 'inherited' as const }
	);
}

import type { Collection, Image, Manifest } from '@allmaps/iiif-parser';

const DESCRIPTION_LIMITS = {
	rows: 60,
	chars: 2_000,
	canvases: 2_000
} as const;

type DescribedField = { readonly label: string; readonly value: string };

type DescribedCanvas = {
	readonly uri: string;
	readonly label: string;
	readonly imageService: string;
	readonly width: number;
	readonly height: number;
};

type DescribedItem = {
	readonly uri: string;
	readonly label: string;
	readonly kind: 'manifest' | 'collection';
};

export type DescribedResource = {
	readonly kind: 'image' | 'manifest' | 'collection';
	readonly uri: string;
	readonly label: string;
	readonly summary: string;
	readonly metadata: readonly DescribedField[];
	readonly metadataDropped: number;
	readonly attribution: DescribedField | null;
	readonly rights: string;
	readonly rightsLink: string;
	readonly canvases: readonly DescribedCanvas[];
	readonly items: readonly DescribedItem[];
};

export function describeRemoteResource(
	parsed: Image | Manifest | Collection,
	document?: unknown
): DescribedResource {
	const source = document ?? ('source' in parsed ? parsed.source : undefined);
	const metadata = 'metadata' in parsed ? readMetadata(parsed.metadata) : { rows: [], dropped: 0 };

	return {
		kind: parsed.type,
		uri: parsed.uri,
		label: 'label' in parsed ? flatten(parsed.label) : '',
		summary: 'summary' in parsed ? flatten(parsed.summary) : '',
		metadata: metadata.rows,
		metadataDropped: metadata.dropped,
		attribution:
			'requiredStatement' in parsed && parsed.requiredStatement
				? {
						label: flatten(parsed.requiredStatement.label),
						value: flatten(parsed.requiredStatement.value)
					}
				: null,
		rights: readRights(source),
		rightsLink: httpOnly(readRights(source)),
		canvases: parsed.type === 'manifest' ? describeCanvases(parsed) : [],
		items: parsed.type === 'collection' ? describeItems(parsed) : []
	};
}

function describeCanvases(manifest: Manifest): DescribedCanvas[] {
	return manifest.canvases.slice(0, DESCRIPTION_LIMITS.canvases).map((canvas, index) => ({
		uri: canvas.uri,
		label: flatten(canvas.label) || `Image ${index + 1}`,
		imageService: imageServiceOf(canvas.image),
		width: canvas.width,
		height: canvas.height
	}));
}

function describeItems(collection: Collection): DescribedItem[] {
	return collection.items.slice(0, DESCRIPTION_LIMITS.canvases).map((item, index) => ({
		uri: item.uri,
		label: flatten(item.label) || `Item ${index + 1}`,
		kind: item.type
	}));
}

function imageServiceOf(image: { uri?: unknown } | undefined): string {
	return typeof image?.uri === 'string' && image.uri !== '' ? image.uri : '';
}

function readMetadata(metadata: unknown): { rows: DescribedField[]; dropped: number } {
	if (!Array.isArray(metadata)) return { rows: [], dropped: 0 };
	const rows = metadata
		.slice(0, DESCRIPTION_LIMITS.rows)
		.map((item: unknown) => {
			const record = item as { label?: unknown; value?: unknown } | null;
			return { label: flatten(record?.label), value: flatten(record?.value) };
		})
		.filter((row) => row.label !== '' || row.value !== '');
	return { rows, dropped: Math.max(0, metadata.length - DESCRIPTION_LIMITS.rows) };
}

function readRights(source: unknown): string {
	const record = source as { rights?: unknown; license?: unknown } | null;
	for (const candidate of [record?.rights, record?.license]) {
		if (typeof candidate === 'string' && candidate !== '') {
			return candidate.slice(0, DESCRIPTION_LIMITS.chars);
		}
		if (Array.isArray(candidate)) {
			const first = candidate.find((entry) => typeof entry === 'string' && entry !== '');
			if (typeof first === 'string') return first.slice(0, DESCRIPTION_LIMITS.chars);
		}
	}
	return '';
}

function httpOnly(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : '';
	} catch {
		return '';
	}
}

function flatten(value: unknown): string {
	if (typeof value === 'string') return value.slice(0, DESCRIPTION_LIMITS.chars);
	if (value === null || typeof value !== 'object') return '';
	const parts: string[] = [];
	for (const entry of Object.values(value as Record<string, unknown>)) {
		for (const item of Array.isArray(entry) ? entry : [entry]) {
			if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
				const text = String(item).trim();
				if (text !== '' && !parts.includes(text)) parts.push(text);
			}
		}
	}
	return parts.join(' · ').slice(0, DESCRIPTION_LIMITS.chars);
}

// What a remote IIIF resource says about itself, flattened into plain strings a pane can show.
//
// A scholar reads a Manifest's metadata, rights, and attribution *while choosing*, so they know
// what they are permitted to do with the map before they build work on it. ADR-0007 wants the same
// two fields again at the moment an offline copy is made (`offline-copy.ts`), which is why they are
// recorded into `remote.json` rather than only rendered.
//
// **Everything out of here is text, and it is bounded.** A IIIF `label` or metadata `value` is a
// stranger's string; the Presentation API even permits a restricted subset of HTML in it. This
// module hands back plain strings and nothing renders them as markup — the caller interpolates
// them, which Svelte escapes. That is a deliberate loss of italics in a library's cataloguing note,
// and it is the right trade here: the Markdown-and-sanitisation path in `annotation/markdown.ts`
// exists for the user's *own* prose, and reaching for it to render a third party's document would
// put an untrusted string through a renderer on the strength of somebody else's escaping.
//
// The bounds are the same discipline as `remote-resource.ts`: a document that declares four
// thousand metadata rows of a megabyte each must not be able to lock the tab up in layout.

import type { Collection, Image, Manifest } from '@allmaps/iiif-parser';

/** How much of a stranger's cataloguing this will show. */
export const DESCRIPTION_LIMITS = {
	/** Metadata rows rendered. Beyond this the rest are dropped and the count is reported. */
	rows: 60,
	/** Characters kept per label or value. Long enough for a real provenance note. */
	chars: 2_000,
	/** Canvases listed for selection. Above `REMOTE_IIIF_LIMITS.canvases` nothing gets this far. */
	canvases: 2_000
} as const;

/** One row of a Manifest's metadata, or its required statement. */
export type DescribedField = { readonly label: string; readonly value: string };

/** One canvas of a Manifest, as a thing the user can pick. */
export type DescribedCanvas = {
	readonly uri: string;
	readonly label: string;
	/**
	 * The canvas's image service URI — **the only thing that crosses to the alignment path**
	 * (ADR-0018). `''` when the canvas paints something that is not a tiled image service, which is
	 * how a canvas of video, of a plain JPEG, or of an unresolvable Choice reports itself.
	 */
	readonly imageService: string;
	readonly width: number;
	readonly height: number;
};

/** One item of a Collection, as something to open. */
export type DescribedItem = {
	readonly uri: string;
	readonly label: string;
	readonly kind: 'manifest' | 'collection';
};

/** Everything a selection pane needs from a parsed resource, as text. */
export type DescribedResource = {
	readonly kind: 'image' | 'manifest' | 'collection';
	readonly uri: string;
	readonly label: string;
	readonly summary: string;
	readonly metadata: readonly DescribedField[];
	/** How many metadata rows were dropped by {@link DESCRIPTION_LIMITS}. */
	readonly metadataDropped: number;
	/** The `requiredStatement` — the attribution a library requires be displayed. */
	readonly attribution: DescribedField | null;
	/** The `rights` URI, verbatim, for display and for the record. `''` when none was stated. */
	readonly rights: string;
	/**
	 * {@link rights} if and only if it is safe to put in an `href`, otherwise `''`.
	 *
	 * **Not the same field, and the difference is a real vulnerability.** `rights` is a string out of
	 * a stranger's document, and Svelte does not sanitise `href`: a Manifest declaring
	 * `"rights": "javascript:…"` would produce a link that runs script when a scholar clicks it to
	 * read the licence. So the decision "may this be a link" is made here, beside the other
	 * untrusted-input rules, rather than in a component where the next component would have to make
	 * it again.
	 *
	 * `http` and `https` only. Every real rights statement is one of those — `creativecommons.org`,
	 * `rightsstatements.org` — so nothing legitimate loses its link, and anything else is still shown
	 * as text.
	 */
	readonly rightsLink: string;
	readonly canvases: readonly DescribedCanvas[];
	readonly items: readonly DescribedItem[];
};

/**
 * Describe a parsed Manifest, Collection, or Image.
 *
 * Never throws. This runs on a document that has already been accepted, to render a panel, and a
 * missing field is a missing line rather than a resource that cannot be added — a library that
 * omits `summary` has not published a broken Manifest.
 *
 * `document` is the raw JSON the parse came from. It is asked for rather than taken off
 * `parsed.source`, which is only populated when `IIIF.parse` was given `keepSource` — a flag it is
 * easy to forget and whose absence would silently drop the rights statement, the one field on this
 * panel that changes what a scholar is allowed to do. `RemoteIiifResource` carries the document
 * already, so nothing has to re-fetch to supply it.
 */
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
		// `rights` is not on the parsed classes at `@allmaps/iiif-parser@1.0.0-beta.48`, so it is read
		// off the document the parser kept. Read here rather than in the caller because "what the
		// library said you may do with this" belongs with the rest of what the library said.
		rights: readRights(source),
		rightsLink: httpOnly(readRights(source)),
		canvases: parsed.type === 'manifest' ? describeCanvases(parsed) : [],
		items: parsed.type === 'collection' ? describeItems(parsed) : []
	};
}

function describeCanvases(manifest: Manifest): DescribedCanvas[] {
	return manifest.canvases.slice(0, DESCRIPTION_LIMITS.canvases).map((canvas, index) => ({
		uri: canvas.uri,
		// A canvas with no label is normal — most volumes label pages and many do not — and a blank
		// row in a list of forty is unusable, so it is numbered instead. 1-based, because it is what
		// the user is looking at rather than an array index.
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

/**
 * A canvas's image service URI, or `''`.
 *
 * `''` rather than a guess when the canvas paints something that is not a tiled image service.
 * ADR-0014 puts aligning a `Choice` out of scope — it may be *viewed* — and there is no such thing
 * as aligning a video, so a canvas that cannot be aligned says so by having nothing to hand over
 * rather than by handing over a URI that will fail two requests later.
 */
export function imageServiceOf(image: { uri?: unknown } | undefined): string {
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

/**
 * The `rights` URI a Presentation document declares, in either API version.
 *
 * Presentation 3 calls it `rights` and requires a URI; Presentation 2 called it `license`. Both
 * are read, because a library that has not migrated has still told the user what they may do.
 */
function readRights(source: unknown): string {
	const record = source as { rights?: unknown; license?: unknown } | null;
	for (const candidate of [record?.rights, record?.license]) {
		if (typeof candidate === 'string' && candidate !== '') {
			return candidate.slice(0, DESCRIPTION_LIMITS.chars);
		}
		// Presentation 2 permitted an array of licences, and some real manifests carry one.
		if (Array.isArray(candidate)) {
			const first = candidate.find((entry) => typeof entry === 'string' && entry !== '');
			if (typeof first === 'string') return first.slice(0, DESCRIPTION_LIMITS.chars);
		}
	}
	return '';
}

/**
 * `url` if it is an `http`/`https` URL, otherwise `''`.
 *
 * The one place a string from a remote document becomes something a browser will navigate to. Kept
 * separate from `remoteIiifUrl`, which throws and is about a resource this app is going to *fetch*;
 * this is about a link a person clicks, where a refusal is a missing link and not an error.
 */
function httpOnly(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : '';
	} catch {
		return '';
	}
}

/**
 * A IIIF `LanguageString` as one line of text.
 *
 * Every language's values are joined rather than one language being picked, because picking would
 * mean choosing between a Dutch archive's own title and its English one on the strength of the
 * browser's locale, and showing the wrong one is worse than showing both to a scholar who reads
 * neither fluently. Numbers and booleans are permitted by the type and are stringified rather than
 * dropped.
 */
export function flatten(value: unknown): string {
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

// Reading and writing an Annotation Layer's GeoJSON `FeatureCollection`.
//
// **The only module permitted GeoJSON's own vocabulary** — `Feature`, `FeatureCollection`,
// `properties`, `coordinates` — in the same way `georeference-annotation.ts` is the only module
// permitted "Georeference Annotation". CONTEXT.md lists "feature" under the words to avoid for an
// Annotation, so the domain above this speaks of Annotations and this speaks of the file.
//
// Two properties are load-bearing here and are asserted:
//
// 1. **An unchanged document serialises byte-identically.** Ticket 09 asserts that reordering,
//    renaming, toggling, and setting opacity leave `annotations/*.geojson` byte-identical, and that
//    is now also a round-trip claim about this module: parse a file this app wrote and write it back
//    and the bytes are the same. It is what lets a Workspace live in git without every save producing
//    a diff, and what makes ADR-0010's "merely looking must not modify files" checkable.
//
// 2. **Nothing here is on the import path.** `assertReferencesPresent` in `import-project-zip.ts`
//    validates that a Layer's named GeoJSON is *present* through the typed union, without ever
//    parsing an untrusted Annotation. That property is deliberate and must be kept: a stranger's
//    document is bytes until the user opens the Layer that draws it.

import type { Bytes } from '../store/project-store.js';

import {
	type Annotation,
	type AnnotationCollection,
	type AnnotationGeometry,
	type AnnotationProperties
} from './annotation.js';

/** An Annotation Layer's file could not be read as GeoJSON. */
export class AnnotationsUnreadableError extends Error {
	constructor(
		readonly path: string,
		cause: unknown
	) {
		super(
			`The Annotations in “${path}” could not be read as GeoJSON: ${
				cause instanceof Error ? cause.message : String(cause)
			}`
		);
		this.name = 'AnnotationsUnreadableError';
	}
}

/** The `Feature` keys this module reads into {@link Annotation} rather than carrying. */
const FEATURE_KEYS: readonly string[] = ['type', 'id', 'geometry', 'properties'];

/** The `FeatureCollection` keys this module reads rather than carrying. */
const COLLECTION_KEYS: readonly string[] = ['type', 'features'];

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/** `carried` only when there is something in it, so `exactOptionalPropertyTypes` holds. */
const rest = (
	record: Record<string, unknown>,
	known: readonly string[]
): { unknownFields?: Record<string, unknown> } => {
	const carried = Object.fromEntries(
		Object.entries(record).filter(([key]) => !known.includes(key))
	);
	return Object.keys(carried).length === 0 ? {} : { unknownFields: carried };
};

/** A pair of finite numbers, or `null`. GeoJSON's order is `[lng, lat]`. */
function readPosition(value: unknown): [number, number] | null {
	if (!Array.isArray(value)) return null;
	const [lng, lat] = value;
	if (typeof lng !== 'number' || typeof lat !== 'number') return null;
	if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
	return [lng, lat];
}

const readPositions = (value: unknown): [number, number][] | null => {
	if (!Array.isArray(value)) return null;
	const out: [number, number][] = [];
	for (const element of value) {
		const position = readPosition(element);
		if (position === null) return null;
		out.push(position);
	}
	return out;
};

/**
 * A geometry, or a {@link import('./annotation.js').ForeignGeometry} carrying it whole.
 *
 * A `Point` whose coordinates are not two numbers is *foreign* rather than dropped or repaired. It
 * came from somewhere and it is not this module's business to decide it is worthless — and a
 * geometry silently rewritten is worse than one that is drawn as nothing and written back intact.
 */
function readGeometry(value: unknown): AnnotationGeometry {
	const record = asRecord(value);
	if (record === null) return null;
	const type = record['type'];
	const foreign = (): AnnotationGeometry => ({
		type: 'foreign',
		declaredType: typeof type === 'string' ? type : '',
		raw: record
	});

	if (type === 'Point') {
		const coordinates = readPosition(record['coordinates']);
		return coordinates === null ? foreign() : { type: 'Point', coordinates };
	}
	if (type === 'LineString') {
		const coordinates = readPositions(record['coordinates']);
		return coordinates === null ? foreign() : { type: 'LineString', coordinates };
	}
	if (type === 'Polygon') {
		if (!Array.isArray(record['coordinates'])) return foreign();
		const rings: [number, number][][] = [];
		for (const ring of record['coordinates']) {
			const positions = readPositions(ring);
			if (positions === null) return foreign();
			rings.push(positions);
		}
		return { type: 'Polygon', coordinates: rings };
	}
	return foreign();
}

function readProperties(value: unknown): AnnotationProperties {
	const record = asRecord(value);
	if (record === null) return {};
	// Carried whole rather than picked apart into known and unknown halves. `properties` is the
	// portable surface: a `stroke-linecap` from another tool, or a field a build one commit ahead
	// added, is not worth destroying, and simplestyle explicitly does not forbid extra keys.
	return record as AnnotationProperties;
}

/**
 * Read an Annotation Layer's `FeatureCollection`.
 *
 * **Tolerant of everything except bytes that are not JSON.** A `Feature` with no geometry, a
 * geometry kind this build cannot draw, a property whose type is wrong — all of these are carried,
 * for the same reason `parseLayers` carries a Layer kind it has never heard of: a file the user can
 * open, title, and reorder but not redraw is far better than one the app refuses. Bytes that are not
 * JSON are a different matter and are surfaced, because silently substituting an empty collection
 * would show a scholar none of their Annotations and then overwrite them on the next save.
 *
 * `mintId` is injected rather than reached for so this module needs no `crypto`, which keeps it
 * usable in a Node test as well as in both apps.
 *
 * @throws {AnnotationsUnreadableError} when `bytes` are not JSON, or not an object
 */
export function parseAnnotations(
	bytes: Bytes,
	options: { path?: string; mintId?: () => string } = {}
): AnnotationCollection {
	const path = options.path ?? 'annotations';
	const mintId = options.mintId ?? (() => crypto.randomUUID());

	let document: unknown;
	try {
		document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch (cause) {
		throw new AnnotationsUnreadableError(path, cause);
	}
	const record = asRecord(document);
	if (record === null) {
		throw new AnnotationsUnreadableError(path, new Error('the document is not a JSON object'));
	}

	const features = Array.isArray(record['features']) ? record['features'] : [];
	const annotations: Annotation[] = [];
	for (const element of features) {
		const feature = asRecord(element);
		// An element that is not an object at all has nothing of the user's in it to keep — the same
		// two-case exception `parseLayers` makes, and reachable only from a hand-edited file.
		if (feature === null) continue;
		const id = feature['id'];
		annotations.push({
			// A number id is stringified rather than refused: RFC 7946 permits either, and QGIS writes
			// integers. It goes back out as the string, which is a change of one character in a file
			// that had to be rewritten anyway to gain whatever edit prompted the write.
			id: typeof id === 'string' && id !== '' ? id : typeof id === 'number' ? String(id) : mintId(),
			geometry: readGeometry(feature['geometry']),
			properties: readProperties(feature['properties']),
			...rest(feature, FEATURE_KEYS)
		});
	}

	return { annotations, ...rest(record, COLLECTION_KEYS) };
}

/** One Annotation as its `Feature` object, with the keys in RFC 7946's own order. */
function serialiseAnnotation(annotation: Annotation): Record<string, unknown> {
	const geometry = annotation.geometry;
	return {
		type: 'Feature',
		id: annotation.id,
		// `properties` before `geometry` would also be legal; this order is RFC 7946's examples and
		// what geojson.io writes, so a diff against a file that tool touched stays small.
		properties: annotation.properties,
		geometry:
			geometry === null
				? null
				: geometry.type === 'foreign'
					? geometry.raw
					: { type: geometry.type, coordinates: geometry.coordinates },
		// Last, so a field this build does know always wins over a stale copy of itself — the same
		// ordering rule `serialiseLayer` follows.
		...annotation.unknownFields
	};
}

/**
 * Write an Annotation Layer's `FeatureCollection`.
 *
 * **Tab indented with a trailing newline**, matching `project.json`, the Alignment, and
 * `emptyAnnotationCollection` — so a Workspace kept in git produces diffs a human can read, and so
 * that parsing a file this app wrote and writing it straight back produces the identical bytes.
 * `annotation.browser.test.ts` and `annotation.test.ts` both assert that round trip; `pnpm test:e2e`
 * asserts the same thing on real files in OPFS across a session that only *looked* at them.
 *
 * The one case where the bytes legitimately differ is a document from another tool that had no
 * `Feature` ids: those are minted on read, so writing gains `"id"` members. That is not a silent
 * reformat, because this app never writes an Annotation Layer's file unless an Annotation in it
 * changed — the writer is only reached from a drawing, editing, styling, or deleting action.
 */
export function serialiseAnnotations(collection: AnnotationCollection): Bytes {
	const document = {
		type: 'FeatureCollection',
		features: collection.annotations.map(serialiseAnnotation),
		...collection.unknownFields
	};
	return new TextEncoder().encode(`${JSON.stringify(document, null, '\t')}\n`);
}

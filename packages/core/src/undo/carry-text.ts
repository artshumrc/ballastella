// Carrying typed text across a Step (ADR-0039).
//
// A Step holds byte images, and undo writes one back. Writing it verbatim would also take back the
// words a scholar typed *after* the gesture the Step records — a Layer renamed while a deletion sat
// in the history, an Annotation titled after it was drawn — and typed text is not a Step and is
// never reverted by one (SPEC stories 30–33). So undo writes `carry(image, current)`: the image with
// the values now on disk spliced in, for the entities present in both.
//
// **An entity absent from the image carries nothing**, which is what makes undoing the creation of
// an Annotation take its title and description with it (SPEC story 34) rather than leave it behind
// as a fragment.
//
// One value nobody types is carried too — the chosen Base Map, for the reason given on
// {@link carryProjectText}: no Step records it either, so an image written verbatim would swap the
// backdrop back with the edit.
//
// Both functions are pure and total: whatever is at the path right now — another tool's document, an
// empty file, nothing at all — is a thing undo has to survive, and the answer in every such case is
// the image unchanged. And when nothing actually carries they return the image **byte-identically**,
// which is what keeps SPEC story 54's guarantee true in the ordinary case; re-serialising only when
// something carries is the cost ADR-0039 names.

import type { Annotation, AnnotationProperties } from '../annotation/annotation.js';
import { parseAnnotations, serialiseAnnotations } from '../annotation/geojson.js';
import type { Layer } from '../project/layer.js';
import { parseProjectFile, serialiseProjectFile } from '../project/project-file.js';
import type { Bytes, StorePath } from '../store/project-store.js';

/**
 * The image with the Project's name, each Layer's name and the chosen Base Map taken from what is on
 * disk now, for ids present in both.
 *
 * **The Base Map is carried for the reason the names are**, though nobody types it: it is a choice
 * the scholar made about how to look at the Project rather than an edit to the work, and no Step
 * records it (the Brief puts Base Map choice out of scope for the history, now and later). An image
 * written verbatim would silently swap the backdrop back to whatever was chosen when some earlier
 * gesture happened, and no redo would return it, because the `after` image predates the choice too.
 *
 * Everything else — the stack itself, its order, visibility, opacity, and every field this build
 * carries rather than understands — comes from the image, because that is what undo is reversing.
 */
export function carryProjectText(before: Bytes, current: Bytes | null): Bytes {
	const pair = parsePair(before, current, parseProjectFile);
	if (pair === null) return before;
	const [image, typed] = pair;

	const names = new Map(typed.layers.map((layer) => [layer.id, layer.name]));
	let carried = image.name !== typed.name || image.baseMap !== typed.baseMap;
	const layers: Layer[] = image.layers.map((layer) => {
		const name = names.get(layer.id);
		if (name === undefined || name === layer.name) return layer;
		carried = true;
		return { ...layer, name };
	});

	return carried
		? serialiseProjectFile({ ...image, name: typed.name, baseMap: typed.baseMap, layers })
		: before;
}

/**
 * The image with each Annotation's title and description taken from what is on disk now, for ids
 * present in both. Geometry, style, and every unrecognised property come from the image.
 */
export function carryAnnotationText(before: Bytes, current: Bytes | null): Bytes {
	// Ids are minted per image for a `Feature` that carries none (RFC 7946 §3.2 makes `id`
	// optional), so the two sides are minted under prefixes that cannot collide: an Annotation with
	// no id in the file has no identity to match on, and matching two of them by accident would
	// splice one document's words onto another's shape.
	const pair = parsePair(before, current, (bytes, side) =>
		parseAnnotations(bytes, { path: 'annotations', mintId: sequence(`${side}:`) })
	);
	if (pair === null) return before;
	const [image, typed] = pair;

	const words = new Map(typed.annotations.map((one) => [one.id, one.properties]));
	let carried = false;
	const annotations: Annotation[] = image.annotations.map((one) => {
		const now = words.get(one.id);
		if (now === undefined || !differs(one.properties, now)) return one;
		carried = true;
		return { ...one, properties: withText(one.properties, now) };
	});

	return carried ? serialiseAnnotations({ ...image, annotations }) : before;
}

/**
 * Which rule applies to a path, in **one place**, so a third format later has one place to be added.
 *
 * A path this mapping does not recognise carries nothing and is written verbatim, which is the right
 * answer for an Alignment — its Control Points have no typed text and no ids in the file at all —
 * and for anything else a Step may come to hold.
 */
export function carryAcross(path: StorePath, before: Bytes, current: Bytes | null): Bytes {
	if (basename(path) === 'project.json') return carryProjectText(before, current);
	if (/(^|\/)annotations\/[^/]+\.geojson$/.test(path)) return carryAnnotationText(before, current);
	return before;
}

const basename = (path: StorePath): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Both images parsed, or `null` when there is nothing to carry from — `current` absent, empty, or
 * unreadable, and equally an image this build cannot parse either.
 */
function parsePair<T>(
	before: Bytes,
	current: Bytes | null,
	parse: (bytes: Bytes, side: 'image' | 'current') => T
): [T, T] | null {
	if (current === null || current.byteLength === 0) return null;
	try {
		return [parse(before, 'image'), parse(current, 'current')];
	} catch {
		return null;
	}
}

/** Ids for `Feature`s that carry none, distinct per side and per position. */
function sequence(prefix: string): () => string {
	let next = 0;
	return () => `${prefix}${next++}`;
}

const differs = (image: AnnotationProperties, typed: AnnotationProperties): boolean =>
	image.title !== typed.title || image.description !== typed.description;

/** The image's properties with the two typed fields replaced, absence included. */
function withText(image: AnnotationProperties, typed: AnnotationProperties): AnnotationProperties {
	const properties: Record<string, unknown> = { ...image };
	for (const key of ['title', 'description'] as const) {
		if (typed[key] === undefined) delete properties[key];
		else properties[key] = typed[key];
	}
	return properties as AnnotationProperties;
}

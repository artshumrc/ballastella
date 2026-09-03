// One entry in a Project's ordered stack (CONTEXT.md, Layer).
//
// A Layer **references** its content and carries only how that content is presented — its name,
// whether it is visible, where it sits in the stack, and for a Map Image its opacity. None of
// that may live in the Alignment or in the GeoJSON, which are portability documents that have to
// stand on their own (ADR-0002).
//
// Free of everything editor-only, because `apps/viewer` reads the Layer stack too (ADR-0019).

import type { Bytes } from '../store/project-store.js';

/**
 * The simplestyle-spec 1.1.0 styling properties, plus ADR-0009's one extension.
 *
 * Every field is optional, and that is the point: precedence runs feature `properties` → Layer
 * `defaultStyle` → simplestyle's own defaults (ADR-0009), so an absent property means "fall
 * through" rather than "use zero". Stamping defaults onto everything would produce much larger
 * files that cannot be restyled in bulk.
 *
 * `title` and `description` are deliberately **not** here. They are per-feature content rather than
 * style — a Layer's title is its {@link Layer.name} — and a Layer-wide default description would be
 * prose duplicated onto every feature.
 *
 * Values are carried rather than validated here: the editor's style controls own the conformance of
 * what they write, and the Markdown sanitisation. This slice's job is that a Layer can hold a default
 * style and that reading and writing `project.json` cannot lose it.
 */
export interface SimpleStyle {
	/** `small | medium | large` (ADR-0009). */
	readonly 'marker-size'?: string;
	/** An icon id, `0`–`9`, or `a`–`z`. */
	readonly 'marker-symbol'?: string;
	readonly 'marker-color'?: string;
	/** A **colour**, `#RRGGBB`. Never a line style — ADR-0009 is explicit about not overloading it. */
	readonly stroke?: string;
	readonly 'stroke-opacity'?: number;
	readonly 'stroke-width'?: number;
	readonly fill?: string;
	readonly 'fill-opacity'?: number;
	/** `[dash, gap]`. **Absent means solid** (ADR-0009); there is no keyword form. */
	readonly 'stroke-dasharray'?: readonly [number, number];
}

/**
 * What every Layer carries, whatever its kind: its identity and its presentation.
 *
 * `order` follows the Layer's position in the stack and **0 is the top** — the Layer that draws over
 * everything else — matching the list a user reads and the mental model QGIS, Photoshop, and Google
 * Earth already installed (ADR-0002). Exactly one function knows that drawing runs the other way:
 * {@link drawingOrder}.
 */
interface LayerCommon {
	/** Stable for the life of the Layer. Renaming does not change it, and `geojsonRef` is built from it. */
	readonly id: string;
	/** The user's own words for this Layer, so the list describes their argument. */
	readonly name: string;
	readonly visible: boolean;
	/** Position in the stack; 0 is the top. Kept equal to the array index, so the two cannot drift. */
	readonly order: number;
	/**
	 * Anything else the record carried, kept so that writing it back cannot drop it.
	 *
	 * The same discipline `ProjectFile.unknownFields` applies to the document as a whole (ADR-0010):
	 * a field added to a Layer by a build one commit ahead is not worth destroying, and this is the
	 * one array in `project.json` whose loss is "not one annotation but the map of everything"
	 * (ADR-0017 rule 4).
	 */
	readonly unknownFields?: Readonly<Record<string, unknown>>;
}

/**
 * A Map Image of the Workspace, in this Project's stack.
 *
 * **One field, and everything else is derived from it** (ADR-0023). The Workspace owns where a
 * Map Image sits on the earth, so the Alignment is `alignmentPath(imageId)` and the pyramid is
 * `imageDirectory(imageId)` — both at the Workspace root, both shared by every Project that references
 * this image. A Project owns only how the map is presented: its name for the Layer, whether it is
 * visible, where it sits in the stack, and its opacity.
 *
 * The Layer therefore carries no `alignmentRef` — a second name for a path already derivable, which a
 * hand-edited file could point somewhere else — and no `imageMode`. Whether the tiles are here or on a
 * Library's server is **observable**: the image directory has an `info.json` of ours, or it has only a
 * `remote.json`. A stored flag could disagree with the bytes on disk, and repairing that disagreement
 * is what the deleted interrupted-copy path existed for.
 */
export interface MapLayer extends LayerCommon {
	readonly kind: 'map';
	/** 0–1. Present on this kind alone — see {@link Layer}. */
	readonly opacity: number;
	/** The Workspace Map Image this Layer draws. Referenced, never contained. */
	readonly imageId: string;
}

/** A set of Annotations in the stack. One GeoJSON `FeatureCollection` (ADR-0009). */
export interface AnnotationLayer extends LayerCommon {
	readonly kind: 'annotation';
	/** The `FeatureCollection` this Layer draws, by path within the Project. */
	readonly geojsonRef: string;
}

/**
 * A Layer whose `kind` this build has never heard of, carried rather than interpreted.
 *
 * ADR-0014 records image-space annotation as the expected next feature and asks that the
 * discriminator tolerate a third kind. This is that tolerance made structural: an unknown kind
 * parses into a Layer that can be named, hidden, and reordered like any other, and that serialises
 * back with every field it arrived with — so a build from before the third kind existed can open a
 * colleague's Project, move a label above a map, and save without destroying work it cannot draw.
 *
 * `kind` is the literal `'foreign'` so that narrowing on the discriminator still works; the kind the
 * file actually carried is {@link declaredKind}, which is what gets written back. A future real kind
 * must therefore not be called `'foreign'`.
 */
export interface ForeignLayer extends LayerCommon {
	readonly kind: 'foreign';
	/** The `kind` the file carried. Never one of the kinds this build knows. */
	readonly declaredKind: string;
}

/**
 * One entry in a Project's ordered stack.
 *
 * **A discriminated union narrowed on `kind`, deliberately not one type with a bag of optional
 * fields.** ADR-0002 names the predictable failure of the alternative: someone sets `opacity` on an
 * annotation Layer, observes nothing, and "fixes" it by threading opacity through label rendering
 * that nobody asked for. Here that is a type error, and `layer.test.ts` asserts it stays one.
 *
 * {@link ForeignLayer} is a member so that call sites are made to answer "and what if it is a kind I
 * do not know?" — which is the same question adding a real third kind asks, and the reason adding one
 * is not a wide refactor.
 */
export type Layer = MapLayer | AnnotationLayer | ForeignLayer;

/** Where a Project keeps its Annotation Layers, relative to the Project (ADR-0008). */
export const ANNOTATION_DIRECTORY = 'annotations';

/** An Annotation Layer's `FeatureCollection`, by path within its Project. Its `geojsonRef`. */
export const annotationPath = (layerId: string): string =>
	`${ANNOTATION_DIRECTORY}/${layerId}.geojson`;

/** An Annotation Layer's `FeatureCollection`, by path within the Workspace. */
export const annotationStorePath = (projectDirectory: string, layerId: string): string =>
	`${projectDirectory}/${annotationPath(layerId)}`;

/**
 * The document a new Annotation Layer starts from: an empty `FeatureCollection`.
 *
 * Written when the Layer is created rather than left absent, because a Layer whose `geojsonRef`
 * names nothing is a Project an import refuses — see `assertReferencesPresent`. Tab indented with a
 * trailing newline, matching `project.json` and the Alignment, so a Workspace kept in git produces
 * diffs a human can read. The Annotation editor owns what goes inside it.
 */
export function emptyAnnotationCollection(): Bytes {
	return new TextEncoder().encode(
		`${JSON.stringify({ type: 'FeatureCollection', features: [] }, null, '\t')}\n`
	);
}

/** A new map Layer for a Workspace Map Image. Fully opaque and visible. */
export function newMapLayer(fields: { id: string; name: string; imageId: string }): MapLayer {
	return {
		kind: 'map',
		id: fields.id,
		name: fields.name,
		visible: true,
		order: 0,
		opacity: 1,
		imageId: fields.imageId
	};
}

/** A new, empty Annotation Layer. Its `geojsonRef` is derived from its id, so the two cannot drift. */
export function newAnnotationLayer(fields: { id: string; name: string }): AnnotationLayer {
	return {
		kind: 'annotation',
		id: fields.id,
		name: fields.name,
		visible: true,
		order: 0,
		geojsonRef: annotationPath(fields.id)
	};
}

/**
 * The stack bottom-to-top: the order a renderer adds Layers in, so that the Layer at the top of the
 * list ends up drawn over the ones below it.
 *
 * **The only place that knows drawing runs the other way from the list.** Everything else — the
 * file, the array, the UI, `order` itself — reads top-first, so "above in the list" and "above on the
 * map" are the same word (ADR-0002: an annotation Layer above a map Layer draws above it).
 *
 * Generic over what a stack entry is, because a renderer holds the stack with each Layer's documents
 * already read and must not have to unwrap them to ask this one question — which is how a second
 * reversal, agreeing with this one until somebody edits one of them, gets written.
 */
export function drawingOrder<T>(stack: readonly T[]): readonly T[] {
	return [...stack].reverse();
}

/** The Layer with this id, or `undefined`. */
export function findLayer(layers: readonly Layer[], id: string): Layer | undefined {
	return layers.find((layer) => layer.id === id);
}

/**
 * `layers` with `order` set to each Layer's position, so the stored number and the array can never
 * disagree. Applied by every operation here and by the parser.
 */
function renumber(layers: readonly Layer[]): readonly Layer[] {
	return layers.map((layer, order) => (layer.order === order ? layer : { ...layer, order }));
}

/** `layers` with `change` applied to the one Layer with this id, and the stack renumbered. */
function replace(
	layers: readonly Layer[],
	id: string,
	change: (layer: Layer) => Layer
): readonly Layer[] {
	return renumber(layers.map((layer) => (layer.id === id ? change(layer) : layer)));
}

/** Put a Layer at the top of the stack, where a newly made one belongs. */
export function addLayer(layers: readonly Layer[], layer: Layer): readonly Layer[] {
	return renumber([layer, ...layers]);
}

/** Take a Layer out of the stack. Its referenced file is not this function's business. */
export function removeLayer(layers: readonly Layer[], id: string): readonly Layer[] {
	return renumber(layers.filter((layer) => layer.id !== id));
}

/** Rename a Layer. Every kind can be renamed, including one this build cannot draw. */
export function renameLayer(layers: readonly Layer[], id: string, name: string): readonly Layer[] {
	return replace(layers, id, (layer) => ({ ...layer, name }));
}

/** Show or hide a Layer. */
export function setLayerVisible(
	layers: readonly Layer[],
	id: string,
	visible: boolean
): readonly Layer[] {
	return replace(layers, id, (layer) => ({ ...layer, visible }));
}

/**
 * Set a map Layer's opacity. **A no-op on any other kind**, which is the union doing its job: there
 * is no opacity to set on an annotation Layer, so this cannot quietly invent one.
 */
export function setMapLayerOpacity(
	layers: readonly Layer[],
	id: string,
	opacity: number
): readonly Layer[] {
	const clamped = Math.min(1, Math.max(0, opacity));
	return replace(layers, id, (layer) =>
		layer.kind === 'map' ? { ...layer, opacity: clamped } : layer
	);
}

/**
 * Move a Layer to `toIndex` in the stack, 0 being the top.
 *
 * Out-of-range indices are clamped rather than refused: both the drag and the two buttons ask for a
 * position, and "the top Layer cannot go higher" is a disabled button, not an exception.
 */
export function moveLayer(layers: readonly Layer[], id: string, toIndex: number): readonly Layer[] {
	const from = layers.findIndex((layer) => layer.id === id);
	if (from === -1) return layers;
	const to = Math.min(layers.length - 1, Math.max(0, toIndex));
	if (to === from) return layers;
	const moved = [...layers];
	const [layer] = moved.splice(from, 1);
	if (layer === undefined) return layers;
	moved.splice(to, 0, layer);
	return renumber(moved);
}

/** Move a Layer one place toward the top of the stack, where it draws over more. */
export function moveLayerUp(layers: readonly Layer[], id: string): readonly Layer[] {
	const from = layers.findIndex((layer) => layer.id === id);
	return from === -1 ? layers : moveLayer(layers, id, from - 1);
}

/** Move a Layer one place toward the bottom of the stack. */
export function moveLayerDown(layers: readonly Layer[], id: string): readonly Layer[] {
	const from = layers.findIndex((layer) => layer.id === id);
	return from === -1 ? layers : moveLayer(layers, id, from + 1);
}

const readString = (value: unknown, fallback: string): string =>
	typeof value === 'string' ? value : fallback;

const readNumber = (value: unknown, fallback: number): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const readRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

/** `unknownFields` only when there is something in it, so `exactOptionalPropertyTypes` holds. */
const carried = (rest: Record<string, unknown>): { unknownFields?: Record<string, unknown> } =>
	Object.keys(rest).length === 0 ? {} : { unknownFields: rest };

/**
 * Read the `layers` array of a `project.json`.
 *
 * **Tolerant, and never throws.** A Layer list is the map of everything (ADR-0017 rule 4), so a
 * field that is the wrong type costs that field rather than the Project: a missing `name` reads as
 * empty, a missing `visible` as visible, an out-of-range `opacity` is clamped. A `kind` this build
 * does not know becomes a {@link ForeignLayer} and survives the round trip intact.
 *
 * Three things are dropped, because there is nothing of the user's to keep in any of them: an element
 * that is not an object at all, one with no usable `id`, and one whose `id` a Layer earlier in the
 * file has already taken. An id is how a Layer is *addressed* — by the keyed list that draws the
 * stack, by the MapLibre layer id, by the record the read documents are kept in, and by every
 * operation above — so a Layer without one, or with one that is not its own, is a row this app can
 * neither draw nor point at. The duplicate is the sharper of the two: a keyed list given the same key
 * twice raises a hard error, which is precisely what this function promises never to do. All three can
 * only come from a hand-edited or damaged file.
 *
 * The stack is sorted by `order` and renumbered from it, so the array position and the stored number
 * agree from the first read. Sorting is stable on the file's own order, which is what a file written
 * by this app already carries — and it happens *after* the duplicate is dropped, so which of the two
 * survives is decided by the file's own order rather than by the `order` the impostor claims.
 */
export function parseLayers(raw: unknown): readonly Layer[] {
	if (!Array.isArray(raw)) return [];

	const seen = new Set<string>();
	const read: { layer: Layer; at: number; order: number }[] = [];
	for (const [at, element] of raw.entries()) {
		const record = readRecord(element);
		if (record === null) continue;
		const id = readString(record['id'], '');
		if (id === '' || seen.has(id)) continue;
		seen.add(id);
		read.push({ layer: parseLayer(record, id), at, order: readNumber(record['order'], at) });
	}

	read.sort((a, b) => a.order - b.order || a.at - b.at);
	return renumber(read.map(({ layer }) => layer));
}

/** The fields every Layer has, which are read into {@link LayerCommon} rather than carried. */
const COMMON_KEYS: readonly string[] = ['kind', 'id', 'name', 'visible', 'order'];

function parseLayer(record: Readonly<Record<string, unknown>>, id: string): Layer {
	const kind = record['kind'];
	const rest = Object.fromEntries(
		Object.entries(record).filter(([key]) => !COMMON_KEYS.includes(key))
	);
	const common = {
		id,
		name: readString(record['name'], ''),
		// Absent reads as visible: the Layer is in the stack, and a Project whose Layers all vanished
		// because a field was missing looks exactly like a Project that lost its content.
		visible: record['visible'] !== false,
		order: 0
	};

	if (kind === 'map') {
		const { opacity, imageId, ...carriedRest } = rest;
		return {
			...common,
			kind: 'map',
			opacity: Math.min(1, Math.max(0, readNumber(opacity, 1))),
			// An absent or non-string `imageId` reads as `''`, which is the same tolerance every other
			// field here gets: the Layer stays in the stack, nameable and reorderable, rather than the
			// Project failing to open over one field (ADR-0017 rule 4). A Layer with `''` draws nothing,
			// and `assertReferencesPresent` skips it for the same reason it skips an empty `geojsonRef` —
			// there is no image it could be asked for.
			imageId: readString(imageId, ''),
			...carried(carriedRest)
		};
	}

	if (kind === 'annotation') {
		const { geojsonRef, ...carriedRest } = rest;
		return {
			...common,
			kind: 'annotation',
			geojsonRef: readString(geojsonRef, ''),
			// **`defaultStyle` is not named here any more, and that is deliberate.** A Layer no longer
			// has one (ADR-0009, as amended): style lives on each Annotation, put there when it is
			// drawn. A Project written by an earlier build still has the field, and it falls through to
			// `carried` like any other value this build does not interpret — so opening such a Project
			// preserves it byte for byte instead of deleting a user's data, and nothing here has to
			// rewrite a file that was only looked at (ADR-0010). Its Annotations draw with simplestyle's
			// own defaults where they set nothing themselves, which is the appearance change the
			// amendment accepts.
			...carried(carriedRest)
		};
	}

	return {
		...common,
		kind: 'foreign',
		declaredKind: readString(kind, ''),
		...carried(rest)
	};
}

/**
 * Write one Layer back.
 *
 * **What keeps a carried field from shadowing an edited one is `carried` upstream, not the spread
 * order here.** `unknownFields` is spread last — so were a collision ever possible the stale copy
 * would win — and it is safe only because {@link COMMON_KEYS} plus each kind's own destructuring mean
 * no key this function writes can ever reach `unknownFields` in the first place. `layer.test.ts`
 * asserts that invariant directly, because it is the thing a future author breaks: add a field to
 * {@link LayerCommon} without adding it to `COMMON_KEYS`, or to a kind without destructuring it out,
 * and the carried copy starts winning over the edited one. `unknownFields` is nonetheless kept last
 * so that a {@link ForeignLayer}'s fields are written in the order the file had them.
 */
function serialiseLayer(layer: Layer): Record<string, unknown> {
	const common = {
		id: layer.id,
		name: layer.name,
		visible: layer.visible,
		order: layer.order
	};
	switch (layer.kind) {
		case 'map':
			return {
				kind: 'map',
				...common,
				opacity: layer.opacity,
				imageId: layer.imageId,
				...layer.unknownFields
			};
		case 'annotation':
			return {
				kind: 'annotation',
				...common,
				geojsonRef: layer.geojsonRef,
				// A `defaultStyle` written by an earlier build is in `unknownFields` and is written back
				// from there, untouched (ADR-0009 as amended, ADR-0010).
				...layer.unknownFields
			};
		// No `default:` and no exhaustiveness assertion. A fourth kind added to the union lands here
		// as a compile error in this one function — which is the module that writes Layers, exactly
		// where ADR-0014 wants the cost of a new kind to fall — rather than being silently written as
		// a foreign Layer at runtime.
		case 'foreign':
			return { kind: layer.declaredKind, ...common, ...layer.unknownFields };
	}
}

/** Write the `layers` array of a `project.json`, in stack order with the top first. */
export function serialiseLayers(layers: readonly Layer[]): unknown[] {
	return layers.map(serialiseLayer);
}

import { needleOrdinal, needleSvg } from '@ballastella/core/render';
import { Marker, type LngLatLike, type Map as MapLibreMap } from 'maplibre-gl';

type OverlayPointKind =
	| 'reference'
	| 'reported'
	| 'control-point'
	| 'mask-vertex'
	| 'mask-edge'
	| 'annotation-vertex'
	| 'annotation-draft';

const INTERACTIVE_KINDS: ReadonlySet<OverlayPointKind> = new Set<OverlayPointKind>([
	'control-point',
	'mask-vertex',
	'mask-edge',
	'annotation-vertex'
]);

const NUDGE_PIXELS = 1;
const NUDGE_PIXELS_FAST = 20;

const anchorFor = (kind: OverlayPointKind): 'center' | 'bottom' =>
	kind === 'control-point' ? 'bottom' : 'center';

export type OverlayPoint<TPoint> = {
	key?: string;
	point: TPoint;
	label: string;
	kind: OverlayPointKind;
	ordinal?: number;
	glyph?: string;
	selected?: boolean;
	pending?: boolean;
	onmoveend?: (to: TPoint) => void;
	onmove?: (to: TPoint) => void;
	onselect?: () => void;
	ondelete?: () => void;
};

export interface OverlayPointLayerOptions<TPoint> {
	map: MapLibreMap;
	toLngLat: (point: TPoint) => LngLatLike;
	fromLngLat: (lngLat: { lng: number; lat: number }) => TPoint;
	datasetFor?: (point: TPoint) => Record<string, string>;
}

export interface OverlayPointLayer<TPoint> {
	update(points: readonly OverlayPoint<TPoint>[]): void;
	destroy(): void;
}

interface Handle<TPoint> {
	readonly marker: Marker;
	readonly element: HTMLElement;
	current: OverlayPoint<TPoint>;
	readonly ordinalSlot?: SVGTextElement | null;
	moving: boolean;
}

export function createOverlayPointLayer<TPoint>(
	options: OverlayPointLayerOptions<TPoint>
): OverlayPointLayer<TPoint> {
	const { map, toLngLat, fromLngLat, datasetFor } = options;
	const handles = new Map<string, Handle<TPoint>>();
	const positionOf = (handle: Handle<TPoint>): TPoint => fromLngLat(handle.marker.getLngLat());

	const nudge = (handle: Handle<TPoint>, dx: number, dy: number): void => {
		const at = map.project(handle.marker.getLngLat());
		const to = fromLngLat(map.unproject([at.x + dx, at.y + dy]));
		handle.marker.setLngLat(toLngLat(to));
		handle.moving = true;
		handle.current.onmove?.(to);
	};

	const endMove = (handle: Handle<TPoint>): void => {
		if (!handle.moving) return;
		handle.moving = false;
		handle.current.onmoveend?.(positionOf(handle));
	};

	const paint = (handle: Handle<TPoint>, point: OverlayPoint<TPoint>): void => {
		handle.current = point;
		const { element } = handle;
		const interactive = INTERACTIVE_KINDS.has(point.kind);

		handle.marker.setDraggable(Boolean(point.onmoveend));

		element.classList.add('pane-overlay-point', `pane-overlay-point-${point.kind}`);
		element.classList.toggle('pane-overlay-point-selected', Boolean(point.selected));
		element.classList.toggle('pane-overlay-point-pending', Boolean(point.pending));
		element.dataset.testid = `pane-overlay-point-${point.kind}`;
		element.dataset.selected = point.selected ? 'true' : 'false';
		element.dataset.pending = point.pending ? 'true' : 'false';

		if (point.ordinal === undefined) delete element.dataset.ordinal;
		else element.dataset.ordinal = String(point.ordinal);

		for (const [name, value] of Object.entries(datasetFor?.(point.point) ?? {})) {
			element.dataset[name] = value;
		}

		if (interactive) {
			const written = point.ordinal === undefined ? (point.glyph ?? '') : String(point.ordinal);
			if (handle.ordinalSlot) handle.ordinalSlot.textContent = written;
			else element.textContent = written;
			element.setAttribute('aria-label', point.label);
			if (point.kind === 'control-point') {
				element.setAttribute('aria-pressed', point.selected ? 'true' : 'false');
			} else {
				element.removeAttribute('aria-pressed');
			}
			element.removeAttribute('aria-hidden');
			element.removeAttribute('title');
		} else {
			element.title = point.label;
			element.setAttribute('aria-hidden', 'true');
		}
	};

	const create = (point: OverlayPoint<TPoint>): Handle<TPoint> => {
		const interactive = INTERACTIVE_KINDS.has(point.kind);
		const element = document.createElement(interactive ? 'button' : 'div');
		const needle = point.kind === 'control-point' ? needleSvg(document) : null;
		if (needle) element.append(needle);
		const handle: Handle<TPoint> = {
			marker: new Marker({ element, anchor: anchorFor(point.kind) }),
			element,
			ordinalSlot: needle && needleOrdinal(needle),
			current: point,
			moving: false
		};

		if (interactive) {
			const button = element as HTMLButtonElement;
			button.type = 'button';

			button.addEventListener('click', (event) => {
				event.stopPropagation();
				handle.current.onselect?.();
			});

			button.addEventListener('keydown', (event) => {
				const fast = event.shiftKey ? NUDGE_PIXELS_FAST : NUDGE_PIXELS;
				const step: Record<string, [number, number]> = {
					ArrowLeft: [-fast, 0],
					ArrowRight: [fast, 0],
					ArrowUp: [0, -fast],
					ArrowDown: [0, fast]
				};
				const delta = step[event.key];
				if (delta) {
					event.preventDefault();
					event.stopPropagation();
					nudge(handle, delta[0], delta[1]);
					return;
				}
				if (event.key === 'Delete' || event.key === 'Backspace') {
					event.preventDefault();
					event.stopPropagation();
					handle.current.ondelete?.();
				}
			});

			button.addEventListener('keyup', (event) => {
				if (event.key.startsWith('Arrow')) endMove(handle);
			});
			button.addEventListener('blur', () => endMove(handle));
		}

		handle.marker.on('dragstart', () => {
			handle.moving = true;
		});
		handle.marker.on('drag', () => handle.current.onmove?.(positionOf(handle)));
		handle.marker.on('dragend', () => endMove(handle));

		paint(handle, point);
		handle.marker.setLngLat(toLngLat(point.point)).addTo(map);
		return handle;
	};

	const restoreFocus = (
		removedKey: string,
		removedKind: OverlayPointKind,
		orderBefore: readonly string[]
	): void => {
		const survivingOfSameKind = (keys: readonly string[]): HTMLElement | undefined => {
			for (const key of keys) {
				const handle = handles.get(key);
				if (handle && handle.current.kind === removedKind) return handle.element;
			}
			return undefined;
		};

		const at = orderBefore.indexOf(removedKey);
		const after = at < 0 ? [] : orderBefore.slice(at + 1);
		const before = at < 0 ? [] : orderBefore.slice(0, at).reverse();
		const next = survivingOfSameKind(after) ?? survivingOfSameKind(before);
		(next ?? map.getCanvas()).focus();
	};

	return {
		update(points) {
			const seen = new Set<string>();
			const orderBefore = [...handles.keys()];

			points.forEach((point, index) => {
				const key = point.key ?? `${point.kind}:${index}`;
				seen.add(key);
				const handle = handles.get(key);
				if (!handle) {
					handles.set(key, create(point));
					return;
				}
				if (!handle.moving) handle.marker.setLngLat(toLngLat(point.point));
				paint(handle, point);
			});

			let hadFocus: { key: string; kind: OverlayPointKind } | undefined;
			for (const [key, handle] of handles) {
				if (seen.has(key)) continue;
				if (handle.element.contains(document.activeElement)) {
					hadFocus = { key, kind: handle.current.kind };
				}
				handle.marker.remove();
				handles.delete(key);
			}

			if (hadFocus) restoreFocus(hadFocus.key, hadFocus.kind, orderBefore);
		},

		destroy() {
			for (const handle of handles.values()) handle.marker.remove();
			handles.clear();
		}
	};
}

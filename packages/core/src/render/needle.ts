export const NEEDLE_GRID = 24;
export const NEEDLE_HEAD = { cx: 12, cy: 8.25, r: 6.5 } as const;
export const NEEDLE_SHAFT = { width: 3.6, top: 12 } as const;
const NEEDLE_PIXELS = 34;

export const NEEDLE_HEAD_PATH = ((): string => {
	const { cx, cy, r } = NEEDLE_HEAD;
	const across = r * 2;
	return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${across} 0 ${r} ${r} 0 1 0-${across} 0Z`;
})();

export const NEEDLE_SHAFT_PATH = ((): string => {
	const { cx } = NEEDLE_HEAD;
	const { width, top } = NEEDLE_SHAFT;
	const [left, right] = [cx - width / 2, cx + width / 2];
	return `M${left} ${top} ${right} ${top} ${right} ${NEEDLE_GRID} ${left} ${NEEDLE_GRID}Z`;
})();

const NEEDLE_PART = {
	halo: 'needle-halo',
	body: 'needle-body',
	ordinal: 'needle-ordinal'
} as const;

export function needleSvg(document: Document): SVGSVGElement {
	const namespace = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(namespace, 'svg');
	svg.setAttribute('viewBox', `0 0 ${NEEDLE_GRID} ${NEEDLE_GRID}`);
	svg.setAttribute('width', String(NEEDLE_PIXELS));
	svg.setAttribute('height', String(NEEDLE_PIXELS));
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');

	for (const part of [NEEDLE_PART.halo, NEEDLE_PART.body]) {
		for (const d of [NEEDLE_HEAD_PATH, NEEDLE_SHAFT_PATH]) {
			const path = document.createElementNS(namespace, 'path');
			path.setAttribute('d', d);
			path.setAttribute('class', part);
			svg.append(path);
		}
	}

	const text = document.createElementNS(namespace, 'text');
	text.setAttribute('class', NEEDLE_PART.ordinal);
	text.setAttribute('x', String(NEEDLE_HEAD.cx));
	text.setAttribute('y', String(NEEDLE_HEAD.cy));
	text.setAttribute('text-anchor', 'middle');
	text.setAttribute('dominant-baseline', 'central');
	svg.append(text);
	return svg;
}

export const needleOrdinal = (svg: SVGSVGElement): SVGTextElement | null =>
	svg.querySelector(`.${NEEDLE_PART.ordinal}`);

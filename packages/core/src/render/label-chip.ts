import { sdfImage } from './pin-icon.js';

export const LABEL_CHIP_IMAGE_ID = 'ballastella-label-chip';
export const LABEL_CHIP_PIXEL_RATIO = 2;
const CORNER_RADIUS = 16;
const SPREAD = 8 * LABEL_CHIP_PIXEL_RATIO;
const EDGE_ALPHA = 192 / 256;
const MARGIN = Math.ceil(EDGE_ALPHA * SPREAD);
const FLAT = 16;
const SIZE = 2 * (MARGIN + CORNER_RADIUS) + FLAT;

export const LABEL_CHIP_CONTENT: readonly [number, number, number, number] = [
	MARGIN + CORNER_RADIUS,
	MARGIN + CORNER_RADIUS,
	MARGIN + CORNER_RADIUS + FLAT,
	MARGIN + CORNER_RADIUS + FLAT
];

export const LABEL_CHIP_STRETCH: readonly (readonly [number, number])[] = [
	[MARGIN + CORNER_RADIUS, MARGIN + CORNER_RADIUS + FLAT]
];

export const LABEL_CHIP_PADDING: readonly [number, number, number, number] = [4, 8, 4, 8];

export const LABEL_TEXT_SIZE: Record<'small' | 'medium' | 'large', number> = {
	small: 12,
	medium: 16,
	large: 22
};

export function roundedBoxDistance(
	x: number,
	y: number,
	halfWidth: number,
	halfHeight: number,
	radius: number
): number {
	const dx = Math.max(Math.abs(x) - halfWidth + radius, 0);
	const dy = Math.max(Math.abs(y) - halfHeight + radius, 0);
	return radius - Math.hypot(dx, dy);
}

export function chipAlpha(size = SIZE, radius = CORNER_RADIUS, margin = MARGIN): Uint8ClampedArray {
	const alpha = new Uint8ClampedArray(size * size);
	const half = size / 2;
	const halfExtent = half - margin;
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const signed = roundedBoxDistance(
				x + 0.5 - half,
				y + 0.5 - half,
				halfExtent,
				halfExtent,
				radius
			);
			alpha[y * size + x] = Math.round((EDGE_ALPHA + signed / SPREAD) * 255);
		}
	}
	return alpha;
}

export const labelChipImage = (): { width: number; height: number; data: Uint8ClampedArray } =>
	sdfImage(chipAlpha(), SIZE);

import type { DistortionRamp } from '../alignment/distortion.js';

type RampColours = DistortionRamp & { renderGridColor: string };

const SOURCES: Readonly<Record<keyof RampColours, readonly [string, string]>> = {
	distortionColor00: ['--color-warning', '#f59e0b'],
	distortionColor01: ['--color-info', '#3b82f6'],
	distortionColor1: ['--color-success', '#22c55e'],
	distortionColor2: ['--color-accent', '#a855f7'],
	distortionColor3: ['--color-error', '#ef4444'],
	renderGridColor: ['--color-base-content', '#111111']
};

export const distortionRamp = (): RampColours =>
	Object.fromEntries(
		Object.entries(SOURCES).map(([key, [variable, fallback]]) => [
			key,
			themeColour(variable) || fallback
		])
	) as Record<keyof RampColours, string>;

// daisyUI publishes `oklch()` and the renderer takes hex, so a canvas pixel does the conversion.
export function themeColour(variable: string): string {
	if (typeof document === 'undefined') return '';
	const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
	if (raw === '') return '';
	const canvas = document.createElement('canvas');
	canvas.width = 1;
	canvas.height = 1;
	const context = canvas.getContext('2d');
	if (!context) return '';

	const paint = (from: string): string => {
		context.fillStyle = from;
		context.fillStyle = raw;
		context.clearRect(0, 0, 1, 1);
		context.fillRect(0, 0, 1, 1);
		const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
		const channel = (value: number) => value.toString(16).padStart(2, '0');
		return `#${channel(red)}${channel(green)}${channel(blue)}`;
	};

	// An unparseable value leaves the seed in place, so two different seeds expose it.
	const first = paint('#ff00ff');
	return first === paint('#00ff00') ? first : '';
}

import type { BaseMapFlavorName } from './entry.js';
import { asRecord } from '../store/project-store.js';
import type { ThemeScheme } from '../theme.js';

export type BaseMapAppearance = {
	readonly streets: boolean;
	readonly relief: boolean;
	readonly highContrast: boolean;
	readonly imagery: boolean;
};

export const DEFAULT_BASE_MAP_APPEARANCE: BaseMapAppearance = Object.freeze({
	streets: true,
	relief: false,
	highContrast: false,
	imagery: false
});

export const PROJECT_BASE_MAP_APPEARANCE_KEY = 'baseMapAppearance';

export function isDefaultAppearance(appearance: BaseMapAppearance): boolean {
	return (Object.keys(DEFAULT_BASE_MAP_APPEARANCE) as (keyof BaseMapAppearance)[]).every(
		(name) => appearance[name] === DEFAULT_BASE_MAP_APPEARANCE[name]
	);
}

export function appearanceFrom(value: unknown): BaseMapAppearance | null {
	const fields = asRecord(value);
	if (fields === null) return null;
	const flag = (field: unknown) => (typeof field === 'boolean' ? field : null);
	const streets = flag(fields.streets);
	const relief = flag(fields.relief);
	// `muted` is the name `highContrast` shipped under.
	const highContrast = flag(fields.highContrast) ?? flag(fields.muted);
	const imagery = flag(fields.imagery);
	if (streets === null && relief === null && highContrast === null && imagery === null) return null;
	const fallback = DEFAULT_BASE_MAP_APPEARANCE;
	return {
		streets: streets ?? fallback.streets,
		relief: relief ?? fallback.relief,
		highContrast: highContrast ?? fallback.highContrast,
		imagery: imagery ?? fallback.imagery
	};
}

export function drawnAppearance(appearance: BaseMapAppearance): BaseMapAppearance {
	return appearance.imagery && appearance.highContrast
		? { ...appearance, highContrast: false }
		: appearance;
}

export function baseMapFlavorName(
	appearance: BaseMapAppearance,
	scheme: ThemeScheme
): BaseMapFlavorName {
	if (appearance.highContrast) return scheme === 'dark' ? 'black' : 'white';
	return scheme === 'dark' ? 'dark' : 'light';
}

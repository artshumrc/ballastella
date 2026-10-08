import {
	appearanceFrom,
	DEFAULT_BASE_MAP_APPEARANCE,
	PROJECT_BASE_MAP_APPEARANCE_KEY,
	type BaseMapAppearance
} from './appearance.js';
import { asRecord } from '../store/project-store.js';

export const PROJECT_BASE_MAP_KEY = 'baseMap';

const RETIRED_BASE_MAP_APPEARANCES: Readonly<Record<string, BaseMapAppearance>> = Object.freeze({
	streets: DEFAULT_BASE_MAP_APPEARANCE,
	physical: { ...DEFAULT_BASE_MAP_APPEARANCE, streets: false },
	topographic: { ...DEFAULT_BASE_MAP_APPEARANCE, relief: true },
	muted: { ...DEFAULT_BASE_MAP_APPEARANCE, highContrast: true }
});

type BaseMapChoice = {
	readonly id: string | null;
	readonly appearance: BaseMapAppearance;
};

export function readBaseMapChoice(document: unknown): BaseMapChoice {
	const fields = asRecord(document) ?? {};
	const value = fields[PROJECT_BASE_MAP_KEY];
	const recorded = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
	const retired = recorded === null ? undefined : RETIRED_BASE_MAP_APPEARANCES[recorded];
	return {
		id: retired === undefined ? recorded : null,
		appearance:
			appearanceFrom(fields[PROJECT_BASE_MAP_APPEARANCE_KEY]) ??
			retired ??
			DEFAULT_BASE_MAP_APPEARANCE
	};
}

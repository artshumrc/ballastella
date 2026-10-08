import { asRecord } from '../store/project-store.js';
import { appearanceFrom, type BaseMapAppearance } from './appearance.js';

export const BASE_MAP_PREFERENCE_PREFIX = 'ballastella.baseMap';

export function baseMapPreferenceKey(siteUrl: string): string {
	return `${BASE_MAP_PREFERENCE_PREFIX}:${siteIdentity(siteUrl)}`;
}

function siteIdentity(siteUrl: string): string {
	let url: URL;
	try {
		url = new URL(siteUrl);
	} catch {
		return siteUrl;
	}
	const path = url.pathname.replace(/index\.html$/, '');
	return `${url.origin}${path.endsWith('/') ? path : `${path}/`}`;
}

export type PreferenceStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

export type ReaderBaseMapPreference = {
	readonly entryId: string | null;
	readonly appearance: BaseMapAppearance | null;
};

const NOTHING_CHOSEN: ReaderBaseMapPreference = Object.freeze({ entryId: null, appearance: null });

export function readBaseMapPreference(
	storage: PreferenceStorage | null | undefined,
	siteUrl: string
): ReaderBaseMapPreference {
	if (!storage) return NOTHING_CHOSEN;
	let fields: Record<string, unknown> | null;
	try {
		fields = asRecord(JSON.parse(storage.getItem(baseMapPreferenceKey(siteUrl)) ?? 'null'));
	} catch {
		return NOTHING_CHOSEN;
	}
	if (fields === null) return NOTHING_CHOSEN;
	const entryId = typeof fields.entryId === 'string' ? fields.entryId.trim() : '';
	return {
		entryId: entryId === '' ? null : entryId,
		appearance: appearanceFrom(fields.appearance)
	};
}

export function writeBaseMapPreference(
	storage: PreferenceStorage | null | undefined,
	siteUrl: string,
	preference: ReaderBaseMapPreference
): boolean {
	if (!storage) return false;
	try {
		storage.setItem(
			baseMapPreferenceKey(siteUrl),
			JSON.stringify({
				...(preference.entryId === null ? {} : { entryId: preference.entryId }),
				...(preference.appearance === null ? {} : { appearance: { ...preference.appearance } })
			})
		);
		return true;
	} catch {
		return false;
	}
}

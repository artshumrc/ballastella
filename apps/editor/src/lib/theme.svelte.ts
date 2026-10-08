import { DEFAULT_DARK_THEME, DEFAULT_THEME, isTheme, type Theme } from '@ballastella/core';
import { applyThemeToDocument as applyToDocument, systemTheme } from '@ballastella/ui';

import { readItem, writeItem } from './browser-storage.js';

const STORAGE_KEY = 'ballastella.theme.v2';
const LEGACY_STORAGE_KEY = 'ballastella.theme';

class ThemeSignal {
	#chosen = $state.raw<Theme | null>(null);
	#system = $state.raw<Theme>(DEFAULT_THEME);
	#started = false;

	get current(): Theme {
		return this.#chosen ?? this.#system;
	}

	set current(next: Theme) {
		this.#chosen = next;
		writeItem('localStorage', STORAGE_KEY, next);
		applyToDocument(next);
	}

	start(): () => void {
		if (this.#started) return () => undefined;
		this.#started = true;
		this.#chosen = remembered();

		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
			applyToDocument(this.current);
			return () => undefined;
		}

		const query = window.matchMedia('(prefers-color-scheme: dark)');
		this.#system = systemTheme(query.matches);
		const onchange = (event: MediaQueryListEvent): void => {
			this.#system = systemTheme(event.matches);
			applyToDocument(this.current);
		};
		query.addEventListener('change', onchange);
		applyToDocument(this.current);
		return () => {
			query.removeEventListener('change', onchange);
			this.#started = false;
		};
	}
}

function remembered(): Theme | null {
	const stored = readItem('localStorage', STORAGE_KEY);
	if (stored !== null && isTheme(stored)) return stored;
	const legacy = readItem('localStorage', LEGACY_STORAGE_KEY);
	if (legacy === 'light') return DEFAULT_THEME;
	if (legacy === 'dark') return DEFAULT_DARK_THEME;
	return null;
}

export const theme = new ThemeSignal();

import { applyThemeToDocument, systemTheme } from '@ballastella/ui';
import type { Theme } from '@ballastella/core';

// Read once and never persisted: the Reader's remembered choice is the Base Map.
class ThemeSignal {
	#current = $state<Theme>(
		systemTheme(
			typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
		)
	);

	get current(): Theme {
		return this.#current;
	}

	set current(next: Theme) {
		this.#current = next;
		applyThemeToDocument(next);
	}
}

export const theme = new ThemeSignal();
export const startTheme = (): void => applyThemeToDocument(theme.current);

import { otherTheme, type Theme } from '@ballastella/core';

/**
 * The one theme signal.
 *
 * ADR-0016 requires that a single source of truth drive both the UI and the Base Map flavor,
 * "not two independent toggles that happen to agree". This module is that source: it owns the
 * current theme, and it owns setting `data-theme` on the document, so there is no way to change
 * the interface's appearance without the map hearing about it in the same action.
 *
 * The Base Map side reads `theme.current` inside an effect. Nothing else stores a theme.
 */
class ThemeSignal {
	#current = $state<Theme>(preferredTheme());

	get current(): Theme {
		return this.#current;
	}

	set current(next: Theme) {
		this.#current = next;
		applyToDocument(next);
	}

	toggle(): void {
		this.current = otherTheme(this.#current);
	}
}

/**
 * The reader's own preference, which is the right starting point and costs nothing. Persistence
 * is not in this slice; ADR-0020's `localStorage` rules are about the Reader's Base Map choice in
 * a published site (ticket 17), and a theme preference is not Project data either way.
 */
function preferredTheme(): Theme {
	if (typeof window === 'undefined') return 'light';
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyToDocument(theme: Theme): void {
	if (typeof document === 'undefined') return;
	// daisyUI ships `light` and `dark` and selects on `data-theme` (ADR-0016).
	document.documentElement.dataset.theme = theme;
}

export const theme = new ThemeSignal();

/**
 * Put the initial theme on the document. Called once from the pane rather than from the module
 * body, because a module body runs during prerendering too, where there is no document.
 */
export function startTheme(): void {
	applyToDocument(theme.current);
}

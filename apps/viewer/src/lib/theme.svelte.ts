import { otherTheme, type Theme } from '@ballastella/core';

/**
 * The one theme signal, on the Published Site.
 *
 * ADR-0016 requires that a single source of truth drive both the interface and the Base Map flavor,
 * "not two independent toggles that happen to agree". This module is that source: it owns the current
 * theme and it owns setting `data-theme` on the document, so there is no way to change the interface's
 * appearance without the map hearing about it in the same action — which is what stops a dark interface
 * framing a white map. The Base Map side reads `theme.current` inside an effect.
 *
 * The editor has a module of the same name, and they are deliberately not shared — but they are no
 * longer the same shape, and the difference is the point. What is shared is the thing worth sharing:
 * `otherTheme` and the flavor-per-theme mapping inside each catalog entry, both in `core`. The *rule*
 * that matters — that one signal drives both surfaces — is a rule about there being exactly one of
 * these per app, which a shared module would not make any truer.
 *
 * **This one is four lines of state over a `data-theme` attribute; the editor's is not.** The
 * editor's carries three states, a `localStorage` preference and a live `prefers-color-scheme`
 * listener, because an author works in that window for hours and a desktop that switches to dark at
 * sunset has to move it. This module reads the media query **once, at construction**, and that is a
 * deliberate difference rather than the bug the editor fixed: a Reader has no stored preference to
 * respect and no long session to be interrupted in, so the only state is "what the machine asked for
 * when the page loaded" plus whatever they toggle while reading. If a Reader is ever given a
 * remembered theme, this is where the live listener has to arrive with it.
 *
 * A Reader's theme is **not** persisted. The Base Map choice is the one thing a Published Site
 * remembers — see the `localStorage` note in `routes/+page.svelte` — and the starting point below
 * costs nothing and is already the reader's own: the operating system's setting.
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
 * Put the initial theme on the document. Called once from a mounted component rather than from the
 * module body, because a module body runs during prerendering too, where there is no document.
 */
export function startTheme(): void {
	applyToDocument(theme.current);
}

import { otherTheme, type Theme } from '@ballastella/core';

/**
 * Where an explicit choice is kept.
 *
 * A theme is not Project data and never goes near a Workspace: it is a property of this person at
 * this browser, so it belongs in `localStorage` and not in `project.json`, where it would travel in
 * a backup and change a colleague's interface on restore.
 *
 * `ballastella.<thing>`, which is this app's one `localStorage` naming pattern — see
 * `remote-iiif/lookup-setting.svelte.ts`. **No app segment**, because there is nothing to tell
 * apart: the Published Site's `ThemeSignal` deliberately persists nothing at all, and the one
 * Reader preference that *is* persisted is scoped by ADR-0020's origin-and-path keying rather than
 * by a name. A segment here would be guarding against a collision that cannot happen.
 */
const STORAGE_KEY = 'ballastella.theme';

/**
 * The one theme signal.
 *
 * ADR-0016 requires that a single source of truth drive both the UI and the Base Map flavor,
 * "not two independent toggles that happen to agree". This module is that source: it owns the
 * current theme, and it owns setting `data-theme` on the document, so there is no way to change
 * the interface's appearance without the map hearing about it in the same action.
 *
 * The Base Map side reads `theme.current` inside an effect. Nothing else stores a theme.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THREE STATES BEHIND A TWO-STATE CONTROL
 *
 * The visible control has two positions, but there are three states, and the third is the one that
 * makes the tool feel like part of the machine rather than a thing with an opinion:
 *
 * - explicit `light` — chosen, kept across visits
 * - explicit `dark` — chosen, kept across visits
 * - **unset — follows the operating system, live**
 *
 * "Live" is the whole of it, and it is why {@link #system} is a `$state` fed by the media query's
 * `change` event rather than a value read once at construction. A desktop that switches to dark at
 * sunset, or an accessibility setting changed in another window, moves this app *while it is open*.
 * Reading `matchMedia(...).matches` once — which is what this did — respects the preference only
 * for people who reload, and a scholar mid-alignment does not reload.
 *
 * The first click writes an explicit preference and stops following the OS. There is deliberately
 * no third position to get back to "follow my system": it would be a control nobody could name, and
 * clearing site data is the honest way out.
 */
class ThemeSignal {
	/** An explicit choice, or `null` while the operating system is being followed. */
	#chosen = $state.raw<Theme | null>(null);
	/** What the operating system currently asks for. Updated by the media query's `change` event. */
	#system = $state.raw<Theme>('light');
	/** So a second `startTheme()` — a second layout mount in a test — does not add a second listener. */
	#started = false;

	get current(): Theme {
		return this.#chosen ?? this.#system;
	}

	set current(next: Theme) {
		this.#chosen = next;
		remember(next);
		applyToDocument(next);
	}

	toggle(): void {
		this.current = otherTheme(this.current);
	}

	/**
	 * Adopt the stored choice, start following the operating system, and paint the document.
	 *
	 * Returns its own teardown, for the effect in the root layout that calls it.
	 */
	start(): () => void {
		if (this.#started) return () => undefined;
		this.#started = true;
		this.#chosen = remembered();

		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
			applyToDocument(this.current);
			return () => undefined;
		}

		const query = window.matchMedia('(prefers-color-scheme: dark)');
		this.#system = query.matches ? 'dark' : 'light';
		const onchange = (event: MediaQueryListEvent): void => {
			this.#system = event.matches ? 'dark' : 'light';
			// Writes the *effective* theme, which is the chosen one when there is a choice — so an OS
			// change with an explicit preference in force repaints nothing.
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

/**
 * The stored choice, or `null`.
 *
 * Anything that is not one of the two themes is `null` rather than an error: `localStorage` is
 * shared with every other script on the origin and with this app's own past versions, and a value
 * nobody recognises means "no choice has been made", which is a state this already handles.
 */
function remembered(): Theme | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		return stored === 'light' || stored === 'dark' ? stored : null;
	} catch {
		// Private-mode Safari and a blocked-storage policy both throw here. A theme that does not
		// survive the visit is a far smaller loss than a page that will not render.
		return null;
	}
}

function remember(theme: Theme): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(STORAGE_KEY, theme);
	} catch {
		// Same, and the same answer.
	}
}

function applyToDocument(theme: Theme): void {
	if (typeof document === 'undefined') return;
	// daisyUI ships `light` and `dark` and selects on `data-theme` (ADR-0016).
	document.documentElement.dataset.theme = theme;
}

export const theme = new ThemeSignal();

/**
 * Put the theme on the document and keep it there.
 *
 * Called once, from the **root layout** — not from a route. A per-route call was three calls that
 * had to agree, and any route that forgot one rendered with whatever `data-theme` the last page
 * happened to leave behind. The layout mounts once for the whole app, which is where a thing that
 * is true on every screen belongs.
 */
export function startTheme(): () => void {
	return theme.start();
}

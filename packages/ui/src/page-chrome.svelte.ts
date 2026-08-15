/**
 * Which screen you are on, and the way off it — for each app's one navigation bar.
 *
 * One generic slot, not a route switch: a screen says what it is called and where its way back goes,
 * and a screen that says nothing renders nothing. What it replaces is a second full-width header
 * strip per route, which on `/align` cost two live map panes the height they had least of.
 *
 * Shared because both apps ask the same question of a screen — which one am I on, and where does the
 * way off it go — and the answer is drawn by one bar shell (ADR-0034).
 */

/**
 * The way back from a screen that belongs to one Project.
 *
 * A Project directory rather than a finished `href`, because the link is spelled out at the point of
 * use: `svelte/no-navigation-without-resolve` checks the literal start of an `href`, and a variable
 * holding a URL is not something it can check.
 */
export type WayBack = {
	/** The link's text, in the words of the screen it is leaving. */
	readonly label: string;
	/** The Project directory to return to, unencoded. `''` means the hub with no Project named. */
	readonly project: string;
	/** `data-testid` for the link, so a route keeps the identity its own suites already assert. */
	readonly testid?: string;
};

class PageChrome {
	/** The current screen's `<h1>` text, or `''` for a screen that carries its own heading. */
	heading = $state('');
	/** The way off this screen, or `null` when there is nowhere above it. */
	back = $state.raw<WayBack | null>(null);

	/** Say what screen this is. Called from a route effect, whose teardown calls {@link clear}. */
	show(heading: string, back: WayBack | null = null): void {
		this.heading = heading;
		this.back = back;
	}

	/**
	 * Give the slot back, if this screen is still the one holding it.
	 *
	 * ⚠ **The comparison is the whole of it.** Svelte runs the arriving route's effects before the
	 * leaving route's teardown, so an unconditional clear empties the bar *after* the next screen has
	 * filled it — a defect that only appears once a second route adopts this.
	 */
	clear(heading: string): void {
		if (this.heading !== heading) return;
		this.heading = '';
		this.back = null;
	}
}

/**
 * The one page-chrome signal, a module singleton in the shape `theme.svelte.ts` established.
 *
 * Not a context: the bar is mounted outside the layout's `children()`, so a context provided by a
 * route is not in scope for it.
 */
export const pageChrome = new PageChrome();

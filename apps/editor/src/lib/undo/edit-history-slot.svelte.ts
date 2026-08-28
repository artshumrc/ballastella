/**
 * Which Edit History belongs to the screen on show, for the navigation bar to draw controls for.
 *
 * The same shape as `PageChrome`: one generic slot a screen fills from an effect whose teardown
 * clears it, never a switch on the route. A screen that says nothing renders nothing, which is how
 * Workspace Home becomes undo-free without being named anywhere and how any screen added later is
 * undo-free until it says otherwise.
 *
 * The history itself belongs to the session and outlives this: walking from the Project screen to
 * `/align` and back fills the slot again with the same one (ADR-0039).
 */

import type { EditHistory } from '@ballastella/core';

class EditHistorySlot {
	/** The screen that currently owns the slot, independent of which history it declared. */
	#owner = '';
	/** The Edit History of the screen on show, or `null` for a screen that has none. */
	history = $state.raw<EditHistory | null>(null);

	/** Declare this screen's Edit History. Called from a route effect whose teardown calls {@link clear}. */
	show(owner: string, history: EditHistory): void {
		this.#owner = owner;
		this.history = history;
	}

	/**
	 * Give the slot back, if this screen is still the one holding it.
	 *
	 * Guarded on the owner for the reason `PageChrome.clear` is: Svelte can run an arriving route's
	 * effect before the leaving route's teardown, so an unconditional clear would empty the bar of the
	 * screen that has just arrived.
	 */
	clear(owner: string): void {
		if (this.#owner !== owner) return;
		this.#owner = '';
		this.history = null;
	}
}

/**
 * The one Edit History slot, a module singleton in the shape `pageChrome` and `theme` established.
 *
 * Not a context: the bar is mounted outside the layout's `children()`, so a context provided by a
 * route is not in scope for it.
 */
export const editHistorySlot = new EditHistorySlot();

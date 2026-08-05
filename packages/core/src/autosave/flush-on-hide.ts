import type { Autosave } from './autosave.js';

/** The two objects the listeners go on, injectable so this is testable without a browser. */
export interface HideEventTargets {
	readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
	readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/**
 * ADR-0017 rule 3: flush pending writes on `visibilitychange` → hidden and on `pagehide`.
 *
 * **Deliberately not `beforeunload`.** It is unreliable, and mobile browsers ignore it
 * outright — the phone that goes to the home screen and has its tab discarded never fires it.
 * These two events are the real "the user closed the laptop" path, and using the wrong one is
 * indistinguishable from working until somebody loses an afternoon.
 *
 * @returns a function that removes the listeners again
 */
export function installFlushOnHide(autosave: Autosave, targets: HideEventTargets): () => void {
	const onVisibilityChange = () => {
		if (targets.document.visibilityState === 'hidden') void autosave.flush();
	};
	const onPageHide = () => void autosave.flush();

	targets.document.addEventListener('visibilitychange', onVisibilityChange);
	targets.window.addEventListener('pagehide', onPageHide);

	return () => {
		targets.document.removeEventListener('visibilitychange', onVisibilityChange);
		targets.window.removeEventListener('pagehide', onPageHide);
	};
}

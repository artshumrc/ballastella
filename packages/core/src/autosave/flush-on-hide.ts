import type { Autosave } from './autosave.js';

/** The two objects the listeners go on, injectable so this is testable without a browser. */
export interface HideEventTargets {
	readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
	readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/**
 * ADR-0017 rule 3: capture then flush, on `visibilitychange` → hidden and on `pagehide`.
 *
 * **Deliberately not `beforeunload`.** It is unreliable, and mobile browsers ignore it
 * outright — the phone that goes to the home screen and has its tab discarded never fires it.
 * These two events are the real "the user closed the laptop" path, and using the wrong one is
 * indistinguishable from working until somebody loses an afternoon.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ⚠ THE FLUSH ALONE WAS NEVER ENOUGH, AND IT IS MEASURED (ticket 20, 2026-08-07)
 *
 * The measurement is in ADR-0017, "Rule 3, amended", which is its one home; it is not transcribed
 * here, because a number copied into four files is four numbers.
 *
 * `pagehide` *does* fire on a real navigation, and `Autosave.flush` *is* fast. The edit was lost
 * anyway, because `ProjectStore.write` is asynchronous and an unloading document does not run the
 * continuation. This listener was correct about the event and wrong about what could be done inside
 * it, and the assertion that passed was one that dispatched the event without navigating.
 *
 * So {@link Autosave.capture} runs **first and synchronously**, and `flush` runs after it as the
 * fast path for the case where the page is not actually going away — a tab merely hidden, which is
 * most `visibilitychange`s. `capture` before `flush` and not after: after is a continuation, which
 * is the thing that does not run.
 *
 * @returns a function that removes the listeners again
 */
export function installFlushOnHide(autosave: Autosave, targets: HideEventTargets): () => void {
	const keep = () => {
		autosave.capture();
		void autosave.flush();
	};
	const onVisibilityChange = () => {
		if (targets.document.visibilityState === 'hidden') keep();
	};
	const onPageHide = () => keep();

	targets.document.addEventListener('visibilitychange', onVisibilityChange);
	targets.window.addEventListener('pagehide', onPageHide);

	return () => {
		targets.document.removeEventListener('visibilitychange', onVisibilityChange);
		targets.window.removeEventListener('pagehide', onPageHide);
	};
}

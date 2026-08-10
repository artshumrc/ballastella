// ═══════════════════════════════════════════════════════════════════════════════════════════════
// WHY A DIALOG CLOSED, RECORDED AT THE MOMENT IT CLOSED.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// The Add-Historical-Map dialog closes by itself, after `openAddHistoricalMap` has already read
// `HTMLDialogElement.open === true` off it. The suite sees that as a click on a button that is
// present, laid out, and never visible — daisyUI's `.modal` keeps a *closed* dialog laid out — so
// the report is 345 polls of "element is not visible" and not one word about the close.
//
// It happens in roughly one full-suite run in three and never in isolation, so the expensive
// failure mode is a red run that explains nothing. This probe makes one failing run enough.
//
// **Everything it records is a distinct cause, not a hint.** The four candidates the ticket lists
// are told apart by which line appears:
//
//   `close()`               — application code called `close()`. The stack names the caller, which
//                             is `ModalDialog`'s effect (its `open` prop went false) or nothing
//                             else in this app.
//   `cancel`                — Escape. Native, fires before the close.
//   `submit`                — a `method="dialog"` form, which is daisyUI's backdrop button.
//   `removed`               — the element left the document while still open, i.e. the component
//                             tree holding it was torn down and a fresh, closed dialog took its
//                             place. `.open` was true of a node that no longer exists.
//   `open attribute`        — the attribute changed with none of the above, which would mean
//                             something is driving the element directly.
//   `left the top layer`    — still `open`, no longer `:modal`, which is what a *moved* node
//                             becomes. Context rather than a verdict: daisyUI hides on `[open]`,
//                             so this alone does not make the button invisible.
//
// Every line carries `open`, `:modal` and `checkVisibility()` separately, because the whole of this
// bug is those three disagreeing — an `open === true` check passed and the button was invisible.
//
// **It costs nothing when no dialog is open.** The `MutationObserver` is connected by `showModal`
// and disconnected on the close it observes, so the suite is not paying for a document-wide
// subtree observer while MapLibre and OpenSeadragon work.
//
// It reports over `console.debug`, which is collected by the `page` fixture in `test.ts` as the
// messages arrive. That matters: a test that dies on its own 180 s budget cannot be asked anything
// afterwards, and a probe whose readout is fetched at teardown is a probe that is missing exactly
// when it is needed.

/** The console prefix the fixture in `test.ts` filters on. One string, spelled in both places. */
export const DIALOG_PROBE_PREFIX = '[dialog-probe]';

/**
 * Installed with `page.addInitScript`, so it is in place before any application script runs and
 * before any `<dialog>` exists.
 *
 * Closes over nothing — Playwright serialises it into the page — so the prefix is passed in.
 */
export const DIALOG_PROBE_SCRIPT = ({ prefix }: { prefix: string }): void => {
	const say = (entry: Record<string, unknown>): void => {
		try {
			console.debug(`${prefix} ${JSON.stringify(entry)}`);
		} catch {
			// A probe may never be the reason a test fails.
		}
	};

	/** The caller, minus this file's own frames. Enough to name which close path ran. */
	const caller = (): string =>
		(new Error().stack ?? '')
			.split('\n')
			.slice(2, 9)
			.map((line) => line.trim())
			.join(' | ');

	/** Which dialog this is, said in terms the suite already uses to find it. */
	const which = (node: unknown): Record<string, unknown> => {
		const element = node as HTMLDialogElement | null;
		if (!element || typeof element.querySelectorAll !== 'function') return { dialog: 'none' };
		const ids = Array.from(element.querySelectorAll('[data-testid]'))
			.slice(0, 4)
			.map((child) => (child as HTMLElement).dataset.testid);
		return {
			open: element.open,
			connected: element.isConnected,
			// **`open`, `:modal` and actual visibility are three facts, recorded separately because
			// this bug is about them disagreeing.** A modal that is *moved* in the document leaves
			// the top layer for good while `open` stays `true`; and daisyUI keys its
			// `visibility: hidden` on the `[open]` **attribute** (measured in
			// `daisyui/components/modal.css`, not assumed), so `visible` is the one that answers what
			// Playwright is looking at.
			modal: element.matches(':modal'),
			visible: element.checkVisibility?.() ?? null,
			contains: ids
		};
	};

	const active = (): string => {
		const element = document.activeElement as HTMLElement | null;
		if (!element) return 'none';
		return `${element.tagName.toLowerCase()}${element.dataset?.testid ? `[${element.dataset.testid}]` : ''}`;
	};

	// The element being watched right now, and the observers watching it. One dialog is modal at a
	// time, which is what makes a single slot correct rather than a simplification.
	let watched: HTMLDialogElement | null = null;

	/** Said once per open, so a re-render that thrashes cannot fill the log with one fact. */
	let saidRemoved = false;
	/** The same, for the top-layer report. */
	let saidUnmodal = false;

	const removalObserver = new MutationObserver((records) => {
		if (!watched || saidRemoved) return;
		for (const record of records) {
			for (const node of Array.from(record.removedNodes)) {
				if (node.nodeType !== 1) continue;
				if (node === watched || (node as Element).contains(watched)) {
					saidRemoved = true;
					say({
						at: Date.now(),
						why: 'removed',
						detail: 'the open dialog left the document — a re-render took it out',
						dialog: which(watched),
						active: active()
					});
					// **Watching continues on purpose.** A dialog that is taken out and put straight
					// back is still open and no longer `:modal`, and that state — not the removal — is
					// what the user and the suite actually see. The poll below reports it.
					return;
				}
			}
		}
	});

	const attributeObserver = new MutationObserver(() => {
		if (!watched || watched.open) return;
		say({
			at: Date.now(),
			why: 'open attribute',
			detail: 'the open attribute went away',
			dialog: which(watched),
			active: active(),
			stack: caller()
		});
		stopWatching();
	});

	/**
	 * The one state no event announces: still open, no longer in the top layer.
	 *
	 * There is no `topLayerChange` event and no mutation record for it — leaving the top layer is a
	 * side effect of the node being moved — so it is polled. 100 ms while a dialog is open and never
	 * otherwise, which is what makes a poll acceptable here.
	 */
	let topLayerPoll: ReturnType<typeof setInterval> | undefined;

	function stopWatching(): void {
		watched = null;
		saidRemoved = false;
		saidUnmodal = false;
		removalObserver.disconnect();
		attributeObserver.disconnect();
		if (topLayerPoll !== undefined) clearInterval(topLayerPoll);
		topLayerPoll = undefined;
	}

	function startWatching(dialog: HTMLDialogElement): void {
		watched = dialog;
		saidRemoved = false;
		saidUnmodal = false;
		removalObserver.observe(document.documentElement, { childList: true, subtree: true });
		attributeObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
		if (topLayerPoll !== undefined) clearInterval(topLayerPoll);
		topLayerPoll = setInterval(() => {
			const element = watched;
			if (!element || saidUnmodal) return;
			if (!element.open) return; // The close paths above say why, and they stop the watch.
			if (element.matches(':modal')) return;
			saidUnmodal = true;
			// **Reported and then kept watching.** daisyUI hides on the `[open]` *attribute*, not on
			// `:modal`, so this on its own does not produce the invisible button this bug reports —
			// which makes it context for whatever comes next rather than the verdict. Stopping here
			// would blind the log to the close that actually matters.
			say({
				at: Date.now(),
				why: 'left the top layer',
				detail: 'still open, no longer :modal — the node was moved',
				dialog: which(element),
				active: active()
			});
		}, 100);
	}

	const nativeShowModal = HTMLDialogElement.prototype.showModal;
	HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
		const result = nativeShowModal.call(this);
		say({ at: Date.now(), why: 'showModal()', dialog: which(this), stack: caller() });
		startWatching(this);
		return result;
	};

	const nativeClose = HTMLDialogElement.prototype.close;
	HTMLDialogElement.prototype.close = function close(
		this: HTMLDialogElement,
		returnValue?: string
	) {
		if (this === watched) {
			say({
				at: Date.now(),
				why: 'close()',
				detail: 'application code called close() on the open dialog',
				dialog: which(this),
				active: active(),
				stack: caller()
			});
			stopWatching();
		}
		return returnValue === undefined ? nativeClose.call(this) : nativeClose.call(this, returnValue);
	};

	// Native paths, recorded *before* the close they cause, so the order in the log is the order of
	// events. `cancel` is Escape; a `method="dialog"` submit is daisyUI's backdrop.
	document.addEventListener(
		'cancel',
		(event) => {
			if (event.target !== watched) return;
			say({ at: Date.now(), why: 'cancel', detail: 'Escape', dialog: which(event.target) });
		},
		true
	);
	document.addEventListener(
		'submit',
		(event) => {
			const form = event.target as HTMLFormElement | null;
			if (!watched || !form || !watched.contains(form)) return;
			say({
				at: Date.now(),
				why: 'submit',
				detail: `form method=${form.getAttribute('method') ?? 'get'}`,
				dialog: which(watched)
			});
		},
		true
	);
	document.addEventListener(
		'close',
		(event) => {
			say({ at: Date.now(), why: 'close event', dialog: which(event.target), active: active() });
		},
		true
	);
};

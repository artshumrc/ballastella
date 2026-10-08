export const DIALOG_PROBE_PREFIX = '[dialog-probe]';

export const DIALOG_PROBE_SCRIPT = ({ prefix }: { prefix: string }): void => {
	const say = (entry: Record<string, unknown>): void => {
		try {
			console.debug(`${prefix} ${JSON.stringify({ at: Date.now(), ...entry })}`);
		} catch {}
	};

	const caller = (): string =>
		(new Error().stack ?? '')
			.split('\n')
			.slice(2, 9)
			.map((line) => line.trim())
			.join(' | ');

	const which = (node: unknown): Record<string, unknown> => {
		const element = node as HTMLDialogElement | null;
		if (!element || typeof element.querySelectorAll !== 'function') return { dialog: 'none' };
		const ids = Array.from(element.querySelectorAll('[data-testid]'))
			.slice(0, 4)
			.map((child) => (child as HTMLElement).dataset.testid);
		return {
			open: element.open,
			connected: element.isConnected,
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

	let watched: HTMLDialogElement | null = null;
	let saidRemoved = false;
	let saidUnmodal = false;

	const removalObserver = new MutationObserver((records) => {
		if (!watched || saidRemoved) return;
		for (const record of records) {
			for (const node of Array.from(record.removedNodes)) {
				if (node.nodeType !== 1) continue;
				if (node === watched || (node as Element).contains(watched)) {
					saidRemoved = true;
					say({
						why: 'removed',
						detail: 'the open dialog left the document — a re-render took it out',
						dialog: which(watched),
						active: active()
					});
					return;
				}
			}
		}
	});

	const attributeObserver = new MutationObserver(() => {
		if (!watched || watched.open) return;
		say({
			why: 'open attribute',
			detail: 'the open attribute went away',
			dialog: which(watched),
			active: active(),
			stack: caller()
		});
		stopWatching();
	});

	let topLayerPoll: ReturnType<typeof setInterval> | undefined;

	function stopWatching(): void {
		watched = null;
		removalObserver.disconnect();
		attributeObserver.disconnect();
		clearInterval(topLayerPoll);
	}

	function startWatching(dialog: HTMLDialogElement): void {
		stopWatching();
		watched = dialog;
		saidRemoved = false;
		saidUnmodal = false;
		removalObserver.observe(document.documentElement, { childList: true, subtree: true });
		attributeObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
		topLayerPoll = setInterval(() => {
			const element = watched;
			if (!element || saidUnmodal || !element.open || element.matches(':modal')) return;
			saidUnmodal = true;
			say({
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
		say({ why: 'showModal()', dialog: which(this), stack: caller() });
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

	document.addEventListener(
		'cancel',
		(event) => {
			if (event.target !== watched) return;
			say({ why: 'cancel', detail: 'Escape', dialog: which(event.target) });
		},
		true
	);
	document.addEventListener(
		'submit',
		(event) => {
			const form = event.target as HTMLFormElement | null;
			if (!watched || !form || !watched.contains(form)) return;
			say({
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
			say({ why: 'close event', dialog: which(event.target), active: active() });
		},
		true
	);
};

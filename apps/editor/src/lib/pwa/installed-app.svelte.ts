import { getContext, setContext } from 'svelte';

import { resolveDeploymentAsset } from '$lib/base-map/deployment-assets.js';

/**
 * Ballastella as an installed application: whether this browser can install it, and whether a
 * newer version of it is sitting waiting for the user to say when.
 *
 * One object for both because they are one subject — the app shell's identity and its lifetime —
 * and because both are answered by the same service worker registration. ADR-0012 puts them
 * together for the same reason: installing is the remedy for the permission friction ADR-0001
 * imposed (SPEC story 6), offline is what the shell cache buys (story 8), and the update prompt is
 * the price of not activating silently (story 9).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE REGISTRATION IS OURS AND NOT SVELTEKIT'S
 *
 * `kit.serviceWorker.register` is `false` in `svelte.config.js`. SvelteKit's own registration is a
 * bare `navigator.serviceWorker.register(...)` inside an inline script with nothing handed back,
 * so there is nowhere to attach the `updatefound` listener that story 9 is entirely about — and
 * fishing the registration back out with `getRegistration()` afterwards is a race against the
 * update it is meant to observe.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE SCRIPT URL IS RESOLVED AND NOT WRITTEN
 *
 * ADR-0006: one build has to serve a domain root *and* a project subdirectory, so `/service-worker.js`
 * is not available to us — it is correct at `example.org/` and a 404 at `example.org/ballastella/`,
 * which is the failure that ADR keeps CI greps over. `resolveDeploymentAsset` resolves the
 * deployment's own root from `base` and `document.baseURI`, exactly as the Base Map's glyphs and the
 * staged viewer bundle do, and **the scope a browser derives from a script URL is that script's own
 * directory** — so resolving the URL relatively is also what scopes the worker to the deployment
 * rather than to the origin. Nothing here spells a leading slash.
 *
 * Called once, from the root layout's mount, which is the moment `base` and `document.baseURI` agree
 * about where the deployment is. (`base` is baked per served page under `paths.relative`; after a
 * client-side navigation it no longer describes the current URL, which is why this is not re-run.)
 */
export class InstalledApp {
	/** Whether this browser has offered to install the app, so the offer can be made in the UI. */
	installable = $state(false);
	/** Whether the app is already running as an installed application. */
	installed = $state(false);
	/**
	 * A newer version has installed itself and is waiting.
	 *
	 * Never true on a first visit: a page with no controller was served from the network and is
	 * therefore already the newest thing there is, so telling its reader about an update would be
	 * telling them about themselves.
	 */
	updateAvailable = $state(false);
	/** The user said "not now". Their decision, and it is not re-asked for this page's lifetime. */
	updateDismissed = $state(false);
	/** Whether the network is there, which is what {@link applyUpdate} needs. */
	online = $state(true);

	#registration: ServiceWorkerRegistration | null = null;
	#installPrompt: BeforeInstallPromptEvent | null = null;

	/** Begin. Browser only, so call it from an effect. Returns its own teardown. */
	start(): () => void {
		const abort = new AbortController();
		const { signal } = abort;

		this.online = navigator.onLine;
		addEventListener('online', () => (this.online = true), { signal });
		addEventListener('offline', () => (this.online = false), { signal });

		// Chromium fires this when the app meets its install criteria; the event is what makes the
		// offer honest rather than a button that may do nothing. Every other browser installs from its
		// own menu, so where this never fires the UI says how instead (see `InstallOffer.svelte`).
		addEventListener(
			'beforeinstallprompt',
			(event) => {
				// Kept, not prompted. An install dialog nobody asked for is the nagging ADR-0012 rules out.
				event.preventDefault();
				this.#installPrompt = event as BeforeInstallPromptEvent;
				this.installable = true;
			},
			{ signal }
		);
		addEventListener(
			'appinstalled',
			() => {
				this.installed = true;
				this.installable = false;
				this.#installPrompt = null;
			},
			{ signal }
		);
		this.installed = matchMedia('(display-mode: standalone)').matches;

		if ('serviceWorker' in navigator) void this.#register(signal);

		return () => abort.abort();
	}

	/**
	 * Show the browser's install dialog. Must be called from a user gesture.
	 *
	 * `false` when there was no offer to show, which is every non-Chromium browser and Chromium
	 * before its own criteria are met.
	 */
	async install(): Promise<boolean> {
		const prompt = this.#installPrompt;
		if (!prompt) return false;
		// One offer per event, by specification: the event cannot be reused, so it goes now.
		this.#installPrompt = null;
		this.installable = false;
		await prompt.prompt();
		return true;
	}

	/** "Not now." */
	dismissUpdate(): void {
		this.updateDismissed = true;
	}

	/**
	 * Take the waiting version, now, because the user said so.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THIS DROPS THE REGISTRATION RATHER THAN RELOADING
	 *
	 * **A plain reload does not apply a waiting update.** Measured in the Chromium this repository
	 * drives: with V1 active and V2 waiting, `location.reload()` leaves `active` at V1, `waiting` at
	 * V2, and both caches in place — because the reload's own navigation is answered by the old
	 * worker, so the client is never released and the browser never runs Activate. A "Reload to
	 * update" button that did only that would be a lie, and the kind that is invisible: the user
	 * would keep being told about a version they had already accepted.
	 *
	 * The usual answer is to have the waiting worker end its own wait in response to a message from
	 * the page. ADR-0012 forbids that call by name and this ticket's acceptance criteria grep the
	 * source for it, so the registration is dropped instead. The reload that follows arrives with no
	 * controller and is therefore served the deployment's current bytes, and the fresh registration it
	 * makes installs and activates immediately, there being nothing left to wait behind. The user gets
	 * the new version in the gesture they asked for it in, and nothing ever activated behind their
	 * back.
	 *
	 * It needs the network for that one load, which is why {@link online} gates the offer. That is not
	 * a real narrowing: a waiting worker exists only because the network delivered it.
	 */
	async applyUpdate(): Promise<void> {
		this.updateAvailable = false;
		try {
			await this.#registration?.unregister();
		} catch {
			// A registration that will not go is not a reason to refuse the reload; the worst case is
			// the old version still serving, which is exactly where the user already was.
		}
		location.reload();
	}

	async #register(signal: AbortSignal): Promise<void> {
		let registration: ServiceWorkerRegistration;
		try {
			registration = await navigator.serviceWorker.register(
				resolveDeploymentAsset('service-worker.js')
			);
		} catch {
			// No worker, so no offline shell and no update prompt — and nothing else changes. Every
			// other part of the app works exactly as it did before this file existed, which is why this
			// is swallowed rather than surfaced: there is no action for a user to take.
			return;
		}
		if (signal.aborted) return;
		this.#registration = registration;

		// A worker left waiting by an earlier visit. Read before any listener, because it has already
		// happened and no event is coming.
		this.#considerWaiting(registration);

		registration.addEventListener(
			'updatefound',
			() => {
				const installing = registration.installing;
				if (!installing) return;
				installing.addEventListener('statechange', () => this.#considerWaiting(registration), {
					signal
				});
			},
			{ signal }
		);

		// The browser checks for a new worker on navigation, which is no help to somebody who has had
		// the app open for an afternoon — the exact person story 9 is about. So the check is repeated
		// when they come back to the tab, throttled, because it is a network request.
		addEventListener('visibilitychange', () => void this.#checkForUpdate(), { signal });
	}

	/**
	 * Say so if, and only if, a *newer* worker is waiting for this page.
	 *
	 * The `controller` test is the whole guard. On a first visit the freshly installed worker reaches
	 * `installed` with nothing to replace, and this page — uncontrolled, served from the network — is
	 * already what that worker would serve.
	 */
	#considerWaiting(registration: ServiceWorkerRegistration): void {
		if (registration.waiting && navigator.serviceWorker.controller) {
			this.updateAvailable = true;
		}
	}

	/** How long between two update checks. Long enough that returning to the tab is not a poll. */
	static readonly #CHECK_INTERVAL_MS = 15 * 60 * 1000;
	#lastCheck = 0;

	async #checkForUpdate(): Promise<void> {
		if (document.visibilityState !== 'visible') return;
		const now = Date.now();
		if (now - this.#lastCheck < InstalledApp.#CHECK_INTERVAL_MS) return;
		this.#lastCheck = now;
		// Swallowed: a check that could not reach the server is the ordinary offline case.
		await this.#registration?.update().catch(() => undefined);
	}
}

/**
 * Chromium's install offer. Not in `lib.dom`, and deliberately declared narrowly: `prompt()` is all
 * this app calls, and `userChoice` is a promise we have no use for — whether the user installed is
 * answered by `appinstalled`, which fires however the install was started.
 */
interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
}

const INSTALLED_APP = Symbol('ballastella.installedApp');

/** Called by the root layout, once. */
export function provideInstalledApp(): InstalledApp {
	const app = new InstalledApp();
	setContext(INSTALLED_APP, app);
	return app;
}

/** The one {@link InstalledApp}. Every route and component reads it; none creates one. */
export function useInstalledApp(): InstalledApp {
	return getContext<InstalledApp>(INSTALLED_APP);
}

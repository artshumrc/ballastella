import { getContext, setContext } from 'svelte';

import { resolveDeploymentAsset } from '$lib/base-map/deployment-assets.js';

import { installedAppOr } from './installed-app-context.js';

/**
 * Ballastella as an installed application: whether this browser can install it, and whether a
 * newer version of it is sitting waiting for the user to say when.
 *
 * One object for both because they are one subject — the app shell's identity and its lifetime —
 * and because both are answered by the same service worker registration. ADR-0012 puts them
 * together for the same reason: installing is the remedy for the permission friction ADR-0001
 * imposed, offline is what the shell cache buys, and the update prompt is the price of not
 * activating silently.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE REGISTRATION IS OURS AND NOT SVELTEKIT'S
 *
 * `kit.serviceWorker.register` is `false` in `svelte.config.js`. SvelteKit's own registration is a
 * bare `navigator.serviceWorker.register(...)` inside an inline script with nothing handed back,
 * so there is nowhere to attach the `updatefound` listener the update prompt is entirely about —
 * and fishing the registration back out with `getRegistration()` afterwards is a race against the
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
	 * A version newer than the one this page is running exists.
	 *
	 * Never true about *this page's own* version — including on a first visit, where the worker
	 * installing itself is the same build the network just served, so saying so would be telling the
	 * reader about themselves. What makes it true is a *different* worker: one waiting behind the
	 * controller, or one that took over while this page was uncontrolled. See {@link #considerNewer}.
	 */
	updateAvailable = $state(false);
	/** The user said "not now". Their decision, and it is not re-asked for this page's lifetime. */
	updateDismissed = $state(false);
	/**
	 * The user asked for the update and the deployment could not be reached, so nothing was dropped
	 * and nothing was reloaded. See {@link applyUpdate}.
	 */
	updateUnreachable = $state(false);
	/** Whether the network is there, which is what {@link applyUpdate} needs. */
	online = $state(true);

	#registration: ServiceWorkerRegistration | null = null;
	#installPrompt: BeforeInstallPromptEvent | null = null;
	/**
	 * The worker whose build this page is running, as far as this page can tell.
	 *
	 * The baseline every later worker is compared against, and the reason a first visit is quiet: it
	 * is read once, at registration, before anything can have changed. A controlled page runs its
	 * controller's build. An uncontrolled one was served straight off the network a moment ago, so the
	 * newest worker the registration has at that instant — waiting, active, or the one it is busy
	 * installing — is the build it is showing.
	 */
	#thisPages: ServiceWorker | null = null;

	/** Begin. Browser only, so call it from an effect. Returns its own teardown. */
	start(): () => void {
		const abort = new AbortController();
		const { signal } = abort;

		this.online = navigator.onLine;
		addEventListener(
			'online',
			() => {
				this.online = true;
				// The reason the last attempt was refused has gone, so the notice about it goes too.
				this.updateUnreachable = false;
			},
			{ signal }
		);
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
	 * the page. ADR-0012 forbids that call by name, so the registration is dropped instead. The reload
	 * that follows arrives with no controller and is therefore served the deployment's current bytes,
	 * and the fresh registration it makes installs and activates immediately, there being nothing left
	 * to wait behind. The user gets the new version in the gesture they asked for it in, and nothing
	 * ever activated behind their back.
	 *
	 * It needs the network for that one load, which is why {@link online} gates the offer. That is not
	 * a real narrowing: a waiting worker exists only because the network delivered it.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THE DEPLOYMENT IS PROVED REACHABLE FIRST
	 *
	 * Dropping the registration is the one irreversible step here, and between it and the reload
	 * there is a window in which this browser has **no worker, no controlled page, and no offline
	 * shell** — the thing a scholar in a reading room installed the app for. If the reload then does
	 * not arrive, they are not back where they started; they are worse off than if they had never
	 * been offered the update, and they stay that way until a real connection returns.
	 *
	 * `navigator.onLine` is not enough to rule that out. It is famously "attached to *something*":
	 * true on a captive portal, true on a wifi network with no route out, and stale for a while after
	 * a connection drops. So the registration goes only after the deployment has actually answered.
	 *
	 * `registration.update()` is the probe, and a well-chosen one rather than a convenient one. It
	 * fetches `service-worker.js` bypassing both this worker and the HTTP cache, and it **rejects**
	 * unless what comes back is really JavaScript from this origin — so a captive portal's login page,
	 * which is exactly the case a `HEAD` on the entry HTML would wave through with a cheerful 200,
	 * fails it. Refusing then costs the user nothing: the prompt stays, the old version keeps serving,
	 * and the shell is still on disk.
	 */
	async applyUpdate(): Promise<void> {
		const registration = this.#registration;
		this.updateUnreachable = false;
		try {
			await registration?.update();
		} catch {
			// Say so and change nothing. The registration is still there, which is the whole point.
			this.updateUnreachable = true;
			return;
		}
		this.updateAvailable = false;
		try {
			await registration?.unregister();
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

		// What this page is running, read before any listener and before anything can change it.
		// See {@link #thisPages}.
		this.#thisPages =
			navigator.serviceWorker.controller ??
			registration.waiting ??
			registration.active ??
			registration.installing;

		// A worker left waiting by an earlier visit. Read before any listener, because it has already
		// happened and no event is coming.
		this.#considerNewer(registration);

		registration.addEventListener(
			'updatefound',
			() => {
				const installing = registration.installing;
				if (!installing) return;
				// Every state this worker goes through, not only `installed`: on a page that is not
				// controlled it may never wait at all, and `activated` is then the first news there is.
				installing.addEventListener('statechange', () => this.#considerNewer(registration), {
					signal
				});
			},
			{ signal }
		);

		// The browser checks for a new worker on navigation, which is no help to somebody who has had
		// the app open for an afternoon — the exact person the update prompt is for. So it is repeated
		// when they come back to the tab, throttled, because it is a network request.
		addEventListener('visibilitychange', () => void this.#checkForUpdate(), { signal });
	}

	/**
	 * Say so if, and only if, the registration has a worker that is not the one this page is running.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THIS IS NOT "IS THERE A WAITING WORKER, AND AM I CONTROLLED"
	 *
	 * That was the guard, and it had a hole exactly where ADR-0012's promise is loudest. A page loaded
	 * before this browser had ever seen the worker is **not controlled**, and an uncontrolled page is
	 * not a client of the registration — so a version deployed during that session does not wait
	 * behind anything. The browser installs it and activates it straight away, `activate` deletes the
	 * caches the previous build filled, and under the old guard nobody was told: no controller, no
	 * prompt. The first visit is not a rare case, it is everybody's first visit.
	 *
	 * So the question asked is the one the user actually has — *is what I am looking at the current
	 * version?* — and the answer compares workers rather than reading `controller`. A first visit is
	 * still quiet, because the worker installing during it **is** the build this page was served.
	 *
	 * ⚠ **This makes the activation visible; it cannot make it wait.** Nothing a page can do keeps a
	 * new worker back when the page is not controlled: no worker cuts its own wait short here — that
	 * one call is forbidden by ADR-0012, and no comment in this app spells its name, so a search for
	 * it has no decoys to sift — the browser simply has no client to protect and does not wait at
	 * all. What this buys is that the user is told, and that {@link applyUpdate} puts them on the
	 * version the caches now hold. The one thing it does not buy is choosing *when*, on that one page
	 * load, and there is no API that would.
	 */
	#considerNewer(registration: ServiceWorkerRegistration): void {
		const newest = registration.waiting ?? registration.active;
		if (newest === null) return;
		// A page that had met no worker at registration takes the first one it sees as its own.
		this.#thisPages ??= newest;
		if (newest !== this.#thisPages) this.updateAvailable = true;
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

/**
 * The one {@link InstalledApp}. Every route and component reads it; none creates one.
 *
 * The refusal for a caller that has no provider is `installed-app-context.ts`, which explains why
 * three lines live in a file of their own: nothing in a Node test or a browser test can reach them
 * from here.
 */
export function useInstalledApp(): InstalledApp {
	return installedAppOr(getContext<InstalledApp | undefined>(INSTALLED_APP));
}

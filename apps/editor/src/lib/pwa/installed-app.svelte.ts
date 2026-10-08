import { createContext } from 'svelte';

import { resolveDeploymentAsset } from '$lib/base-map/deployment-assets.js';

class InstalledApp {
	installable = $state(false);
	installed = $state(false);
	updateAvailable = $state(false);
	updateDismissed = $state(false);
	updateUnreachable = $state(false);
	online = $state(true);
	#registration: ServiceWorkerRegistration | null = null;
	#installPrompt: BeforeInstallPromptEvent | null = null;
	#thisPages: ServiceWorker | null = null;

	start(): () => void {
		const abort = new AbortController();
		const { signal } = abort;

		this.online = navigator.onLine;
		addEventListener(
			'online',
			() => {
				this.online = true;
				this.updateUnreachable = false;
			},
			{ signal }
		);
		addEventListener('offline', () => (this.online = false), { signal });

		addEventListener(
			'beforeinstallprompt',
			(event) => {
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

	async install(): Promise<boolean> {
		const prompt = this.#installPrompt;
		if (!prompt) return false;
		this.#installPrompt = null;
		this.installable = false;
		await prompt.prompt();
		return true;
	}

	dismissUpdate(): void {
		this.updateDismissed = true;
	}

	async applyUpdate(): Promise<void> {
		const registration = this.#registration;
		this.updateUnreachable = false;
		try {
			await registration?.update();
		} catch {
			this.updateUnreachable = true;
			return;
		}
		this.updateAvailable = false;
		await registration?.unregister().catch(() => undefined);
		location.reload();
	}

	async #register(signal: AbortSignal): Promise<void> {
		let registration: ServiceWorkerRegistration;
		try {
			registration = await navigator.serviceWorker.register(
				resolveDeploymentAsset('service-worker.js')
			);
		} catch {
			return;
		}
		if (signal.aborted) return;
		this.#registration = registration;

		this.#thisPages =
			navigator.serviceWorker.controller ??
			registration.waiting ??
			registration.active ??
			registration.installing;

		this.#considerNewer(registration);

		registration.addEventListener(
			'updatefound',
			() => {
				const installing = registration.installing;
				if (!installing) return;
				installing.addEventListener('statechange', () => this.#considerNewer(registration), {
					signal
				});
			},
			{ signal }
		);

		addEventListener('visibilitychange', () => void this.#checkForUpdate(), { signal });
	}

	#considerNewer(registration: ServiceWorkerRegistration): void {
		const newest = registration.waiting ?? registration.active;
		if (newest === null) return;
		this.#thisPages ??= newest;
		if (newest !== this.#thisPages) this.updateAvailable = true;
	}

	static readonly #CHECK_INTERVAL_MS = 15 * 60 * 1000;
	#lastCheck = 0;

	async #checkForUpdate(): Promise<void> {
		if (document.visibilityState !== 'visible') return;
		const now = Date.now();
		if (now - this.#lastCheck < InstalledApp.#CHECK_INTERVAL_MS) return;
		this.#lastCheck = now;
		await this.#registration?.update().catch(() => undefined);
	}
}

interface BeforeInstallPromptEvent extends Event {
	prompt(): Promise<void>;
}

const [useInstalledApp, setInstalledApp] = createContext<InstalledApp>();

export { useInstalledApp };

export const provideInstalledApp = (): InstalledApp => setInstalledApp(new InstalledApp());

/**
 * Umami, cookieless and without personal data, so no consent banner. Set only by `pages.yml` on the
 * upstream repository: a fork's deployment, and every dev, CI and e2e build, loads nothing.
 */
const WEBSITE_ID: string | undefined = import.meta.env.VITE_UMAMI_WEBSITE_ID;
const SCRIPT_URL: string | undefined = import.meta.env.VITE_UMAMI_SCRIPT_URL;

type Payload = Record<string, unknown>;
type Event =
	| { name: 'project-created' }
	| { name: 'map-image-added'; data: { source: 'local' | 'remote' | 'workspace' } };

declare global {
	var umami: { track(payload: (defaults: Payload) => Payload): void } | undefined;
}

export function startAnalytics(): void {
	if (!WEBSITE_ID || !SCRIPT_URL) return;
	const script = document.createElement('script');
	script.src = SCRIPT_URL;
	script.defer = true;
	script.dataset.websiteId = WEBSITE_ID;
	// Auto-tracking sends `document.title` and the query string, and both carry the open Project's
	// name, which is free text and may be personal data. Every hit goes through `send` instead.
	script.dataset.autoTrack = 'false';
	script.dataset.doNotTrack = 'true';
	script.onload = trackPageview;
	document.head.append(script);
}

function send(extra: Payload): void {
	globalThis.umami?.track((defaults) => ({
		...defaults,
		url: location.pathname,
		title: '',
		...extra
	}));
}

export function trackPageview(): void {
	send({});
}

export function track(event: Event): void {
	send(event);
}

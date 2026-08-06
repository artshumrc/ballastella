<script lang="ts">
	import { useInstalledApp } from './installed-app.svelte.js';

	/**
	 * "A new version is available" — and nothing else happens until the user says so (SPEC story 9).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * EVERY CHOICE HERE IS ABOUT NOT INTERRUPTING AN ALIGNMENT
	 *
	 * Story 9's clause is "so that an update never interrupts me mid-alignment", and the ways a
	 * notice can interrupt are more numerous than the ways it can inform:
	 *
	 *   * **It does not reload.** The service worker has no `skipWaiting` and never claims a client,
	 *     so the running page keeps the worker it started with. This component reloads only from a
	 *     click on the button below.
	 *   * **It does not take focus.** No `<dialog>`, no `autofocus`, no `role="alert"`: a modal or an
	 *     assertive live region would pull a keyboard or screen-reader user out of the pane they are
	 *     placing a Control Point in, which is the interruption in its purest form. `aria-live="polite"`
	 *     is ADR-0016's mandated method for status, and it waits for a pause.
	 *   * **It does not move the page.** Fixed to the bottom-right corner rather than inserted into the
	 *     flow, because reflowing the layout under a half-finished drag would move the two map panes
	 *     while a pointer is down on one of them.
	 *   * **The live region is always mounted**, empty until there is something to say. A region added
	 *     to the DOM already containing its text is often not announced at all, which would leave the
	 *     news visible to sighted users only.
	 */
	const app = useInstalledApp();

	const showing = $derived(app.updateAvailable && !app.updateDismissed);
	const headingId = $props.id();
</script>

<!--
	`aria-live` on the wrapper and not on the card: the wrapper is what stays mounted, and the text
	appearing inside it is the change that gets announced.
-->
<div
	class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-end p-4"
	aria-live="polite"
	aria-atomic="true"
	data-testid="update-region"
>
	{#if showing}
		<section
			class="pointer-events-auto card max-w-sm border border-base-300 bg-base-200 shadow-lg"
			aria-labelledby={headingId}
			data-testid="update-prompt"
		>
			<div class="card-body gap-2 p-4">
				<h2 id={headingId} class="card-title text-base">A new version of Ballastella is ready</h2>
				<p class="text-sm">
					Nothing has changed on screen and nothing has been reloaded. Your work is saved as you go,
					so you can take the new version whenever you are at a good stopping point.
				</p>
				{#if !app.online}
					<p class="text-sm text-warning" data-testid="update-needs-network">
						Taking it needs a connection, and there is none right now. Everything here keeps working
						without one.
					</p>
				{/if}
				<div class="card-actions justify-end">
					<button
						type="button"
						class="btn btn-sm"
						data-testid="update-dismiss"
						onclick={() => app.dismissUpdate()}
					>
						Not now
					</button>
					<button
						type="button"
						class="btn btn-primary btn-sm"
						data-testid="update-reload"
						disabled={!app.online}
						onclick={() => void app.applyUpdate()}
					>
						Reload now
					</button>
				</div>
			</div>
		</section>
	{/if}
</div>

<script lang="ts">
	import { useInstalledApp } from './installed-app.svelte.js';

	const app = useInstalledApp();
	const showing = $derived(app.updateAvailable && !app.updateDismissed);
	const headingId = $props.id();
</script>

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
				{#if app.updateUnreachable}
					<p class="text-sm text-warning" data-testid="update-unreachable">
						Ballastella could not be reached just now, so nothing has changed and this version is
						still running. Try again when you have a connection you can browse with.
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

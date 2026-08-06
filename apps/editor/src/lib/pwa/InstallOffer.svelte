<script lang="ts">
	import { useInstalledApp } from './installed-app.svelte.js';

	/**
	 * "Install Ballastella" — offered where the question it answers is being asked (SPEC story 6).
	 *
	 * This sits under {@link StorageChoice}'s account of the folder permission on purpose. ADR-0012 is
	 * blunt about what the PWA is for: Chrome's persistent File System Access grant works best for an
	 * installed app, so "install this" is the honest answer to "why does it keep asking about my
	 * folder?" — and an offer made anywhere else is decoration.
	 *
	 * Three states, because there are three truths and conflating them produces a button that does
	 * nothing:
	 *
	 *   * **Already installed** — say so, and stop.
	 *   * **The browser has offered** (`beforeinstallprompt`, Chromium) — a real button that opens the
	 *     browser's own dialog.
	 *   * **It has not** — every other browser installs from its own menu, and Chromium only offers
	 *     once its criteria are met. So the fallback is the sentence that tells a user where to look,
	 *     not a disabled control and not silence. ADR-0012's "do not nag" rules out prompting; it does
	 *     not rule out answering.
	 */
	const app = useInstalledApp();
</script>

<div class="mt-3" data-testid="install-offer">
	{#if app.installed}
		<p class="max-w-prose text-sm opacity-70" data-testid="install-state-installed">
			Ballastella is installed on this computer, which is what lets your browser keep the permission
			for your Workspace folder between visits.
		</p>
	{:else if app.installable}
		<button
			class="btn btn-sm"
			type="button"
			data-testid="install-app"
			onclick={() => void app.install()}
		>
			Install Ballastella…
		</button>
	{:else}
		<p class="max-w-prose text-sm opacity-70" data-testid="install-state-unavailable">
			Your browser installs applications from its own menu — look for “Install” or “Add to Dock” in
			the address bar or the browser menu. Ballastella keeps working exactly as it does now if you
			never install it; installing is what lets the browser stop asking about your folder.
		</p>
	{/if}
</div>

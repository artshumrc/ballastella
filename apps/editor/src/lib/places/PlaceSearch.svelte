<script lang="ts">
	import {
		lookUpPlaces,
		placeLookupNotice,
		PLACE_SERVICE,
		type LookupOutcome,
		type Place
	} from '@ballastella/core';
	import ExternalLink from '$lib/components/ExternalLink.svelte';
	import { useInstalledApp } from '$lib/pwa/installed-app.svelte.js';

	let {
		label = 'Find a place',
		testid,
		onchoose
	}: {
		label?: string;
		testid?: string;
		onchoose: (place: Place, query: string) => void;
	} = $props();

	const fieldId = $props.id();
	const installedApp = useInstalledApp();
	let query = $state('');
	let asked = $state('');
	let outcome = $state.raw<LookupOutcome | null>(null);
	let looking = $state(false);
	let latest = 0;
	const candidates = $derived(outcome?.kind === 'places' ? outcome.places : []);

	const announcement = $derived(
		looking
			? `Looking up “${asked}”…`
			: outcome === null
				? ''
				: placeLookupNotice(outcome, asked, installedApp.online)
	);

	function choose(place: Place): void {
		onchoose(place, asked);
		outcome = null;
	}

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const wanted = query.trim();
		if (wanted === '') return;
		const mine = (latest += 1);
		asked = wanted;
		looking = true;
		const found = await lookUpPlaces(wanted);
		if (mine !== latest) return;
		outcome = found;
		looking = false;
	}
</script>

<div class="w-full" data-testid={testid}>
	<form class="join w-full" onsubmit={submit}>
		<label class="sr-only" for={fieldId}>{label}</label>
		<input
			id={fieldId}
			type="search"
			class="input join-item w-full bg-base-100 input-sm"
			placeholder="Place name"
			autocomplete="off"
			bind:value={query}
			data-testid="place-search-query"
		/>
		<button
			type="submit"
			class="btn join-item btn-primary btn-sm"
			data-testid="place-search-submit"
		>
			{label}
		</button>
	</form>

	{#if candidates.length > 0}
		<ul
			class="menu mt-1 max-h-64 w-full flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
			data-testid="place-candidates"
		>
			{#each candidates as place, index (index)}
				<li>
					<button
						type="button"
						class="text-left text-sm"
						data-testid="place-candidate"
						onclick={() => choose(place)}
					>
						{place.name}
					</button>
				</li>
			{/each}
		</ul>

		<p
			class="mt-1 rounded-box bg-base-100/90 px-2 py-1 text-xs opacity-80"
			data-testid="place-attribution"
		>
			Place data:
			{#if PLACE_SERVICE.attribution.href}
				<ExternalLink class="link" href={PLACE_SERVICE.attribution.href}
					>{PLACE_SERVICE.attribution.text}</ExternalLink
				>
			{:else}
				{PLACE_SERVICE.attribution.text}
			{/if}
		</p>
	{/if}

	<p
		class={announcement === ''
			? 'sr-only'
			: 'mt-1 max-w-full rounded-box bg-base-100 px-2 py-1 text-sm shadow'}
		aria-live="polite"
		aria-atomic="true"
		data-testid="place-search-status"
	>
		{announcement}
	</p>
</div>

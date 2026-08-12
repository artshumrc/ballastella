<script lang="ts">
	// The place search surface: a field, and the candidates it found (SPEC stories 1–4, 20–23).
	//
	// **Built once for two consumers.** The Base Map pane uses it to move the camera; the Annotation
	// Layer surface uses it to move the camera *and* drop a Pin. The whole of that difference is what
	// each caller does in `onchoose` — so the field and the list are here, and nothing about placing
	// an Annotation is.
	//
	// **It takes no room of its own and positions nothing.** The pane draws it over the map and the
	// Layer's card puts it in the flow beside the drawing tools, which is the caller's question: a
	// surface that positioned itself absolutely could only ever live over a map.
	//
	// ⚠ **Submit-only. Typing issues no request**, and there is deliberately no `oninput`, no debounce
	// and no timer anywhere in this file. `lookup.ts` carries the whole argument for why that fence is
	// contingent on the default service rather than a judgement about the interaction.
	//
	// Every control is a native element, so the field, the button and every candidate are keyboard
	// operable with nothing added: a list of results is precisely the control that ships mouse-only.

	import {
		lookUpPlaces,
		placeLookupNotice,
		PLACE_SERVICE,
		type LookupOutcome,
		type Place
	} from '@ballastella/core';
	import { useInstalledApp } from '$lib/pwa/installed-app.svelte.js';

	let {
		label = 'Find a place',
		testid,
		onchoose
	}: {
		/**
		 * What this search is called — the field's label, and the words on the button.
		 *
		 * ⚠ **Because two of these are on the Project screen at once**, and one of them writes to the
		 * scholar's file. Identical names would leave a screen-reader or voice-control user choosing
		 * between two "Find a place" buttons with nothing saying which one drops a Pin.
		 */
		label?: string;
		/** Test id for the whole surface, so a spec can say which of the two searches it means. */
		testid?: string;
		/**
		 * A candidate was chosen. What that means is the caller's — here it is only the choice.
		 *
		 * `query` is **what the scholar submitted**, which the Annotation Layer's use makes the Pin's
		 * title (ADR-0029). Not `place.name`, which for Boston Common is `Boston Common, Boston,
		 * Suffolk County, Massachusetts, 02108, United States` — a pre-fill people delete every time is
		 * worse than an empty field. It is handed over from here because this is where it was typed.
		 */
		onchoose: (place: Place, query: string) => void;
	} = $props();

	/**
	 * The field's id, unique per instance.
	 *
	 * Two of these are on the Project screen at once — the pane's and the open Annotation Layer's — so
	 * a hardcoded id would put the same `for` on two labels and point both at the first field.
	 */
	const fieldId = $props.id();

	/**
	 * The app's one connection signal, which reaches the notice as a parameter.
	 *
	 * ⚠ **It only ever takes a clause away.** `navigator.onLine` reports a link rather than
	 * reachability, so with it false the notice drops its it-is-probably-the-service clause and gains
	 * no claim that the scholar is offline — and **nothing here is disabled**, because disabling the
	 * field would itself be a claim about their connection (ADR-0029). This is the one control in the
	 * editor that cannot work without a connection, and it says so by failing and explaining rather
	 * than by greying out.
	 */
	const installedApp = useInstalledApp();

	let query = $state('');
	/** The query the outcome below is about, which is not what is in the field a keystroke later. */
	let asked = $state('');
	/** What the last submitted query produced, or `null` before there has been one. */
	let outcome = $state.raw<LookupOutcome | null>(null);
	let looking = $state(false);

	/**
	 * Which lookup is the current one.
	 *
	 * A scholar who submits twice while the first is in flight must not have the first answer land
	 * over the second — the answers come back in whatever order the service manages, and the
	 * candidate list would then be about a query they have moved on from.
	 */
	let latest = 0;

	const candidates = $derived(outcome?.kind === 'places' ? outcome.places : []);

	/**
	 * What the region below says, which is both the visible text and what is announced.
	 *
	 * The sentences are `@ballastella/core`'s, not this template's: the two empty-handed outcomes
	 * have to be impossible to confuse, and a string built here could only be asked about through a
	 * browser (see `places/notice.ts`).
	 */
	const announcement = $derived(
		looking
			? `Looking up “${asked}”…`
			: outcome === null
				? ''
				: placeLookupNotice(outcome, asked, installedApp.online)
	);

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

<!--
	**Nothing here holds layout open**: a two-pane authoring screen keeps its room for the work (SPEC
	story 23), and the candidate list exists only while there are candidates. Where this sits is the
	caller's — see the header.
-->
<div class="w-full" data-testid={testid}>
	<form class="join w-full" onsubmit={submit}>
		<!--
			The label is off screen and the button carries the same words on it, so the surface names
			itself to everyone: a bare field over a map says nothing about what it searches.
		-->
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
		<!--
			The candidates, shown rather than taken. Choosing the top hit silently is the failure this
			feature is most able to manufacture: a Pin in the wrong Springfield is indistinguishable
			from one in the right Springfield (ADR-0029).

			Keyed by position, because a service can and does answer with two candidates carrying the
			same display name.
		-->
		<ul
			class="menu mt-1 max-h-64 w-full flex-nowrap overflow-y-auto rounded border border-base-300 bg-base-100 p-1 shadow-lg"
			data-testid="place-candidates"
		>
			{#each candidates as place, index (index)}
				<li>
					<button
						type="button"
						class="text-left text-sm"
						data-testid="place-candidate"
						onclick={() => onchoose(place, asked)}
					>
						{place.name}
					</button>
				</li>
			{/each}
		</ul>

		<!--
			Whose data this is, from the service's own configuration and **not** from the Base Map
			catalog: a fork serving its own tiles while keeping the default lookup would otherwise show
			the wrong credit (ADR-0029). Here rather than as permanent chrome, so it is on screen
			exactly while that data is.
		-->
		<p
			class="mt-1 rounded bg-base-100/90 px-2 py-1 text-xs opacity-80"
			data-testid="place-attribution"
		>
			Place data:
			{#if PLACE_SERVICE.attribution.href}
				<!-- `resolve()` is for this app's own routes; a licence page on somebody else's server is
				     not one, so the rule is disabled for the one case it does not cover. -->
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<a class="link" href={PLACE_SERVICE.attribution.href} target="_blank" rel="noreferrer"
					>{PLACE_SERVICE.attribution.text}</a
				>
			{:else}
				{PLACE_SERVICE.attribution.text}
			{/if}
		</p>
	{/if}

	<!--
		The outcome, in visible text and announced. `aria-live` with `aria-atomic` rather than
		`role="status"`, which the save indicator already owns on the Project screen — the same choice
		`AnnotationTools` and the Layer list made.

		`sr-only` while there is nothing to say rather than removed: a live region announces a change
		of text in a region that is *already there*, so an element that came and went would announce
		nothing at all — and `sr-only` is absolutely positioned, so it holds no layout open either.
	-->
	<p
		class={announcement === ''
			? 'sr-only'
			: 'mt-1 max-w-full rounded bg-base-100 px-2 py-1 text-sm shadow'}
		aria-live="polite"
		aria-atomic="true"
		data-testid="place-search-status"
	>
		{announcement}
	</p>
</div>

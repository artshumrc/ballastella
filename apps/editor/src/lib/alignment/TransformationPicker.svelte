<script lang="ts">
	// How the Map Image is stretched: ADR-0013's picker.
	//
	// A native `<select>`, because ADR-0016's binding contract names one for the transformation type —
	// few options, nothing custom needed, and native arrow-key and type-ahead behaviour that no
	// headless library improves on.
	//
	// **The guidance is the primary text and the label is secondary** (ADR-0013). "Most printed maps"
	// is what a historian can act on; "Standard" is not. So each option reads guidance first, and the
	// selected option's guidance is *also* repeated as visible prose bound by `aria-describedby` —
	// because a `<select>` shows only the chosen option until it is opened, and the one thing this copy
	// must never be is a tooltip: daisyUI renders those through CSS `::before`, so they are neither
	// announced nor dismissable (ADR-0016).
	//
	// The two Advanced types are behind a disclosure rather than omitted. They need 6 and 10 Control
	// Points and, with clustered points, produce edge distortion that reads as the tool being broken —
	// but a scholar who has placed thirty points on a distorted sixteenth-century map has a legitimate
	// reason to want third order, and hiding it entirely means hitting a ceiling with no explanation.
	//
	// A `<button aria-expanded>` disclosure and not `<details>`: ADR-0016 bans the `<details>`
	// dropdown, and while a disclosure is a different pattern from a dropdown, the WAI-ARIA disclosure
	// button is unambiguously outside that ban and needs no interpretation of it.
	//
	// **What this group does not carry is the two notes about consequences** — that Simple cannot
	// mirror, and that the higher orders distort at the edges. They are prose about the choice rather
	// than help for making it, and they stand behind "How this works" in `AlignmentWorkspace`, where
	// the rest of this screen's explanation is. What stays here is the guidance the control is
	// described by and the shortfall a count cannot support.

	import {
		TRANSFORMATION_CHOICES,
		transformationShortfall,
		type TransformationType
	} from '@ballastella/core';

	let {
		value,
		controlPointCount,
		onchoose
	}: {
		value: TransformationType;
		/** How many complete pairs there are, which is what gates each type (ADR-0013). */
		controlPointCount: number;
		onchoose: (type: TransformationType) => void;
	} = $props();

	/** Whether the user has asked for the Advanced tier. */
	let advancedRequested = $state(false);

	/** Which tier the currently selected type is in. */
	const currentTier = $derived(
		TRANSFORMATION_CHOICES.find((choice) => choice.type === value)?.tier
	);

	/**
	 * Whether the Advanced options are in the list.
	 *
	 * **Forced open when an advanced type is the one selected**, which is how a stored Alignment
	 * reopens: `advancedRequested` is page state and does not survive a reload, so without this a
	 * Project saved as Higher-order (3rd) would come back with its own type missing from the list —
	 * and a `<select>` whose value matches no option falls back to the first, which would read as the
	 * choice having been silently changed to Simple.
	 *
	 * The consequence is that the hide button is not offered while an advanced type is current. That
	 * is the honest behaviour: the thing it would hide is the user's own selection.
	 */
	const advancedShown = $derived(advancedRequested || currentTier === 'advanced');

	interface Offered {
		readonly type: TransformationType;
		readonly label: string;
		readonly guidance: string;
		/** `''` when the type can be chosen. */
		readonly shortfall: string;
	}

	const offered = $derived<readonly Offered[]>(
		TRANSFORMATION_CHOICES.map((choice) => ({
			type: choice.type,
			label: choice.label,
			guidance: choice.guidance,
			shortfall: transformationShortfall(choice.type, controlPointCount)
		}))
	);

	const primary = $derived(
		offered.filter(
			(one) => TRANSFORMATION_CHOICES.find((c) => c.type === one.type)?.tier === 'primary'
		)
	);
	const advanced = $derived(
		offered.filter(
			(one) => TRANSFORMATION_CHOICES.find((c) => c.type === one.type)?.tier === 'advanced'
		)
	);

	const chosen = $derived(offered.find((one) => one.type === value));

	/**
	 * Every type the Control Point count cannot support, as text on the page.
	 *
	 * Not only on the disabled options. A `<select>`'s options are legible when it is open, and the
	 * whole point of naming the shortfall is that the user knows what to do next *before* they go
	 * looking — "Flexible needs at least 3 Control Points, you have 2" answers a question they have
	 * while placing points, not one they have while browsing a list.
	 */
	const shortfalls = $derived(
		offered.filter((one) => one.shortfall !== '' && (advancedShown || primary.includes(one)))
	);

	/** The option's own text: guidance first, label second, and the shortfall when there is one. */
	const optionText = (one: Offered): string =>
		one.shortfall === ''
			? `${one.guidance} (${one.label})`
			: `${one.guidance} (${one.label}) — ${one.shortfall}`;

	const choose = (next: string): void => {
		const match = offered.find((one) => one.type === next);
		// Nothing else can arrive — the `<option>` values are the offered types and the banned three
		// are not among them — but the cast that would otherwise be needed here is precisely the one
		// that would let `straight` through if the markup ever changed.
		if (match && match.shortfall === '') onchoose(match.type);
	};
</script>

<div class="flex flex-col gap-1" data-testid="transformation-picker">
	<label class="text-sm font-medium" for="transformation-type">
		How this Map Image is stretched
	</label>

	<div class="flex flex-wrap items-center gap-2">
		<select
			id="transformation-type"
			class="select max-w-lg select-sm"
			aria-describedby="transformation-guidance"
			data-testid="transformation-select"
			{value}
			onchange={(event) => choose(event.currentTarget.value)}
		>
			{#each primary as one (one.type)}
				<option value={one.type} disabled={one.shortfall !== ''}>{optionText(one)}</option>
			{/each}

			{#if advancedShown}
				<!-- Grouped and named, so the tier is announced rather than being a matter of position. -->
				<optgroup label="Advanced">
					{#each advanced as one (one.type)}
						<option value={one.type} disabled={one.shortfall !== ''}>{optionText(one)}</option>
					{/each}
				</optgroup>
			{/if}
		</select>

		{#if currentTier !== 'advanced'}
			<button
				type="button"
				class="btn btn-outline btn-sm"
				aria-expanded={advancedShown}
				aria-controls="transformation-type"
				data-testid="transformation-advanced"
				onclick={() => (advancedRequested = !advancedRequested)}
			>
				{advancedShown ? 'Hide advanced types' : 'Advanced types'}
			</button>
		{/if}
	</div>

	<!--
		The selected type's guidance, as prose. Bound with `aria-describedby` so it is announced with
		the control, and visible so it is readable without opening the list — the two halves of
		ADR-0016's "visible text or aria-describedby, never a tooltip".
	-->
	<p id="transformation-guidance" class="max-w-prose text-sm" data-testid="transformation-guidance">
		{chosen?.guidance ?? ''}
	</p>

	{#if shortfalls.length > 0}
		<!--
			**Deliberately not a `<ul>`.** These are help text under a control, of the same kind as the
			guidance paragraph above — a list wrapper adds "list, three items" around three sentences
			that are already inside a named group, which is noise rather than structure.

			The hazard it avoids is still live even though the page that produced it is gone. `ProjectView`
			listed Map Images as a `<ul>` and several browser tests counted them with a bare
			`getByRole('listitem')`; a third list here made two of them fail. Those tests read the Layer
			stack instead — but the Layer stack is also a list, and the Annotation list beside it is a
			third, so a bare `listitem` count on the Project screen is as ambiguous as it ever was.
		-->
		<div class="max-w-prose text-sm opacity-70" data-testid="transformation-shortfalls">
			{#each shortfalls as one (one.type)}
				<p data-transformation-type={one.type}>{one.shortfall}</p>
			{/each}
		</div>
	{/if}
</div>

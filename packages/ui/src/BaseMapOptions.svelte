<script lang="ts">
	// Everything about the Base Map, behind one button on the map.
	//
	// **One dropdown rather than a row of controls**, because the row was the problem: a switcher, a
	// borders control, three toggles and a place search abreast is more furniture than map, and at
	// most pane widths it wrapped — which put the same control somewhere new on every screen. One
	// button of known width opens a panel that is as tall as it needs to be, over the map rather than
	// across it.
	//
	// **The sections are three different kinds of thing, and the panel keeps them apart.** Which
	// *tiles* are read is the deployment's offer (ADR-0020) and is absent where there is only one set;
	// how they are *drawn* is the author's, and a Reader may override it for themselves; which
	// *borders* are drawn is the author's argument about the work and no Reader changes it — which is
	// why `borders` is optional here rather than always rendered. A caller that passes no borders
	// handler gets no borders section.

	import {
		baseMapOptions,
		type BaseMapAppearance,
		type BaseMapBorders,
		type BaseMapCatalog
	} from '@ballastella/core';

	import BaseMapAppearanceToggles from './BaseMapAppearanceToggles.svelte';
	import BaseMapSwitcher from './BaseMapSwitcher.svelte';
	import BorderSwitcher from './BorderSwitcher.svelte';
	import MenuPopover from './MenuPopover.svelte';

	let {
		entryId,
		catalog,
		appearance,
		onAppearance,
		onSelectEntry,
		borders,
		onBorders,
		buttonClass = 'btn btn-sm'
	}: {
		entryId: string;
		catalog: BaseMapCatalog;
		appearance: BaseMapAppearance;
		onAppearance: (appearance: BaseMapAppearance) => void;
		/** Choosing between sets of tiles. Never called where the deployment offers one. */
		onSelectEntry: (id: string) => void;
		/**
		 * The Project's boundary set, and the handler that records it — **both or neither**.
		 *
		 * Omitted by the viewer, deliberately: which borders a work draws is the author's argument
		 * about it and travels with the Project, so a Published Site offers no control for it at all.
		 */
		borders?: BaseMapBorders;
		onBorders?: (borders: BaseMapBorders) => void;
		buttonClass?: string;
	} = $props();

	let menu = $state<ReturnType<typeof MenuPopover> | undefined>();

	/**
	 * Whether the panel is showing **right now**.
	 *
	 * Forwarded from `MenuPopover` for the reason its own docstring gives: Escape dismisses a popover
	 * natively *and* keeps propagating, so a page with its own Escape handling — the Project screen
	 * abandons a part-drawn shape on Escape — would act on the keypress that only closed this panel.
	 */
	export function isOpen(): boolean {
		return menu?.isOpen() ?? false;
	}

	/**
	 * Whether this deployment offers a choice of tiles at all.
	 *
	 * Asked here as well as inside `BaseMapSwitcher` — which renders nothing for a catalog of one —
	 * because a `<li>` holding a component that draws nothing is still a row of the panel's `gap`.
	 * Both read `baseMapOptions`, so it is one rule consulted twice rather than two rules.
	 */
	const choiceOfTiles = $derived(baseMapOptions(catalog).length > 1);
</script>

<MenuPopover
	bind:this={menu}
	label="Base Map Options"
	{buttonClass}
	testid="base-map-options"
	menuClass="flex w-64 flex-col gap-4 p-3"
>
	<!--
		`<li>`s because `MenuPopover` renders its children inside a `<ul>`, and a `<fieldset>` loose in
		a list is markup a screen reader has to guess at. They carry no daisyUI `menu` styling — this is
		a panel of controls rather than a list of commands, and `menu`'s own item rules would fight
		every label in it.
	-->
	{#if choiceOfTiles}
		<li>
			<BaseMapSwitcher
				{entryId}
				{catalog}
				fullWidth={true}
				class="select-sm"
				onSelect={onSelectEntry}
			/>
		</li>
	{/if}
	<li>
		<BaseMapAppearanceToggles {appearance} legend="Detail" onChange={onAppearance} />
	</li>
	{#if borders !== undefined && onBorders !== undefined}
		<li>
			<BorderSwitcher {borders} legend="Borders" onSelect={onBorders} />
		</li>
	{/if}
</MenuPopover>

<script lang="ts">
	import {
		baseMapOptions,
		type BaseMapAppearance,
		type BaseMapBorders,
		type BaseMapCatalog
	} from '@ballastella/core';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';

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
		showChevron = false
	}: {
		entryId: string;
		catalog: BaseMapCatalog;
		appearance: BaseMapAppearance;
		onAppearance: (appearance: BaseMapAppearance) => void;
		onSelectEntry: (id: string) => void;
		borders?: BaseMapBorders;
		onBorders?: (borders: BaseMapBorders) => void;
		showChevron?: boolean;
	} = $props();

	let menu = $state<ReturnType<typeof MenuPopover> | undefined>();

	export function isOpen(): boolean {
		return menu?.isOpen() ?? false;
	}

	const choiceOfTiles = $derived(baseMapOptions(catalog).length > 1);
</script>

<MenuPopover
	bind:this={menu}
	label="Base Map Options"
	buttonClass="btn btn-sm"
	testid="base-map-options"
	menuClass="flex w-64 flex-col gap-4 p-3"
>
	{#snippet buttonSuffix()}
		{#if showChevron}
			<ChevronDown class="size-4" aria-hidden="true" />
		{/if}
	{/snippet}
	<!-- `<li>`s because `MenuPopover` renders its children inside a `<ul>`, and a `<fieldset>` loose in a list is markup a screen reader has to guess at. -->
	{#if choiceOfTiles}
		<li>
			<BaseMapSwitcher {entryId} {catalog} class="select-sm" onSelect={onSelectEntry} />
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

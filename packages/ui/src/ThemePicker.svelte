<script lang="ts">
	import { THEMES, type Theme } from '@ballastella/core';
	import Check from '@lucide/svelte/icons/check';

	import MenuPopover from './MenuPopover.svelte';

	let {
		theme,
		onSelect,
		buttonClass = 'btn btn-sm'
	}: {
		theme: Theme;
		onSelect: (theme: Theme) => void;
		buttonClass?: string;
	} = $props();

	let menu: MenuPopover;

	function select(next: Theme): void {
		onSelect(next);
		if (menu.isOpen()) menu.dismiss();
	}
</script>

<MenuPopover
	bind:this={menu}
	label="Theme"
	{buttonClass}
	align="end"
	testid="theme-toggle"
	flush
	menuClass="menu max-h-[min(32rem,calc(100vh-6rem))] w-72 flex-nowrap overflow-y-auto"
	{theme}
>
	{#each THEMES as option (option.name)}
		<li data-theme={option.name}>
			<button
				type="button"
				class="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 bg-base-100 text-base-content"
				class:menu-active={theme === option.name}
				aria-current={theme === option.name ? 'true' : undefined}
				data-testid={`theme-option-${option.name}`}
				onclick={() => select(option.name)}
			>
				<span>{option.label}</span>
				{#if theme === option.name}
					<Check size={16} aria-hidden="true" />
				{:else}
					<span aria-hidden="true"></span>
				{/if}
				<span class="flex items-center gap-1" aria-hidden="true">
					<span class="size-3 rounded-selector bg-primary"></span>
					<span class="size-3 rounded-selector bg-secondary"></span>
					<span class="size-3 rounded-selector bg-accent"></span>
					<span class="size-3 rounded-selector bg-neutral"></span>
				</span>
			</button>
		</li>
	{/each}
</MenuPopover>

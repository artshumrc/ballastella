<script lang="ts">
	import type { Theme } from '@ballastella/core';

	import AppBar from './AppBar.svelte';

	let {
		theme = 'light',
		onSelectTheme = () => {},
		withMenu = false,
		withStatus = false,
		withWordmark = false,
		themeLast = false
	}: {
		theme?: Theme;
		onSelectTheme?: (theme: Theme) => void;
		withMenu?: boolean;
		withStatus?: boolean;
		withWordmark?: boolean;
		themeLast?: boolean;
	} = $props();
</script>

{#snippet start()}
	<a data-testid="site-name" href="./">Ballastella</a>
{/snippet}

{#snippet end()}
	<button type="button" data-testid="app-control">Sync</button>
{/snippet}

{#snippet menu()}
	<li><button type="button" data-testid="app-control">Sync</button></li>
{/snippet}

{#snippet status()}
	<span data-testid="app-status">Saved</span>
{/snippet}

{#snippet wordmark()}
	<a class="font-serif" data-testid="app-wordmark" href="./">Ballastella</a>
{/snippet}

<AppBar
	{start}
	{end}
	{...withMenu ? { menu } : {}}
	{...withStatus ? { status } : {}}
	{...withWordmark ? { wordmark } : {}}
	{theme}
	{themeLast}
	{onSelectTheme}
	homeHref="./"
/>

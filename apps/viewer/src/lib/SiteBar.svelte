<script lang="ts">
	// Published site nav: editor's AppBar shell, Reader items only.

	import { resolve } from '$app/paths';
	import { AppBar, BallastellaMark } from '@ballastella/ui';

	import { returnLink } from '$lib/return-link.svelte.js';
	import { theme } from '$lib/theme.svelte';
</script>

{#snippet wordmark()}
	<a
		class="flex link items-center gap-2 font-serif text-lg leading-none link-hover"
		data-testid="site-name"
		href={resolve('/')}
	>
		<BallastellaMark />
		Ballastella
	</a>
{/snippet}

{#snippet end()}
	<a class="btn btn-sm" data-testid="all-projects" href={resolve('/')}>All Projects</a>
	{#if returnLink.current}
		<!-- Only absolute address: leaves for another origin. -->
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a class="btn btn-sm" href={returnLink.current.href}>{returnLink.current.label}</a>
	{/if}
{/snippet}

<!-- Bar buttons duplicated as menu items; rendered one at a time, never both. -->
{#snippet menu()}
	<li><a data-testid="all-projects" href={resolve('/')}>All Projects</a></li>
	{#if returnLink.current}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- another origin. -->
		<li><a href={returnLink.current.href}>{returnLink.current.label}</a></li>
	{/if}
{/snippet}

<AppBar
	{wordmark}
	{end}
	{menu}
	theme={theme.current}
	onSelectTheme={(next) => (theme.current = next)}
	homeHref={resolve('/')}
/>

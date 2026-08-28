<script lang="ts">
	// A published site's navigation bar: what is true on every screen of it.
	//
	// The shell is `AppBar`, in `@ballastella/ui`, and it is the editor's bar — the same landmark, the
	// same layout, the same page-chrome slot, the same theme control in the same place, so that a
	// scholar talking a colleague through a published site over the phone is looking at one interface
	// rather than two dialects of one.
	//
	// What a Reader gets here is fewer items, not a restricted version of the editor's: there is no
	// Workspace to switch, nothing to save and nothing to undo, so none of those are passed. That is
	// the whole of "read-only" in this app.

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
		<!--
			The only **absolute** address this app renders. Everything else goes through `resolve`,
			because the site's own base path is unknown at build time (ADR-0006); this is different in
			kind — it leaves for another origin entirely, which is the ordinary topology under ADR-0032 —
			and it is still built from two files read *relative* to this document.
		-->
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a class="btn btn-sm" href={returnLink.current.href}>{returnLink.current.label}</a>
	{/if}
{/snippet}

<!--
	The same two affordances as menu items, for the width at which the bar folds. Written twice
	because a bar button and a menu item are different markup — and rendered one at a time, so there
	is never a second copy of a control in the document to disagree with the first.
-->
{#snippet menu()}
	<li><a data-testid="all-projects" href={resolve('/')}>All Projects</a></li>
	{#if returnLink.current}
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- another origin; see above. -->
		<li><a href={returnLink.current.href}>{returnLink.current.label}</a></li>
	{/if}
{/snippet}

<AppBar
	{wordmark}
	{end}
	{menu}
	theme={theme.current}
	onToggleTheme={() => theme.toggle()}
	homeHref={resolve('/')}
/>

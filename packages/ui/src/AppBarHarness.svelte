<script lang="ts">
	// A stand-in consumer of {@link AppBar}, for `app-bar.dom.test.ts`.
	//
	// The bar takes snippets, and a snippet cannot be written in a test body — so the two apps'
	// arrangements are spelled here instead: identity in `start`, the app's own controls in `end`, and
	// the same controls again as menu items for the width at which they fold. Which of the two an app
	// gets is the whole difference the fold tests are about, so `withMenu` is a prop rather than two
	// harnesses.

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
		/** Whether this app offers foldable items, which is what turns the fold on at all. */
		withMenu?: boolean;
		/** Whether this app hands the masthead a status, which is what turns the two tiers on. */
		withStatus?: boolean;
		/** Whether this app names itself in the masthead. Independent of `withStatus`, so that the
		 * bar's refusal to render a wordmark on a single-row bar can be asserted. */
		withWordmark?: boolean;
		/** Whether the theme control follows the app control in a single-row bar. */
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

<!-- `exactOptionalPropertyTypes`: an optional snippet is absent or a snippet, never `undefined`. -->
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

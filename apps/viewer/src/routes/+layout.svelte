<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import SiteBar from '$lib/SiteBar.svelte';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<!--
	Outside `children()` so it is on every screen of the site — the Front Page, a Project, and a
	Map Image read as a document — and *before* it so it is first in the tab order and first for a
	screen reader: a bar announced after the page it belongs to is a footer.
-->
<div class="flex h-screen flex-col">
	<SiteBar />
	<div class="flex min-h-0 grow flex-col overflow-y-auto">{@render children()}</div>
</div>

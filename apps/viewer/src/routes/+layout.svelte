<script lang="ts">
	import './layout.css';
	import favicon16 from '$lib/assets/favicon-16.png';
	import favicon32 from '$lib/assets/favicon-32.png';
	import SiteBar from '$lib/SiteBar.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" type="image/png" sizes="16x16" href={favicon16} />
	<link rel="icon" type="image/png" sizes="32x32" href={favicon32} />
	<meta name="theme-color" content="#fbfaf7" />
</svelte:head>
<!-- Bar before children: first in tab order and for screen readers. -->
<div class="flex h-screen flex-col">
	<SiteBar />
	<div class="flex min-h-0 grow flex-col overflow-y-auto">{@render children()}</div>
</div>

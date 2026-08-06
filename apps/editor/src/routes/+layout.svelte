<script lang="ts">
	import './layout.css';
	import { refuseUnroutedImageServiceRequests } from '@ballastella/core';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	/**
	 * Make a forgotten `Image#uri` override say so, everywhere in the app (ADR-0004, ADR-0011).
	 *
	 * SPEC calls "every code path constructing an `Image` sets `uri` before requesting a tile" the
	 * most fragile invariant in the project, because `Image#uri` is a plain public field and a
	 * single assignment is exactly what a new code path forgets. What the browser gives that path
	 * for free is a blank map and `TypeError: Failed to fetch` from a DNS failure against
	 * `.invalid` — loud, as ADR-0004 intended, but naming nothing.
	 *
	 * So the placeholder host is refused at the global `fetch` before a request is made, with a
	 * message that names the missing override and the two injection points that supply it. Every
	 * consumer wired today goes through the shim and never reaches this; it is here for the next
	 * one. In an `$effect` rather than at module scope because a module body also runs during
	 * prerendering, where there is no page to guard and nothing has gone wrong.
	 */
	$effect(() => refuseUnroutedImageServiceRequests());
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}

<script lang="ts">
	// The navigation bar both apps wear: the landmark, the layout, the page-chrome slot, the theme
	// control, and what happens to all of it on a phone.
	//
	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// WHAT IS SHARED IS THE SHELL, AND THAT IS THE WHOLE DECISION
	//
	// The editor's bar items are heavy and editor-specific: the Workspace switcher reaches
	// `workspace-storage.svelte.ts`, the remote settings reach the GitHub broker, the install offer
	// reaches the PWA machinery. Moving the bar here wholesale would put every one of them in the
	// viewer's reachable graph — the silent growth ADR-0019 makes a dependency-graph property rather
	// than a hope, and which no tree-shaker is a boundary against. So the bar does **not** move: what
	// moves is the container, and each app hands it its own items as snippets.
	//
	// Nothing here is a `readOnly` or a `mode`. A control an app does not get is a snippet that app
	// does not pass, which is why there is no state in which the two could disagree about what the
	// other is allowed to do.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE FOLD
	//
	// On a phone the bar keeps **where you are and the way home** — the identity in `start` and the
	// screen's own name — and everything else goes into one menu (SPEC story 6: the two things a
	// Reader needs must never be the two things that were dropped).
	//
	// ⚠ **Each foldable affordance is rendered once, never twice.** The usual responsive-navigation
	// spelling — an inline row and a menu, one of them `display: none` — puts two theme toggles in the
	// document, which is two controls that have to agree and a `getByTestId` that can no longer say
	// which one a user pressed. So the choice is made in JavaScript off one media query, and the app
	// spells its items twice because a bar button and a menu item are genuinely different markup.
	//
	// **An app that passes no `menu` never folds**, which is what keeps the editor's bar behaving at
	// every width exactly as it did before this shell existed. Authoring is desktop-only (ADR-0014);
	// a published site is what most people will ever see.

	import { otherTheme, type Theme } from '@ballastella/core';
	import Pencil from '@lucide/svelte/icons/pencil';
	import type { Snippet } from 'svelte';

	import MenuPopover from './MenuPopover.svelte';
	import { pageChrome } from './page-chrome.svelte.js';

	let {
		start,
		end,
		menu,
		theme,
		onToggleTheme,
		homeHref
	}: {
		/** Who you are looking at: the Workspace switcher, or the site's own name. */
		start?: Snippet;
		/** The app's own controls, at a width that has room for them. */
		end?: Snippet;
		/**
		 * The same affordances as `end`, as `<li>` menu items, for the width at which they fold.
		 *
		 * Absent means this app never folds. Present means it does, and that the theme control folds
		 * with it — so nothing in here may be the only way to reach something.
		 */
		menu?: Snippet;
		/** The theme in force, for the control's own words. The signal behind it is the app's. */
		theme: Theme;
		onToggleTheme: () => void;
		/**
		 * The app's own root, already resolved by the app.
		 *
		 * `packages/ui` cannot import `$app/paths` (ADR-0034) — it is generated inside one app's build,
		 * so a module here that used one would resolve to whichever app compiled it. The way-back link
		 * below is the only thing that needs a base path, and the consumer hands it one.
		 */
		homeHref: string;
	} = $props();

	/**
	 * Whether the bar is on a screen too narrow to hold its controls side by side.
	 *
	 * `40rem` rather than the 380 px the ticket names: the fold has to have happened *by* a phone's
	 * width rather than exactly at it, and a tablet held in one hand is no better off with six
	 * controls in a row than a phone is.
	 *
	 * An effect and a listener rather than a read, because a browser window is resized and a phone is
	 * rotated. `false` while there is no window at all, which is what a prerender is: the static file
	 * carries the unfolded bar and hydration corrects it, and the alternative — no bar in the
	 * prerendered HTML — is worse for a Reader whose first paint is that file.
	 */
	let narrow = $state(false);

	$effect(() => {
		const query = window.matchMedia('(max-width: 40rem)');
		narrow = query.matches;
		const follow = () => (narrow = query.matches);
		query.addEventListener('change', follow);
		return () => query.removeEventListener('change', follow);
	});

	const folded = $derived(menu !== undefined && narrow);
</script>

<!--
	`<header>` with a `banner` role by placement. Not `<nav>`: the editor's bar has screens where
	nothing in it navigates, and announcing a navigation landmark with no links in it is a promise the
	bar does not keep.
-->
<header
	data-testid="navigation-bar"
	class="flex flex-wrap items-center gap-4 border-b border-base-300 bg-base-200 px-4 py-2"
>
	{@render start?.()}

	<!--
		Which screen this is and its way up the hierarchy — whatever the screen said, and nothing when a
		screen says nothing. Editor work screens use breadcrumbs; published sites retain their compact
		heading and back-link presentation.

		A real `<h1>`: the bar is before the page's own content, so this is the first heading a screen
		reader reaches. The link is spelled out here rather than handed over finished because
		`svelte/no-navigation-without-resolve` checks the literal start of an `href` — hence `WayBack`
		carrying a Project directory rather than a URL.
	-->
	{#if pageChrome.breadcrumbs.length > 0}
		<nav class="breadcrumbs min-w-0 py-0 text-sm" aria-label="Breadcrumb" data-testid="page-chrome">
			<ul>
				{#each pageChrome.breadcrumbs as crumb (crumb)}
					<li class="min-w-0">
						{#if crumb.destination}
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved by the app. -->
							<a
								class="link truncate link-hover"
								data-testid={crumb.testid}
								href={crumb.destination.project === undefined
									? homeHref
									: `${homeHref}?p=${encodeURIComponent(crumb.destination.project)}`}
							>
								{crumb.label}
							</a>
						{:else}
							<div class="flex min-w-0 items-center gap-1">
								<h1
									class="min-w-0 truncate text-base font-bold"
									data-testid={crumb.testid ?? 'page-heading'}
									aria-current="page"
								>
									{crumb.label}
								</h1>
								{#if crumb.action}
									<button
										type="button"
										class="btn shrink-0 btn-ghost btn-xs"
										data-testid={crumb.action.testid}
										aria-label={crumb.action.label}
										onclick={crumb.action.onClick}
									>
										<Pencil size={14} aria-hidden="true" />
										Edit
									</button>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</nav>
	{:else if pageChrome.heading !== ''}
		<div class="flex min-w-0 items-center gap-3" data-testid="page-chrome">
			<h1 class="truncate text-base font-bold" data-testid="page-heading">
				{pageChrome.heading}
			</h1>
			{#if pageChrome.back}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved by the app,
				     which is the only place that can: see `homeHref`. -->
				<a
					class="btn btn-sm"
					data-testid={pageChrome.back.testid}
					href="{homeHref}?p={encodeURIComponent(pageChrome.back.project)}"
				>
					{pageChrome.back.label}
				</a>
			{/if}
		</div>
	{/if}

	<div class="grow"></div>

	{#if folded && menu}
		<MenuPopover label="Menu" testid="bar-menu" align="end">
			<li>
				<button type="button" data-testid="theme-toggle" onclick={() => onToggleTheme()}>
					Switch to {otherTheme(theme)} theme
				</button>
			</li>
			{@render menu()}
		</MenuPopover>
	{:else}
		<!-- The theme, for the interface and the Base Map together. One control in each app, and it
		     says what it will do rather than what it is. Before the app's own items, which is where
		     the editor's bar has always had it. -->
		<button
			type="button"
			class="btn btn-sm"
			data-testid="theme-toggle"
			onclick={() => onToggleTheme()}
		>
			Switch to {otherTheme(theme)} theme
		</button>
		{@render end?.()}
	{/if}
</header>

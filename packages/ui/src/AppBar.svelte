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
	// screen's own name — and everything else goes into one menu: the two things a Reader needs must
	// never be the two things that were dropped.
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
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE TWO TIERS — NOW AN EYEBROW ABOVE A MAIN ROW
	//
	// An app that passes `status` gets an **eyebrow** above a **main row**, both inside the one
	// `<header>`. The eyebrow is the 14 px muted line that carries what does not change with the
	// route — who you are and whether your work is kept — and the main row is the taller 50 px row
	// that carries where you are and what you can do here. Together they are 64 px, regaining ~20 px
	// over the previous 84 px two-tier bar, while preserving the "Workspace facts vs screen facts"
	// split without costing a full tier.
	//
	// The wordmark is centered in the taller main row (grid `1fr auto 1fr`), not in the eyebrow,
	// so the app's name sits at the visual centre of the bar a reader actually scans.
	//
	// The tiers are two rows in one landmark, never two landmarks and never an inline row beside a
	// hidden duplicate, for the same reason the fold is a choice in JavaScript: every "exactly one of
	// these in the bar" assertion has to keep counting one, and `navigation-bar`'s box is measured as
	// the whole bar.
	//
	// A tiered bar does not fold. Folding is the published site's arrangement and tiering is the
	// editor's; no app passes both, and authoring is desktop-only anyway.

	import { otherTheme, type Theme } from '@ballastella/core';
	import Moon from '@lucide/svelte/icons/moon';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Sun from '@lucide/svelte/icons/sun';
	import type { Snippet } from 'svelte';

	import MenuPopover from './MenuPopover.svelte';
	import { pageChrome } from './page-chrome.svelte.js';

	let {
		start,
		end,
		menu,
		status,
		wordmark,
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
		/**
		 * What is true of the app's own work regardless of the screen — the editor's save indicator and
		 * its warnings.
		 *
		 * Absent means one row, which is the published site's bar. Present puts the bar in two tiers and
		 * renders this in the masthead beside identity, because whether the work is kept is a fact about
		 * the Workspace and not about this screen.
		 */
		status?: Snippet;
		/**
		 * The app's own name, set in the display face, centered in the bar.
		 *
		 * When `status` is present the bar has an eyebrow and a taller main row; the wordmark is centered
		 * in that main row via `1fr auto 1fr`. When `status` is absent (the published site) the bar is a
		 * single row and the wordmark is centered there in the same way. Ignored only if not provided, so
		 * a caller that does not pass it — rather than a rule — decides whether the name appears.
		 *
		 * ADR-0036 gives the display face three jobs — it heads a section, names the app, and titles a
		 * dialog — and this is the second. It must not be a control: the same ADR forbids that face on a
		 * control label, so a wordmark that became a button would break the rule it exists to satisfy.
		 */
		wordmark?: Snippet;
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
	 * `40rem` rather than a phone's own 380 px: the fold has to have happened *by* a phone's
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

	// Written once because the control has two spellings — a `btn` in the bar and an `<li>` in the
	// folded menu — and a scholar meeting either must be told the same thing.
	const themeLabel = $derived(`Switch to ${otherTheme(theme)} theme`);
	const ThemeIcon = $derived(otherTheme(theme) === 'dark' ? Moon : Sun);
</script>

<!--
	Which screen this is and its way up the hierarchy — whatever the screen said, and nothing when a
	screen says nothing. Editor work screens use breadcrumbs; published sites retain their compact
	heading and back-link presentation.

	A real `<h1>`: the bar is before the page's own content, so this is the first heading a screen
	reader reaches. The link is spelled out here rather than handed over finished because
	`svelte/no-navigation-without-resolve` checks the literal start of an `href` — hence `WayBack`
	carrying a Project directory rather than a URL.

	A snippet because the bar has two arrangements to put it in and it may exist in only one of them:
	written twice it would be two of everything below, and a `getByTestId` that can no longer say
	which heading a screen reader reached.
-->
{#snippet chrome()}
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
{/snippet}

<!-- The theme, for the interface and the Base Map together. One control in each app, and it says
     what it will do rather than what it is. A snippet for the same reason `chrome` is one: it has two
     places it can appear — the masthead and the single row — and exactly one of them may hold it. The
     folded menu spells its own control instead, because there it is an `<li>` menu item rather than a
     `btn`; `themeLabel` is shared so the two cannot drift apart in wording. -->
{#snippet themeControl()}
	<button
		type="button"
		class="btn btn-sm"
		data-testid="theme-toggle"
		aria-label={themeLabel}
		onclick={() => onToggleTheme()}
	>
		<ThemeIcon aria-hidden="true" />
	</button>
{/snippet}

<!--
	`<header>` with a `banner` role by placement. Not `<nav>`: the editor's bar has screens where
	nothing in it navigates, and announcing a navigation landmark with no links in it is a promise the
	bar does not keep.

	The padding is on the rows rather than here, so that a tiered bar's rule runs the full width of the
	bar instead of stopping short of its edges.
-->
<header data-testid="navigation-bar" class="border-b border-base-300 bg-base-200">
	{#if status}
		<!--
			Eyebrow: who you are and whether your work is kept. Muted and compact (py-1, text-xs)
			because it is the facts that do not change with the route, not the place a scholar scans
			for where they are.

			Main row: where you are and what you can do here, centered wordmark in the taller row.
			`1fr auto 1fr` keeps the wordmark at the bar's visual centre regardless of how long the
			Workspace name or save state happens to be.

			⚠ **The clusters are top-aligned and each one's leading row is `min-h-8`, which is what
			puts the identity, the save state and the Remote status on one centre line.** Either side
			can grow downwards — a save error, a staleness notice, the time of the last Remote check —
			and centring the clusters instead would lift the taller one's first row above the other's,
			so the two badges a scholar reads together would no longer sit level.
		-->
		<div
			class="flex flex-wrap items-start gap-3 px-4 py-1 text-xs leading-none opacity-80"
			data-testid="bar-eyebrow"
		>
			<div class="flex min-h-8 min-w-0 flex-wrap items-center gap-3">{@render start?.()}</div>
			<div class="grow"></div>
			<div class="flex min-w-0 flex-wrap items-start justify-end gap-2">{@render status()}</div>
		</div>
		<div
			class="grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-t border-rule px-4 py-2.5"
			data-testid="bar-main"
		>
			<div class="flex min-w-0 items-center gap-4">{@render chrome()}</div>
			<div class="flex min-w-0 justify-center">{@render wordmark?.()}</div>
			<div class="flex min-w-0 flex-wrap items-center justify-end gap-3">
				{@render end?.()}
				{@render themeControl()}
			</div>
		</div>
	{:else}
		<div
			class="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 py-2"
			data-testid="bar-single"
		>
			<div class="flex min-w-0 items-center gap-4">{@render start?.()} {@render chrome()}</div>
			<div class="flex min-w-0 justify-center">{@render wordmark?.()}</div>
			<div class="flex min-w-0 flex-wrap items-center justify-end gap-4">
				{#if folded && menu}
					<MenuPopover label="Menu" testid="bar-menu" align="end">
						<li>
							<button
								type="button"
								data-testid="theme-toggle"
								aria-label={themeLabel}
								onclick={() => onToggleTheme()}
							>
								<ThemeIcon aria-hidden="true" />
							</button>
						</li>
						{@render menu()}
					</MenuPopover>
				{:else}
					<!-- Before the app's own items, which is where the editor's bar has always had it. -->
					{@render themeControl()}
					{@render end?.()}
				{/if}
			</div>
		</div>
	{/if}
</header>

<script lang="ts">
	import type { Theme } from '@ballastella/core';
	import Pencil from '@lucide/svelte/icons/pencil';
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';

	import MenuPopover from './MenuPopover.svelte';
	import ThemePicker from './ThemePicker.svelte';
	import { pageChrome } from './page-chrome.svelte.js';

	let {
		start,
		end,
		menu,
		status,
		wordmark,
		theme,
		themeLast = false,
		onSelectTheme,
		homeHref
	}: {
		start?: Snippet;
		end?: Snippet;
		menu?: Snippet;
		status?: Snippet;
		wordmark?: Snippet;
		theme: Theme;
		themeLast?: boolean;
		onSelectTheme: (theme: Theme) => void;
		/** The way-back link below is the only thing that needs a base path, and the consumer hands it one. */
		homeHref: string;
	} = $props();

	const narrow = new MediaQuery('max-width: 40rem', false);
	const folded = $derived(menu !== undefined && narrow.current);
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
							<div class="breadcrumb-current flex min-w-0 items-center gap-1">
								<h1
									class="min-w-0 truncate text-base font-bold hover:underline"
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

{#snippet themeControl(buttonClass = 'btn btn-sm')}
	<ThemePicker {theme} onSelect={onSelectTheme} {buttonClass} />
{/snippet}

<header data-testid="navigation-bar" class="relative z-[60] border-b border-base-300 bg-base-200">
	{#if status}
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
							{@render themeControl('w-full justify-start')}
						</li>
						{@render menu()}
					</MenuPopover>
				{:else}
					{#if themeLast}
						{@render end?.()}
						{@render themeControl()}
					{:else}
						{@render themeControl()}
						{@render end?.()}
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</header>

<style>
	.breadcrumb-current:hover {
		text-decoration-line: none;
	}
</style>

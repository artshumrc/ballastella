<script lang="ts">
	// The Published Site: a hub page listing the Projects, and one Project when `?p=` names it.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHY THE PROJECT LIST IS FETCHED RATHER THAN WALKED
	//
	// A static host has no directory listing, so nothing here can discover which folders hold a
	// Project the way the editor's Workspace does. Publishing therefore writes the list into
	// `ballastella-site.json` (ADR-0006's HTTP reader, ADR-0008's hub page), and this page reads it.
	// That record also carries the Base Map catalog the authoring deployment resolved, so a
	// Published Site keeps working when that deployment later changes its own catalog (ADR-0020).
	//
	// Everything is fetched **relative** to this document, never from `/` (ADR-0006): one build has
	// to serve `username.github.io/some-repo/` and a custom domain root, and which one is unknown at
	// build time. See `$lib/site-files`.
	//
	// ADR-0008 chose `?p=<folder>` over per-Project URLs so that the static adapter prerenders one
	// page: no SPA fallback, no post-build path rewriting, and nothing per-Project to keep in sync
	// when a Project is renamed or deleted.
	//
	// Reading the work — the maps, the Annotations and their popups, the Base Map switcher, unwarped
	// viewing — is ticket 17. What is here is the way in, and what each Project contains.

	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		PUBLISHED_SITE_RECORD_NAME,
		ProjectFormatTooNewError,
		baseMapFallbackNotice,
		isDescriptionRendererSupported,
		parseProjectFile,
		parsePublishedSite,
		projectFilePath,
		resolveBaseMap,
		type ProjectFile,
		type PublishedSite
	} from '@ballastella/core';
	import { onMount } from 'svelte';

	import { annotationHtml } from '$lib/annotation-text';
	import { readSiteFile } from '$lib/site-files';

	/**
	 * The site's own prose, authored as Markdown so that the emphasis and the link below are produced
	 * by `marked` and then sanitised by DOMPurify — the same two stages, in the same order, that a
	 * scholar's Annotation `description` goes through (ADR-0009). Keeping the shared path live in the
	 * viewer's shipped bundle is what makes ticket 17's "the payload inert in the editor is inert
	 * here" assertion mean anything: a reimplementation would have to remove working code.
	 */
	const about = {
		description:
			'These are the Projects published from one Ballastella Workspace. A Reader can *look* at ' +
			'the work — the aligned Historical Maps and the Annotations written over them — and ' +
			'**cannot change it**. Published with ' +
			'[Ballastella](https://github.com/artshumrc/ballastella#readme).'
	};

	/**
	 * Whether the page has hydrated, which gates the `{@html}` render for **two** reasons.
	 *
	 * The first is a requirement: this app prerenders (ADR-0006) and DOMPurify needs a DOM, so the
	 * renderer refuses in Node rather than degrading to returning its input — the safe direction,
	 * since a fallback returning unsanitised HTML would write an XSS payload into a static file.
	 *
	 * The second is a Svelte hydration rule worth writing down because it was found the hard way.
	 * **`{@html}` is not re-rendered during hydration**: Svelte adopts whatever nodes the server
	 * produced and never compares them against the client's value. So a `{@html}` whose expression
	 * was `''` on the server and complete HTML on the client renders *nothing at all*, permanently,
	 * with no error and no hydration warning. Gating on a flag that is false during the client's
	 * first render and true immediately after makes the value genuinely *change* after hydration,
	 * which is what makes Svelte update it.
	 *
	 * That failure deserves a test rather than only a comment, because **a blank render surface
	 * passes every "is the payload inert?" assertion.** So `e2e/viewer.e2e.ts` asserts the text **is**
	 * present as well as that the markup is not.
	 */
	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
	});

	const aboutHtml = $derived(
		hydrated && isDescriptionRendererSupported() ? annotationHtml(about) : ''
	);

	/**
	 * The Project asked for, or `null` for the hub.
	 *
	 * Gated on `hydrated` because **`page.url.searchParams` throws during prerendering**: SvelteKit
	 * refuses it outright, since a prerendered page is one file serving every query string and a build
	 * that read one would bake a single Project's answer into it. That refusal is the mechanism
	 * ADR-0008 is relying on when it says `?p=` needs no per-Project artefact — the selection is
	 * client-side by construction. So this is `null` while the static file is being written, and the
	 * prerendered HTML is the hub's own skeleton.
	 */
	const openDirectory = $derived(hydrated ? page.url.searchParams.get('p') : null);

	let site = $state<PublishedSite | null>(null);
	/** Why the site record could not be read. A site with no record is not a site at all. */
	let siteError = $state('');

	let openProject = $state<{ directory: string; file: ProjectFile } | null>(null);
	let projectError = $state('');

	$effect(() => {
		// Only in the browser: prerendering has no site to read, and the record is written by
		// publishing rather than by the build.
		if (!hydrated) return;
		void (async () => {
			try {
				site = parsePublishedSite(await readSiteFile(PUBLISHED_SITE_RECORD_NAME));
				siteError = '';
			} catch (cause) {
				siteError = cause instanceof Error ? cause.message : String(cause);
			}
		})();
	});

	$effect(() => {
		const directory = openDirectory;
		if (!hydrated || directory === null) {
			openProject = null;
			projectError = '';
			return;
		}
		void (async () => {
			try {
				const file = parseProjectFile(await readSiteFile(projectFilePath(directory)));
				// A read that arrives after the Reader has moved on must not overwrite what is showing.
				if (openDirectory !== directory) return;
				openProject = { directory, file };
				projectError = '';
			} catch (cause) {
				if (openDirectory !== directory) return;
				openProject = null;
				projectError =
					cause instanceof ProjectFormatTooNewError
						? cause.message
						: `There is no Project called “${directory}” on this site.`;
			}
		})();
	});

	/** What this site calls itself in the tab. The hub has no name of its own beyond the tool's. */
	const title = $derived(
		openProject ? `${openProject.file.name} — Ballastella` : 'Ballastella — published Projects'
	);

	/**
	 * The Base Map a Reader sees first, resolved against the catalog that travelled with the site
	 * rather than against this build's (ADR-0020). Switching is ticket 17; the author's default is
	 * what governs first contact, which is the moment that carries the argument.
	 */
	const baseMap = $derived(
		site && openProject ? resolveBaseMap(openProject.file.baseMap, site.baseMap) : null
	);

	/**
	 * The Layers whose Historical Map is still fetched from the library that holds it (SPEC story 29).
	 *
	 * Said out loud on the page rather than only warned about at publish time, because the Reader is
	 * the person who meets the consequence: on a train, or after the library reorganises, those
	 * Layers draw nothing (ADR-0007).
	 */
	const needsNetwork = $derived(
		(openProject?.file.layers ?? []).filter(
			(layer) => layer.kind === 'map' && layer.imageMode === 'referenced'
		)
	);
</script>

<svelte:head><title>{title}</title></svelte:head>

<main class="mx-auto max-w-4xl p-8">
	{#if openDirectory === null}
		<h1 class="text-3xl font-bold">Published Projects</h1>

		<!--
			`{@html}`, and safe for one reason only: `aboutHtml` is DOMPurify's own output. There is no
			path into this expression that has not been through the sanitiser, and there must never be one.
		-->
		<div class="mt-4 prose" data-testid="viewer-annotation-text">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			{@html aboutHtml}
		</div>

		{#if siteError}
			<div role="alert" class="mt-8 alert flex-col items-start alert-warning">
				<h2 class="font-semibold">This site has no list of Projects</h2>
				<p>{siteError}</p>
			</div>
		{:else if site === null}
			<p class="mt-8">Looking for the Projects on this site…</p>
		{:else if site.projects.length === 0}
			<p class="mt-8">This site has no Projects on it yet.</p>
		{:else}
			<ul class="mt-8 flex flex-col gap-3" data-testid="published-projects">
				{#each site.projects as project (project.directory)}
					<li class="card bg-base-100 card-border">
						<div class="card-body">
							<h2 class="text-lg font-medium">
								<!--
									Interpolated as text, never as markup. A display name comes out of a `project.json`
									and is untrusted content: this site runs on the author's own domain, so a name
									carrying `<img src=x onerror=…>` rendered as HTML would be stored XSS there
									(ADR-0009). Svelte escapes it, and `e2e/editor-publish.e2e.ts` asserts both halves —
									that the real name is on the page, and that no element came with it.
								-->
								<a class="link" href={resolve(`/?p=${encodeURIComponent(project.directory)}`)}
									>{project.name}</a
								>
							</h2>
							<p class="text-sm opacity-70">folder <code>{project.directory}</code></p>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	{:else}
		<!--
			Through `resolve`, which under `paths.relative: true` emits a relative URL — so the link works
			at a domain root and in a subdirectory alike (ADR-0006), and the prerendered HTML carries no
			absolute path for the CI fence to find.
		-->
		<p><a class="link" href={resolve('/')}>All Projects</a></p>

		{#if projectError}
			<div role="alert" class="mt-4 alert flex-col items-start alert-warning">
				<h1 class="text-xl font-semibold">This Project is not on this site</h1>
				<p>{projectError}</p>
			</div>
		{:else if openProject === null}
			<p class="mt-4">Opening…</p>
		{:else}
			<h1 class="mt-2 text-3xl font-bold" data-testid="project-name">{openProject.file.name}</h1>

			<h2 class="mt-8 text-xl font-semibold">What is in this Project</h2>
			{#if openProject.file.layers.length === 0}
				<p class="mt-2">Nothing yet: this Project has no Layers.</p>
			{:else}
				<ul class="mt-2 flex flex-col gap-2" data-testid="project-layers">
					{#each openProject.file.layers as layer (layer.id)}
						<li class="flex flex-wrap items-baseline gap-2">
							<span class="font-medium">{layer.name}</span>
							<span class="text-sm opacity-70">
								{layer.kind === 'map' ? 'aligned Historical Map' : 'Annotations'}
							</span>
						</li>
					{/each}
				</ul>
			{/if}

			{#if baseMap}
				<p class="mt-6 text-sm opacity-80" data-testid="project-base-map">
					Base Map: {baseMap.entry.label}
				</p>
				{#if baseMapFallbackNotice(baseMap)}
					<p class="mt-1 text-sm text-warning">{baseMapFallbackNotice(baseMap)}</p>
				{/if}
			{/if}

			{#if needsNetwork.length > 0}
				<p class="mt-6 text-sm text-warning" data-testid="project-needs-network">
					{needsNetwork.length === 1
						? 'One Historical Map'
						: `${needsNetwork.length} Historical Maps`}
					here {needsNetwork.length === 1 ? 'is' : 'are'} held on the library's own server rather than
					in this site: {needsNetwork.map((layer) => layer.name).join(', ')}. Without a network
					connection {needsNetwork.length === 1 ? 'it' : 'they'} cannot be shown.
				</p>
			{/if}
		{/if}
	{/if}
</main>

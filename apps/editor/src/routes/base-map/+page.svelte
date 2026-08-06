<script lang="ts">
	import { baseMapFallbackNotice, otherTheme, resolveBaseMap } from '@ballastella/core';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	import BaseMapPane from '$lib/base-map/BaseMapPane.svelte';
	import BaseMapSwitcher from '$lib/base-map/BaseMapSwitcher.svelte';
	import SaveIndicator from '$lib/components/SaveIndicator.svelte';
	import { EditorSession } from '$lib/editor-session.svelte.js';
	import { theme, startTheme } from '$lib/theme.svelte';

	/**
	 * The Base Map pane over one Project.
	 *
	 * A Project is addressed by query parameter (ADR-0008) and is **opened, never created**: this
	 * page reads `project.json` through {@link EditorSession} and writes the author's default back
	 * through the same one. There is no second writer and no second in-memory copy of the
	 * document, which is what keeps recording a Base Map from being able to drop a `name`, a
	 * `layers` list, or a `formatVersion: 2` refusal — and ticket 07 puts this pane and the
	 * Project view on one page, where a second writer would be a race inside one component.
	 */
	const openDirectory = $derived(page.url.searchParams.get('p'));

	// The store is OPFS, which exists only in the browser, so the session is created after mount.
	let session = $state<EditorSession | null>(null);

	/**
	 * Why this browser cannot hold a Workspace at all, if it cannot. Set in an effect rather than
	 * at component scope because the answer is `false` during prerendering too, where there is no
	 * `navigator.storage` and nothing has gone wrong.
	 */
	let unsupported = $state('');

	$effect(() => {
		startTheme();
		// Read into a local rather than back out of the state it just set: an effect that reads the
		// `$state` it writes takes a dependency on itself.
		const reason = EditorSession.unsupportedReason();
		unsupported = reason;
		if (reason) return;
		const created = EditorSession.opfs();
		session = created;
		return created.installFlushOnHide();
	});

	$effect(() => {
		void session?.open(openDirectory);
	});

	/**
	 * The author's default resolved against this deployment's catalog, or `null` until the Project
	 * is open. An id this deployment does not carry falls back to the deployment default and says
	 * so (ADR-0020); it must not throw and must not render a blank map, because a Base Map that
	 * fails to resolve otherwise renders a plausible-looking but *wrong* map.
	 */
	const resolution = $derived(
		session?.openProject ? resolveBaseMap(session.openProject.baseMap) : null
	);
	// Reads as `null` once the author has chosen something this deployment carries, because
	// `fellBack` is then false. Nothing has to remember to clear it.
	const notice = $derived(resolution === null ? null : baseMapFallbackNotice(resolution));
</script>

<svelte:head><title>Base Map — Ballastella Editor</title></svelte:head>

<div class="flex h-screen flex-col">
	<header class="flex flex-wrap items-end gap-4 border-b border-base-300 bg-base-200 p-4">
		<h1 class="text-xl font-bold">Base Map</h1>

		{#if resolution !== null}
			<div class="flex flex-col">
				<BaseMapSwitcher
					entryId={resolution.entry.id}
					onSelect={(id) => session?.chooseBaseMap(id)}
				/>
			</div>
		{/if}

		<!--
			One signal, one control. Clicking this repaints the interface and reselects the Protomaps
			flavor in the same action — see `$lib/theme.svelte.ts` and ADR-0016.
		-->
		<button type="button" class="btn btn-sm" onclick={() => theme.toggle()}>
			Switch to {otherTheme(theme.current)} theme
		</button>

		<p class="grow text-sm text-base-content/70" role="status" aria-live="polite">
			{notice ?? ''}
		</p>

		{#if session !== null}
			<!-- ADR-0017 rule 5: there is no Save button, so this is the only signal that the
			     author's choice reached storage. -->
			<div class="flex flex-col items-end">
				<SaveIndicator saveState={session.saveState} />
				{#if session.saveError}
					<p class="text-sm text-warning">{session.saveError}</p>
				{/if}
			</div>
		{/if}
	</header>

	<div class="relative grow">
		{#if unsupported}
			<div role="alert" class="m-4 alert flex-col items-start alert-warning">
				<h2 class="font-semibold">No storage for a Workspace</h2>
				<p>{unsupported}</p>
			</div>
		{:else if session === null}
			<p class="p-4">Starting…</p>
		{:else if openDirectory === null}
			<div role="alert" class="m-4 alert flex-col items-start alert-info">
				<h2 class="font-semibold">No Project chosen</h2>
				<p>
					A Base Map is the author's default for one Project, so this pane needs a Project to open.
					Opening it cannot create one.
				</p>
				<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
			</div>
		{:else if session.status === 'unreachable'}
			<!-- ADR-0008: a normal state with a recovery, never an error boundary. -->
			<div role="alert" class="m-4 alert flex-col items-start alert-warning">
				<h2 class="font-semibold">Workspace not reachable</h2>
				<p>
					Your Workspace could not be opened, so this Project cannot be shown. Nothing has been lost
					— it is still wherever it was.
				</p>
				{#if session.unreachableDetail}
					<p class="text-sm opacity-80">The browser reported: {session.unreachableDetail}</p>
				{/if}
				<button class="btn btn-sm" onclick={() => session?.open(openDirectory)}
					>Locate Workspace again</button
				>
			</div>
		{:else if session.projectProblem}
			<div role="alert" class="m-4 alert flex-col items-start alert-warning">
				<h2 class="font-semibold">
					{session.projectProblem.kind === 'missing'
						? 'Project not found'
						: 'This Project cannot be opened'}
				</h2>
				<p>{session.projectProblem.message}</p>
				<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
			</div>
		{:else if resolution === null}
			<p class="p-4">Opening Project “{openDirectory}”…</p>
		{:else}
			<BaseMapPane entryId={resolution.entry.id} />
		{/if}
	</div>
</div>

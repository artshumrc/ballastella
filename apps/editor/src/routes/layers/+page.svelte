<script lang="ts">
	// The Project composed: its Layer stack over its Base Map (SPEC stories 49–54).
	//
	// A pane of its own rather than a panel beside the alignment workspace, because the two are about
	// different things. Aligning is one Historical Map being placed on the earth; the stack is the
	// whole Project, every Layer of it drawn together in the order the author chose — which is the
	// thing tickets 16 and 17 publish, and the thing a reader eventually sees. It also keeps one
	// WebGL context and one warped renderer on the page rather than two.
	//
	// The Project is addressed by query parameter and is **opened, never created** (ADR-0008), and
	// every write goes through the app's one `EditorSession`: there is no second in-memory copy of
	// `project.json` and no second writer of it, which matters more here than anywhere else in the app
	// because the Layer list is the field whose loss is "not one annotation but the map of everything"
	// (ADR-0017 rule 4).

	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		baseMapFallbackNotice,
		otherTheme,
		resolveBaseMap,
		type Alignment,
		type AnnotationLayer,
		type Layer,
		type MapLayer
	} from '@ballastella/core';
	import { untrack } from 'svelte';

	import BaseMapPane from '$lib/base-map/BaseMapPane.svelte';
	import BaseMapSwitcher from '$lib/base-map/BaseMapSwitcher.svelte';
	import SaveIndicator from '$lib/components/SaveIndicator.svelte';
	import WorkspaceRecovery from '$lib/components/WorkspaceRecovery.svelte';
	import LayerList from '$lib/layers/LayerList.svelte';
	import type { DrawnLayer, DrawnOutcome } from '$lib/layers/stack-layers';
	import { startTheme, theme } from '$lib/theme.svelte';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	const openDirectory = $derived(page.url.searchParams.get('p'));

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);

	$effect(() => {
		startTheme();
	});

	$effect(() => {
		void session?.open(openDirectory);
	});

	const resolution = $derived(
		session?.openProject ? resolveBaseMap(session.openProject.baseMap) : null
	);
	const notice = $derived(resolution === null ? null : baseMapFallbackNotice(resolution));

	const layers = $derived<readonly Layer[]>(session?.openProject?.layers ?? []);

	/**
	 * The Layers that could be on the map: visible, and of a kind this build can draw.
	 *
	 * A hidden Layer is *absent* from what the map is given rather than flagged inside it, so there is
	 * no second place where a Layer can be in the stack and not drawn. A `foreign` Layer is absent for
	 * the same reason and says so in the list (ADR-0014).
	 */
	const shown = $derived(
		layers.filter(
			(layer): layer is MapLayer | AnnotationLayer => layer.visible && layer.kind !== 'foreign'
		)
	);

	/**
	 * What requires the referenced documents to be read again: which Layers are drawn, and out of which
	 * files. **Not** the name and not the opacity, which are display state and must not cost a read of
	 * the store — a rename that re-read every Alignment would make the cheapest edit in the application
	 * one of the most expensive.
	 *
	 * **A string, and the effect below reads nothing else that is tracked.** Deriveds compare by
	 * reference and `shown` is a fresh array from `.filter()` on every change to `layers`, so an effect
	 * that reads `shown` has `layers` as its real dependency however carefully it computes a key first.
	 * That is what this guard used to be: the key was computed, discarded with `void`, and `shown` read
	 * on the next line — so a rename cost a re-read of every Alignment, and one drag of the opacity
	 * slider at `step="0.05"` cost twenty of them per Layer.
	 */
	const documentKey = $derived(
		JSON.stringify(
			shown.map((layer) => [layer.id, layer.kind === 'map' ? layer.alignmentRef : layer.geojsonRef])
		)
	);

	/**
	 * Each drawn Layer's document, by Layer id: an `Alignment`, or a parsed `FeatureCollection`.
	 *
	 * Plain records rather than `Map`s, and `$state.raw` rather than `$state`: nothing here is mutated
	 * in place — a load replaces the whole record — which is what makes a mutable reactive collection
	 * the wrong primitive for it.
	 */
	let documents = $state.raw<Readonly<Record<string, unknown>>>({});
	/** Why a Layer's own file could not be read, by Layer id. */
	let unreadable = $state.raw<Readonly<Record<string, string>>>({});
	/** Bumped by every load, so a read that resolves late knows it has been superseded. */
	let generation = 0;

	$effect(() => {
		// The two tracked dependencies: which files to read, and the session to read them from. `shown`
		// is read *untracked*, so a rename or a dragged slider — neither of which changes which Layers
		// are drawn or out of which files — cannot reach the store at all. See {@link documentKey}.
		void documentKey;
		const current = session;
		const wanted = untrack(() => shown);
		if (!current) return;
		const mine = ++generation;
		void (async () => {
			const read: Record<string, unknown> = {};
			const failures: Record<string, string> = {};
			for (const layer of wanted) {
				try {
					const document =
						layer.kind === 'map'
							? await current.readLayerAlignment(layer)
							: await current.readLayerFeatures(layer);
					if (document !== null) read[layer.id] = document;
				} catch (cause) {
					// Said, never swallowed. A Layer whose file is there and unreadable means work the user
					// made is not on screen, and drawing nothing quietly is how they find out too late.
					failures[layer.id] = cause instanceof Error ? cause.message : String(cause);
				}
			}
			if (mine !== generation) return;
			documents = read;
			unreadable = failures;
		})();
	});

	/** The stack as the map takes it: top first, each Layer with its document in hand. */
	const drawn = $derived<readonly DrawnLayer[]>(
		shown.flatMap((layer): DrawnLayer[] => {
			const document = documents[layer.id];
			if (layer.kind === 'map') {
				// A map Layer with no Alignment yet is not handed to the map at all: there is nothing to
				// place it by, and `showAlignment` would have to refuse it a second time.
				return document === undefined ? [] : [{ layer, alignment: document as Alignment }];
			}
			return [{ layer, features: document ?? null }];
		})
	);

	/** What the map made of each Layer it was given. */
	let rendered = $state.raw<Readonly<Record<string, DrawnOutcome>>>({});

	/**
	 * What the list says about each Layer: what the map reported, plus the Layers the map never got.
	 *
	 * A map Layer with no Alignment file yet is the ordinary first state of a Historical Map somebody
	 * has only just brought in, so it is a sentence rather than an error.
	 */
	const outcomes = $derived.by((): Readonly<Record<string, DrawnOutcome>> => {
		const merged: Record<string, DrawnOutcome> = { ...rendered };
		for (const [id, reason] of Object.entries(unreadable)) {
			merged[id] = { status: 'refused', reason };
		}
		for (const layer of shown) {
			if (merged[layer.id] || documents[layer.id] !== undefined) continue;
			merged[layer.id] = {
				status: 'refused',
				reason:
					layer.kind === 'map'
						? 'Not aligned yet, so there is nothing to draw.'
						: 'No Annotations in this Layer yet.'
			};
		}
		return merged;
	});

	const fetchTile = $derived(session?.imageServiceFetch() ?? undefined);

	/** How many Layers are actually on the map. Said, because "nothing is drawn" has many reasons. */
	const drawnCount = $derived(
		Object.values(outcomes).filter((outcome) => outcome.status === 'drawn').length
	);

	const annotationLayerCount = $derived(
		layers.filter((layer) => layer.kind === 'annotation').length
	);
</script>

<svelte:head><title>Layers — Ballastella Editor</title></svelte:head>

<div class="flex min-h-screen flex-col">
	<header class="flex flex-wrap items-end gap-4 border-b border-base-300 bg-base-200 p-4">
		<h1 class="text-xl font-bold">Layers</h1>

		{#if resolution !== null}
			<BaseMapSwitcher
				entryId={resolution.entry.id}
				onSelect={(id) => session?.chooseBaseMap(id)}
			/>
		{/if}

		<button type="button" class="btn btn-sm" onclick={() => theme.toggle()}>
			Switch to {otherTheme(theme.current)} theme
		</button>

		<p class="grow text-sm text-base-content/70" aria-live="polite">{notice ?? ''}</p>

		{#if session !== null}
			<!-- ADR-0017 rule 5: there is no Save button, so this is the only signal that a reorder,
			     a rename, or a visibility toggle reached storage. -->
			<div class="flex flex-col items-end">
				<SaveIndicator saveState={session.saveState} />
				{#if session.saveError}
					<p class="text-sm text-warning">{session.saveError}</p>
				{/if}
			</div>
		{/if}
	</header>

	{#if host.unsupported}
		<div role="alert" class="m-4 alert flex-col items-start alert-warning">
			<h2 class="font-semibold">No storage for a Workspace</h2>
			<p>{host.unsupported}</p>
		</div>
	{:else if storage === null || session === null}
		<p class="p-4">Starting…</p>
	{:else if openDirectory === null}
		<div role="alert" class="m-4 alert flex-col items-start alert-info">
			<h2 class="font-semibold">No Project chosen</h2>
			<p>A Layer stack belongs to one Project, so this pane needs a Project to open.</p>
			<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
		</div>
	{:else if session.status === 'unreachable' || storage.awaitingFolder}
		<div class="m-4">
			<WorkspaceRecovery {storage} />
			<p class="mt-6"><a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a></p>
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
		<div class="grid grow items-start gap-4 p-4 lg:grid-cols-[24rem_1fr]">
			<div>
				<LayerList
					{layers}
					{outcomes}
					ontypename={(id, name) => session.typeLayerName(id, name)}
					oncommit={() => session.commitLayerEdit()}
					onshow={(id, visible) => session.showLayer(id, visible)}
					ondragopacity={(id, opacity) => session.dragLayerOpacity(id, opacity)}
					onmove={(id, toIndex) => session.moveLayerTo(id, toIndex)}
				/>

				<button
					class="btn mt-4 btn-sm"
					data-testid="add-annotation-layer"
					onclick={() => session.addAnnotationLayer(`Annotations ${annotationLayerCount + 1}`)}
				>
					Add an Annotation Layer
				</button>

				<!--
					Back to the Project first, and to the hub second. The stack is where a user notices that
					a Control Point needs fixing — the Historical Map is visibly in the wrong place — and
					without this the only way back to the alignment workspace was out to the hub and in
					again. The Project is addressed by query parameter (ADR-0008), so this is the same link
					`ProjectView` uses to get here, in reverse.
				-->
				<p class="mt-6 flex flex-wrap gap-4">
					<a class="link" data-testid="back-to-project" href="{resolve('/')}?p={openDirectory}">
						Back to this Project
					</a>
					<a class="link" href={resolve('/')}>Back to all Projects</a>
				</p>
			</div>

			<div>
				<div class="h-[36rem] overflow-hidden rounded border border-base-300">
					<BaseMapPane
						entryId={resolution.entry.id}
						layers={drawn}
						{fetchTile}
						onstack={(reported) => (rendered = reported)}
					/>
				</div>
				<!--
					What is on the map, in words. `aria-live` rather than `role="status"`, because the save
					indicator already owns that role on this page — the same reason the ingest progress region
					and the pairing prompt are `aria-live` too.
				-->
				<p
					class="mt-2 min-h-6 text-sm"
					aria-live="polite"
					aria-atomic="true"
					data-testid="stack-status"
					data-drawn={drawnCount}
				>
					{#if layers.length === 0}
						Nothing is on the map yet.
					{:else}
						{drawnCount} of {layers.length}
						{layers.length === 1 ? 'Layer is' : 'Layers are'} drawn over the Base Map.
					{/if}
				</p>
			</div>
		</div>
	{/if}
</div>

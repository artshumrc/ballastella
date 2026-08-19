<script lang="ts">
	import type { ProjectSummary, WorkspaceMapImage } from '@ballastella/core';
	import { untrack } from 'svelte';

	import type { EditorSession } from '../editor-session.svelte.js';
	import { provideWorkspaceHost } from '../workspace-storage.svelte.js';
	import ProjectHub from './ProjectHub.svelte';

	/**
	 * `ProjectHub` under a parent that really holds its Workspace in `$state`.
	 *
	 * Two things make this a component rather than a `mount` call in the test body.
	 *
	 * **The hub reads a `WorkspaceHost` out of context**, which only a parent component can put
	 * there. The real `WorkspaceHost` constructor does nothing but declare state — the browser-only
	 * work is in `begin()`, which is never called here — so it is the real one rather than a fake.
	 *
	 * ⚠ **Nothing below reaches a store.** Every claim asserted against this harness is a claim about
	 * what the hub *renders and announces*; what the Workspace does with a deletion is
	 * `packages/core`'s, and that it reaches OPFS at all is `e2e/`'s.
	 */
	let {
		mapImages = [],
		projects = [],
		mapImagesLoading = false
	}: {
		mapImages?: readonly WorkspaceMapImage[];
		projects?: readonly ProjectSummary[];
		mapImagesLoading?: boolean;
	} = $props();

	// Seeds, captured once on purpose: after mount the harness owns these lists and the hub changes
	// them through the session below. `untrack` says so, rather than leaving the compiler to warn
	// about a prop read that looks like an oversight.
	let maps = $state(untrack(() => [...mapImages]));
	let listed = $state(untrack(() => [...projects]));

	provideWorkspaceHost();

	/**
	 * The session surface the hub reads, and only that.
	 *
	 * Cast rather than implemented: `EditorSession` is a 3000-line class over a real store, and the
	 * hub touches about twenty of its members. Writing the other several hundred as stubs would say
	 * nothing and would break whenever the class grew a method the hub never calls.
	 */
	const session = {
		get status() {
			return 'ready';
		},
		get projects() {
			return listed;
		},
		get mapImages() {
			return maps;
		},
		get mapImagesLoading() {
			return mapImagesLoading;
		},
		mapImageError: '',
		projectProblem: null,
		transfer: null,
		transferError: '',
		dismissMapImageError: () => {},
		dismissProjectProblem: () => {},
		refreshMapImages: async () => {},
		// The hub deletes through the session and then re-renders from what the session now holds.
		deleteMapImage: async (imageId: string) => {
			maps = maps.filter((map) => map.imageId !== imageId);
			return true;
		},
		createProject: async () => {},
		renameProject: async () => {},
		duplicateProject: async () => {},
		deleteProject: async () => {},
		exportProject: async () => {},
		baseMapCacheSize: async () => ({ tiles: 0, bytes: 0 }),
		clearBaseMapCache: async () => 0,
		// A Map Image's picture is its own coarsest tile, read through the ADR-0011 shim. No
		// fixture here carries a `thumbnail`, so this is never called; it exists so the hub can ask.
		imageServiceFetch: () => async () => new Response(null, { status: 404 })
	} as unknown as EditorSession;
</script>

<ProjectHub {session} />

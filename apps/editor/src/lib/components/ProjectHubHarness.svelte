<script lang="ts">
	import {
		observedShareLinks,
		type ProjectSummary,
		type WorkspaceMapImage
	} from '@ballastella/core';
	import { untrack } from 'svelte';

	import type { EditorSession } from '../editor-session.svelte.js';
	import { provideWorkspaceHost, type WorkspaceStorage } from '../workspace-storage.svelte.js';
	import ProjectHub from './ProjectHub.svelte';

	let {
		mapImages = [],
		projects = [],
		mapImagesLoading = false,
		shareLinks = false,
		remoteShareLinks = false,
		withdrawing = false,
		requests,
		synced = []
	}: {
		mapImages?: readonly WorkspaceMapImage[];
		projects?: readonly ProjectSummary[];
		mapImagesLoading?: boolean;
		shareLinks?: boolean;
		remoteShareLinks?: boolean;
		withdrawing?: boolean;
		requests?: (member: string) => void;
		synced?: readonly string[];
	} = $props();

	let maps = $state(untrack(() => [...mapImages]));
	let listed = $state(untrack(() => [...projects]));
	const host = provideWorkspaceHost();
	host.storage = {
		review: null,
		transfer: null,
		remote: {
			hasShareLinks: async () =>
				observedShareLinks({ workspace: shareLinks, remote: remoteShareLinks, withdrawing }),
			projectReach: async (directory: string) => ({
				synced: synced.includes(directory),
				unsent: !synced.includes(directory)
			}),
			check: async () => requests?.('check'),
			readRights: async () => {
				requests?.('readRights');
				return { canPush: false };
			},
			readSharing: async () => {
				requests?.('readSharing');
				return { shared: false, known: false, owner: 'ada', others: [] };
			},
			enableShareLinks: async () => requests?.('enableShareLinks')
		}
	} as unknown as WorkspaceStorage;

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
		dismissMapImageError: () => {},
		dismissProjectProblem: () => {},
		refreshMapImages: async () => {},
		deleteMapImage: async (imageId: string) => {
			maps = maps.filter((map) => map.imageId !== imageId);
			return true;
		},
		createProject: async () => {},
		duplicateProject: async () => {},
		deleteProject: async () => {},
		imageServiceFetch: () => async () => new Response(null, { status: 404 })
	} as unknown as EditorSession;
</script>

<ProjectHub {session} />

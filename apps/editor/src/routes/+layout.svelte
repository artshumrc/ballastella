<script lang="ts">
	import './layout.css';
	import { refuseUnroutedImageServiceRequests } from '@ballastella/core';
	import { afterNavigate } from '$app/navigation';
	import { asset } from '$app/paths';
	import { startAnalytics, trackPageview } from '$lib/analytics';
	import favicon16 from '$lib/assets/favicon-16.png';
	import favicon32 from '$lib/assets/favicon-32.png';
	import NavigationBar from '$lib/components/NavigationBar.svelte';
	import RecoveredEdits from '$lib/components/RecoveredEdits.svelte';
	import ResumeFolderWorkspace from '$lib/components/ResumeFolderWorkspace.svelte';
	import ReviewBanner from '$lib/components/ReviewBanner.svelte';
	import UpdatePrompt from '$lib/pwa/UpdatePrompt.svelte';
	import { provideInstalledApp } from '$lib/pwa/installed-app.svelte.js';
	import { theme } from '$lib/theme.svelte';
	import ToastStack from '$lib/toasts/ToastStack.svelte';
	import { provideWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	let { children } = $props();

	const host = provideWorkspaceHost();
	$effect(() => host.begin());
	$effect(() => refuseUnroutedImageServiceRequests());
	const installedApp = provideInstalledApp();
	$effect(() => installedApp.start());
	$effect(() => theme.start());
	$effect(() => startAnalytics());
	afterNavigate(trackPageview);
</script>

<svelte:head>
	<link rel="icon" type="image/png" sizes="16x16" href={favicon16} />
	<link rel="icon" type="image/png" sizes="32x32" href={favicon32} />
	<link rel="manifest" href={asset('/manifest.webmanifest')} />
	<meta name="theme-color" content="#fbfaf7" />
</svelte:head>
<div class="flex h-screen flex-col">
	<NavigationBar />
	<ReviewBanner />
	<RecoveredEdits />
	<div class="min-h-0 grow overflow-y-auto">{@render children()}</div>
</div>
<UpdatePrompt />
{#if host.storage}
	<ResumeFolderWorkspace storage={host.storage} />
{/if}
<ToastStack />

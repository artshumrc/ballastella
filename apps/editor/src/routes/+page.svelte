<script lang="ts">
	import { tick } from 'svelte';

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		GitHubCallbackRefusedError,
		messageOf,
		readReturnLink,
		readSignInCallback,
		withoutReturnLink,
		type ReturnLink,
		type SignInCallback
	} from '@ballastella/core';
	import Alert from '$lib/components/Alert.svelte';
	import ProjectHub from '$lib/components/ProjectHub.svelte';
	import ReturnLinkOffer from '$lib/components/ReturnLinkOffer.svelte';
	import WorkspaceRecovery from '$lib/components/WorkspaceRecovery.svelte';
	import { connectSequence } from '$lib/connect-sequence.svelte.js';
	import type { EditorSession } from '$lib/editor-session.svelte.js';
	import { claimFirstVisit } from '$lib/first-run.js';
	import ProjectScreen from '$lib/project/ProjectScreen.svelte';
	import Toast from '$lib/toasts/Toast.svelte';
	import { attempt } from '$lib/browser-storage.js';
	import { focusMain } from '$lib/text';
	import type { GitHubAccount } from '$lib/github-account.svelte.js';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	const openDirectory = $derived(page.url.searchParams.get('p'));
	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);
	$effect(() => storage?.openWhenRecovered(openDirectory));

	$effect(() => {
		const current = session;
		const workspace = storage;
		if (!current || !workspace || host.unsupported) return;
		if (workspace.resumeFolder || workspace.unavailable || current.status !== 'ready') return;
		if (!claimFirstVisit()) return;
		if (page.url.search !== '' || workspace.review !== null) return;
		if (current.projects.length > 0) return;
		void beginFirstProject(current);
	});

	async function beginFirstProject(current: EditorSession): Promise<void> {
		const project = await current.createProject('');
		if (!project) return;
		await goto(resolve(`/?p=${encodeURIComponent(project.directory)}`), { replaceState: true });
	}

	let signInOutcome = $state('');
	let signInProblem = $state('');

	$effect(() => {
		const current = storage;
		if (!current) return;
		const callback = readSignInCallback(page.url.searchParams);
		if (callback === null) return;
		void finishSignIn(current.github, callback).catch((cause: unknown) => {
			signInProblem = messageOf(cause);
		});
	});

	async function finishSignIn(account: GitHubAccount, callback: SignInCallback): Promise<void> {
		signInOutcome = '';
		signInProblem = '';
		const returning = account.consumeSignInReturn();
		await strip('');

		try {
			await account.completeGitHubSignIn(callback);
			const kept = account.rememberSignIn
				? 'This computer keeps the part that renews it, so coming back tomorrow does not mean signing in again.'
				: 'Your sign-in is forgotten when this tab closes.';
			signInOutcome = `Signed in to GitHub${account.identity ? ` as ${account.identity}` : ''}. ${kept}`;
			await strip(returning);
		} catch (cause) {
			signInProblem = messageOf(cause);
			connectSequence.signInRefusal = signInProblem;
			if (!(cause instanceof GitHubCallbackRefusedError)) await strip(returning);
		}
	}

	let returnLink = $state<ReturnLink | null>(null);

	$effect(() => {
		if (!storage) return;
		const parameters = page.url.searchParams;
		if (!parameters.has('clone') && !parameters.has('review')) return;
		returnLink = readReturnLink(parameters);
		void strip(withoutReturnLink(parameters));
	});

	async function strip(query: string): Promise<void> {
		const address = `${resolve('/')}${query}`;
		try {
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			await goto(address, { replaceState: true, noScroll: true, keepFocus: true });
		} catch {
			attempt(() => globalThis.history.replaceState(globalThis.history.state, '', address));
		}
	}

	async function landOnTheEditor(): Promise<void> {
		await tick();
		focusMain();
	}

	const pageTitle = $derived(
		session === null || openDirectory === null
			? 'Ballastella Editor'
			: `${session.openProject?.name || openDirectory} — Ballastella Editor`
	);

	const home = $derived(
		!host.unsupported &&
			storage !== null &&
			!storage.resumeFolder &&
			!storage.unavailable &&
			openDirectory === null
	);
</script>

<svelte:head><title>{pageTitle}</title></svelte:head>

<Toast text={signInOutcome} testid="sign-in-outcome" tone="info" />
<Toast text={signInProblem} testid="sign-in-problem" refusal />

{#if returnLink && storage}
	<ReturnLinkOffer
		{storage}
		link={returnLink}
		ondismiss={(outcome) => {
			if (outcome.reason === 'declined' && returnLink?.kind === 'review') {
				void strip('').then(landOnTheEditor);
			}
			if (outcome.reason === 'imported') {
				const { directory } = outcome;
				void strip(`?p=${encodeURIComponent(directory)}`).then(() => session?.open(directory));
			}
			returnLink = null;
		}}
	/>
{/if}

{#if host.unsupported || storage === null || session === null || storage.resumeFolder || storage.unavailable || openDirectory === null}
	<main class="mx-auto p-8 {home ? 'max-w-[90rem]' : 'max-w-4xl'}">
		<h1 class="sr-only">Ballastella Editor</h1>
		{#if host.unsupported}
			<Alert class="mt-8" heading="No storage for a Workspace" text={host.unsupported} />
		{:else if storage === null || session === null}
			<p class="mt-8">Starting…</p>
		{:else if !storage.resumeFolder}
			{#if storage.unavailable}
				<WorkspaceRecovery {storage} />
			{:else}
				<div class="workspace-home-column">
					<WorkspaceRecovery {storage} />
				</div>
				<ProjectHub {session} />
			{/if}
		{/if}
	</main>
{:else}
	<main class="h-full">
		<ProjectScreen {session} {storage} {openDirectory} offerAbove={returnLink !== null} />
	</main>
{/if}

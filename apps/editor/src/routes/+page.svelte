<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		GitHubCallbackRefusedError,
		readReturnLink,
		readSignInCallback,
		withoutReturnLink,
		type ReturnLink
	} from '@ballastella/core';
	import ProjectHub from '$lib/components/ProjectHub.svelte';
	import ReturnLinkOffer from '$lib/components/ReturnLinkOffer.svelte';
	import WorkspaceRecovery from '$lib/components/WorkspaceRecovery.svelte';
	import ProjectScreen from '$lib/project/ProjectScreen.svelte';
	import { useWorkspaceHost, type WorkspaceStorage } from '$lib/workspace-storage.svelte.js';

	// One prerendered page; the Project is selected client-side from `?p=` (ADR-0008). That is
	// what keeps the static adapter honest: no SPA fallback file, no per-Project artefact to
	// rebuild when a Project is renamed or deleted, and a `?p=` URL that is shareable and citable.
	//
	// **This one route is now both screens** (ticket 04): with no `?p=` it is the hub, and with one
	// it is the Project — a Base Map with the Layer stack beside it. `/layers/` and `/base-map/`
	// were the other two thirds of the Project and are gone; there is nowhere else to be.
	const openDirectory = $derived(page.url.searchParams.get('p'));

	// Read, never created: the root layout owns the Workspace so that no two routes can disagree
	// about which one the user chose. `WorkspaceStorage` owns the session in turn,
	// because moving between OPFS and a folder replaces the session rather than repointing it.
	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);

	// `open(null)` lists the Projects, so the hub is current whenever it is what is on screen.
	// Listing here rather than after every mutation is what keeps typing a Project name from
	// walking the whole Workspace once per keystroke — a Project with a 2 GB pyramid is tens of
	// thousands of files, and the debounce would otherwise coalesce writes only to be defeated by
	// a read storm. Re-runs when the Workspace moves to another backend, which is a new session.
	//
	// ⚠ **Gated on `storage.recovered`** (ticket 20). The write-ahead journal is replayed into the
	// store as the Workspace is adopted, and this effect runs at the same moment. Ungated, a reload
	// inside the autosave debounce window landed here showing the name the interrupted write was
	// *replacing* — restored on disk, stale on screen, and one keystroke from being overwritten by
	// the very edit the journal had just rescued. Reading is what has to wait; the promise never
	// rejects, so a recovery that went wrong cannot stop a Project opening.
	$effect(() => {
		const current = session;
		const directory = openDirectory;
		const ready = storage?.recovered;
		if (!current || !ready) return;
		void ready.then(() => current.open(directory));
	});

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE GITHUB SIGN-IN COMES BACK HERE (ticket 10, ADR-0031)
	//
	// GitHub redirects to the editor's one prerendered route with `?code=` and `?state=`, arriving on
	// the same route `?p=` already addresses. There is nowhere else it could land: a GitHub App's
	// callback URL is registered per App, this app has one page, and a static host has no server to
	// receive it.
	//
	// ⚠ **Read inside an effect, which is the prerender guard.** SvelteKit throws on
	// `url.searchParams` while prerendering — a query parameter cannot be baked into a static file
	// (ADR-0008) — and this is the same rule `pageTitle` below documents. An effect never runs on the
	// server, and `storage` is `null` until the layout's effect has run, which is exactly the "in a
	// browser now" condition every other read on this page waits for.

	/** What the sign-in did, in the words the user should see. Its own state so it can be announced. */
	let signInOutcome = $state('');
	/** Why it did not happen. Separate, so a refusal can be an alert rather than a status. */
	let signInProblem = $state('');

	$effect(() => {
		const current = storage;
		if (!current) return;
		const callback = readSignInCallback(page.url.searchParams);
		if (callback === null) return;
		// A rejection here has nowhere else to go: an unhandled one is a sign-in that reports neither
		// success nor a reason, which is the state this screen exists to make impossible.
		void finishSignIn(current, callback).catch((cause: unknown) => {
			signInProblem = cause instanceof Error ? cause.message : String(cause);
		});
	});

	/**
	 * Take the reply off the address bar, then judge it.
	 *
	 * ⚠ **The parameters are stripped in both directions, and before the exchange is awaited.** A code
	 * left in the bar is one a reload replays, a bookmark preserves, and a screenshot leaks; a refused
	 * `state` left in the bar is one that re-refuses on every reload.
	 *
	 * ⚠ **The stashed `?p=` is consumed straight away and put back only once the `state` has
	 * verified.** It has to be consumed either way, or a later reload restores it into an unrelated
	 * navigation — but a callback this tab did not ask for must not be able to choose which Project
	 * the tab lands on, so the address it goes back to carries nothing until the reply is known to be
	 * this tab's. Every other refusal — GitHub's own, a broker that is down — *is* this tab's sign-in,
	 * and the scholar is put back where they were with the reason on screen.
	 */
	async function finishSignIn(
		current: WorkspaceStorage,
		callback: Parameters<WorkspaceStorage['completeGitHubSignIn']>[0]
	): Promise<void> {
		signInOutcome = '';
		signInProblem = '';
		const returning = current.consumeSignInReturn();
		await strip('');

		try {
			await current.completeGitHubSignIn(callback);
			signInOutcome = current.identity
				? `Signed in to GitHub as ${current.identity}. Your sign-in is forgotten when this tab closes.`
				: 'Signed in to GitHub. Your sign-in is forgotten when this tab closes.';
			await strip(returning);
		} catch (cause) {
			signInProblem = cause instanceof Error ? cause.message : String(cause);
			if (!(cause instanceof GitHubCallbackRefusedError)) await strip(returning);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// A PUBLISHED SITE'S FRONT PAGE LEADS BACK HERE (ticket 09, SPEC stories 49–51)
	//
	// `?clone=owner/repo` and `?review=owner/repo&p=<directory>`, landing on the same one route the
	// sign-in callback and `?p=` already arrive on, for the same reason: this app has one page.
	//
	// ⚠ **Read inside an effect, which is the prerender guard**, exactly as the callback above is and
	// as `pageTitle` below explains. An effect never runs on the server.
	//
	// ⚠ **Nothing happens until a press.** The parameter raises an *offer*; `ReturnLinkOffer` carries
	// the argument for why. A link that acted on arrival would let anyone rearrange a stranger's
	// editor.
	//
	// **`?p=` keeps its meaning and wins for display.** The review link spells its Project in the
	// parameter that already addresses one (ADR-0008), so the editor shows whatever `?p=` names —
	// before the Review, a Project this computer has not got — with the offer rendered above it. The
	// same address becomes the reviewed Project the moment the review copy exists.

	/** The offer a link raised, or `null`. Survives the operation so its outcome does. */
	let returnLink = $state<ReturnLink | null>(null);

	$effect(() => {
		if (!storage) return;
		const parameters = page.url.searchParams;
		// ⚠ **A parameter is stripped whether or not it parsed.** `?clone=ada/../../orgs` raises no
		// offer, but left in the bar it is replayed by a reload, kept by a bookmark, and shared by
		// whoever copies the address — which is the replay this stripping exists to prevent, and a
		// link nobody in this repository wrote is the last one to leave lying around. So the presence
		// of the parameter decides, and `readReturnLink` decides only whether there is an offer.
		if (!parameters.has('clone') && !parameters.has('review')) return;
		returnLink = readReturnLink(parameters);
		// ⚠ **Stripped as the offer is raised, not after it is answered.** Somebody who followed a link
		// once, said no, and came back to the tab later would otherwise be asked again by their own
		// history.
		void strip(withoutReturnLink(parameters));
	});

	/**
	 * Replace the address with this app's own root and the given query string.
	 *
	 * ⚠ **`goto` rather than `replaceState`.** This runs from an effect on the first render after the
	 * redirect, which is before SvelteKit's router has finished initialising — `replaceState` throws
	 * there, and the whole callback was silently lost. `goto` waits for the router, and
	 * `replaceState: true` keeps the callback URL out of the history so Back does not return to it.
	 *
	 * A rejected `goto` is caught and the address rewritten through the History API instead, because
	 * the one outcome that is not allowed here is the parameters staying where they are.
	 */
	async function strip(query: string): Promise<void> {
		// `resolve()` is used, but the rule only recognises it as the whole argument — and the query
		// string that carries the open Project back has to be appended to it. Same exemption, and the
		// same reason, as the `github.com` link in `RemoteSettings.svelte`.
		const address = `${resolve('/')}${query}`;
		try {
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			await goto(address, { replaceState: true, noScroll: true, keepFocus: true });
		} catch {
			try {
				globalThis.history.replaceState(globalThis.history.state, '', address);
			} catch {
				// Nothing further can be done about the address bar, and the sign-in itself still has an
				// answer to report — which is better than throwing that answer away over the URL.
			}
		}
	}

	/**
	 * The hub, or the Project by name. Falls back to the folder until `project.json` is read.
	 *
	 * **The `session` guard is load-bearing, not defensive.** SvelteKit throws on
	 * `url.searchParams` while prerendering — a query parameter cannot be baked into a static file
	 * (ADR-0008) — and `<svelte:head>` is rendered on the server, so reading `openDirectory` here
	 * unconditionally fails the build with `500 /`. `session` is `null` until the layout's effect has
	 * run, which is exactly the "not in a browser yet" condition, and every other read of
	 * `openDirectory` on this page is already inside that same guard.
	 */
	const pageTitle = $derived.by(() => {
		if (session === null) return 'Ballastella Editor';
		if (openDirectory === null) return 'Ballastella Editor';
		return `${session.openProject?.name || openDirectory} — Ballastella Editor`;
	});
</script>

<!--
	One `<svelte:head>`, because this route is both screens and a document has one title. Named after
	the Project when there is one: a scholar with several tabs open has nothing else to tell them
	apart, and `?p=amsterdam-1625` is not visible on a tab strip.
-->
<svelte:head><title>{pageTitle}</title></svelte:head>

<!--
	What the GitHub sign-in did, on the screen it comes back to. Rendered above every branch below
	because the redirect can land on the hub or on a Project, and the answer is the same either way.

	`aria-live="polite"` for the outcome and `role="alert"` for the refusal, which is CONTRIBUTING's
	mandated split: a status is announced when the reader gets to it, and a refusal is inserted at the
	moment its text first exists, which a polite region does not reliably announce.
-->
{#if signInOutcome}
	<p aria-live="polite" class="p-4 text-sm" data-testid="sign-in-outcome">{signInOutcome}</p>
{/if}
{#if signInProblem}
	<div role="alert" class="m-4 alert flex-col items-start alert-warning">
		<p data-testid="sign-in-problem">{signInProblem}</p>
	</div>
{/if}

<!--
	The offer a Published Site's link raised, above every branch below for the sign-in outcome's
	reason: the link can land on the hub or on a Project, and it says the same thing either way.
-->
{#if returnLink && storage}
	<ReturnLinkOffer
		{storage}
		link={returnLink}
		ondismiss={(reason) => {
			// ⚠ **Turning down a Review takes its `?p=` with it.** The review link's Project is named in
			// the parameter that addresses one (ADR-0008), and before the Review has run this Workspace
			// has no such Project — so dismissing the offer alone would leave the visitor looking at
			// “There is no Project called “amsterdam-1625” in this Workspace”, with the one thing on the
			// page that explained where that name came from now gone. Declining a link leaves the editor
			// as the visitor found it, which is its own hub.
			//
			// Not after the Review has run: by then `?p=` names a Project that is here, and it is the
			// one the visitor came to read.
			if (reason === 'declined' && returnLink?.kind === 'review') void strip('');
			returnLink = null;
		}}
	/>
{/if}

{#if host.unsupported}
	<main class="mx-auto max-w-4xl p-8">
		<h1 class="text-3xl font-bold">Ballastella Editor</h1>
		<!-- OPFS is missing only in a non-secure context, and the raw DOM failure for that
		     diagnoses nothing. -->
		<div role="alert" class="mt-8 alert flex-col items-start alert-warning">
			<h2 class="font-semibold">No storage for a Workspace</h2>
			<p>{host.unsupported}</p>
		</div>
	</main>
{:else if storage === null || session === null}
	<main class="mx-auto max-w-4xl p-8">
		<h1 class="text-3xl font-bold">Ballastella Editor</h1>
		<p class="mt-8">Starting…</p>
	</main>
{:else if openDirectory === null}
	<!-- The hub: a centred column that scrolls, which is what a list of Projects wants. -->
	<main class="mx-auto max-w-4xl p-8">
		<h1 class="text-3xl font-bold">Ballastella Editor</h1>
		<!--
			**Where the work is stored is no longer asked here** (ticket 12). It is a setting, reached
			from the Workspace button on the bar, and browser storage is the silent default — which is
			what ADR-0001 always implied and what the hub asked anyway, of everyone, including the
			majority of browsers where there is no picker to answer with.

			**What stays on the hub is the recovery**, and it is not the same thing. A moved, renamed, or
			unplugged folder is a normal state with a way back (ADR-0008), and it has to be *immediate*:
			a hub that silently listed browser storage's Projects instead would be indistinguishable,
			from the user's side, from the tool having lost everything they had. It renders nothing when
			the Workspace is reachable, so it costs nothing on the ordinary path.
		-->
		<WorkspaceRecovery {storage} />
		<ProjectHub {session} />
	</main>
{:else}
	<!--
		The Project fills the screen instead of sitting in a centred column, because the map is the
		thing being studied and a `max-w-4xl` map is the smaller share of a display. Its `<h1>` is the
		current item in the persistent breadcrumb.
	-->
	<main class="h-full">
		<ProjectScreen {session} {storage} {openDirectory} offerAbove={returnLink !== null} />
	</main>
{/if}

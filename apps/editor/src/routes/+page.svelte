<script lang="ts">
	import { tick } from 'svelte';

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
	import KeepingYourWork from '$lib/components/KeepingYourWork.svelte';
	import ProjectHub from '$lib/components/ProjectHub.svelte';
	import ReturnLinkOffer from '$lib/components/ReturnLinkOffer.svelte';
	import WorkspaceRecovery from '$lib/components/WorkspaceRecovery.svelte';
	import { connectSequence } from '$lib/connect-sequence.svelte.js';
	import ProjectScreen from '$lib/project/ProjectScreen.svelte';
	import Toast from '$lib/toasts/Toast.svelte';
	import { useWorkspaceHost, type WorkspaceStorage } from '$lib/workspace-storage.svelte.js';

	// One prerendered page; the Project is selected client-side from `?p=` (ADR-0008). That is
	// what keeps the static adapter honest: no SPA fallback file, no per-Project artefact to
	// rebuild when a Project is renamed or deleted, and a `?p=` URL that is shareable and citable.
	//
	// **This one route is both screens**: with no `?p=` it is the hub, and with one it is the
	// Project — a Base Map with the Layer stack beside it. `/layers/` and `/base-map/` were the
	// other two thirds of the Project and are gone; there is nowhere else to be.
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
	// ⚠ **Gated on `storage.recovered`.** The write-ahead journal is replayed into the store as the
	// Workspace is adopted, and this effect runs at the same moment. Ungated, a reload inside the
	// autosave debounce window landed here showing the name the interrupted write was *replacing* —
	// restored on disk, stale on screen, and one keystroke from being overwritten by the very edit
	// the journal had just rescued. Reading is what has to wait; the promise never rejects, so a
	// recovery that went wrong cannot stop a Project opening.
	$effect(() => {
		const current = session;
		const directory = openDirectory;
		const ready = storage?.recovered;
		if (!current || !ready) return;
		void ready.then(() => current.open(directory));
	});

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE GITHUB SIGN-IN COMES BACK HERE (ADR-0031)
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
			// ⚠ **Which of the two rules is in force, rather than one wording that is true under both.**
			// The author may have asked this machine to keep the renewable half of a sign-in (ADR-0041),
			// and telling them it is forgotten when the tab closes contradicts the thing they ticked —
			// on the one screen that reports what their sign-in just did. The door states it the same
			// way, and the eight-hour credential itself is forgotten either way.
			const kept = current.rememberSignIn
				? 'This computer keeps the part that renews it, so coming back tomorrow does not mean signing in again.'
				: 'Your sign-in is forgotten when this tab closes.';
			signInOutcome = current.identity
				? `Signed in to GitHub as ${current.identity}. ${kept}`
				: `Signed in to GitHub. ${kept}`;
			await strip(returning);
		} catch (cause) {
			signInProblem = cause instanceof Error ? cause.message : String(cause);
			// ⚠ **The guided sequence reopens over this page on the return leg**, so a refusal said only
			// here is a refusal behind a dialog. Handed to the sequence as well, it is rendered on the
			// sign-in step beside the button that starts the trip again.
			connectSequence.signInRefusal = signInProblem;
			if (!(cause instanceof GitHubCallbackRefusedError)) await strip(returning);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// A PUBLISHED SITE'S FRONT PAGE LEADS BACK HERE
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
		// string that carries the open Project back has to be appended to it.
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
	 * Put focus on the editor's own landmark, once whichever screen is now on it has rendered.
	 *
	 * `<main>` with `tabIndex = -1` is this app's settled answer for "that news is done with, look at
	 * the work" — `RecoveredEdits` dismisses onto it, and `ReturnLinkOffer` lands there when nothing
	 * underneath it is about to change.
	 */
	async function landOnTheEditor(): Promise<void> {
		await tick();
		const main = document.querySelector('main');
		if (!(main instanceof HTMLElement)) return;
		main.tabIndex = -1;
		main.focus();
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
	What the GitHub sign-in did, as messages the reader can put away.

	Not on the screen the redirect lands on, which is where these two sentences used to sit: the
	callback can come back to the hub or to a Project, so they were rendered above every branch below
	and pushed whichever screen it was down the page, for the rest of the session, over an answer that
	is read once.

	`aria-live="polite"` for the outcome and `role="alert"` — `refusal` — for the problem, which is
	CONTRIBUTING's mandated split and unchanged by the move: a status is announced when the reader
	gets to it, and a refusal is inserted at the moment its text first exists, which a polite region
	does not reliably announce.
-->
<Toast text={signInOutcome} testid="sign-in-outcome" tone="info" />
<Toast text={signInProblem} testid="sign-in-problem" refusal />

<!--
	The offer a Published Site's link raised, above every branch below for the sign-in outcome's
	reason: the link can land on the hub or on a Project, and it says the same thing either way.
-->
{#if returnLink && storage}
	<ReturnLinkOffer
		{storage}
		link={returnLink}
		ondismiss={(outcome) => {
			// ⚠ **Turning down a Project invitation takes its `?p=` with it.** The link's Project is
			// named in the parameter that addresses one (ADR-0008), and before anything has been
			// fetched this Workspace has no such Project — so dismissing the offer alone would leave the
			// visitor looking at “There is no Project called “amsterdam-1625” in this Workspace”, with
			// the one thing on the page that explained where that name came from now gone. Declining a
			// link leaves the editor as the visitor found it, which is its own hub.
			//
			// Not after a Review: by then `?p=` names a Project that is here, and it is the one the
			// visitor came to read.
			// ⚠ **Focus is put back after the navigation, because the navigation replaces `<main>`.** The
			// offer lands on the landmark before it goes (see `ReturnLinkOffer`), which is right whenever
			// the screen underneath stays — but dropping `?p=` swaps the Project branch for the hub, so
			// the element that was focused is unmounted and a visitor who declined a link is left on
			// `<body>` after all. `keepFocus` cannot help with a node that no longer exists.
			if (outcome.reason === 'declined' && returnLink?.kind === 'review') {
				void strip('').then(landOnTheEditor);
			}
			// ⚠ **And an Import is addressed by where it landed, not by where it came from.** A
			// Workspace that already held a Project of that name allocates the arriving one another
			// directory, so the link's own `?p=` would name nothing here — which is the same dead end
			// declining avoids, reached from the other side.
			//
			// ⚠ **Opened explicitly, because the address may not have changed.** The screen behind the
			// offer has been sitting on this very `?p=` since the visitor landed, failing to find a
			// Project that was not here yet; a `goto` to the address it is already on raises no
			// navigation, so the effect that opens Projects never runs and the reader is left looking
			// at the dead end their Import has just fixed.
			if (outcome.reason === 'imported') {
				const { directory } = outcome;
				void strip(`?p=${encodeURIComponent(directory)}`).then(() => session?.open(directory));
			}
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
{:else if storage.unavailable}
	<!--
		⚠ **Its own branch, above the hub and above the Project.** An Import or an Update that did not
		finish could not be resolved, so this Workspace has not opened: its provisional files sit at
		ordinary Workspace paths and a Project list, a Map Image list, a size, a Backup or a Publish
		plan drawn now would include them. Nothing enumerates —
		`storage.recovered` is never resolved — so rendering `ProjectHub` here would show “Looking for
		your Projects…” for ever beside an alert saying the Workspace is shut, which answers neither
		question.
	-->
	<main class="mx-auto max-w-4xl p-8">
		<h1 class="text-3xl font-bold">Ballastella Editor</h1>
		<WorkspaceRecovery {storage} />
		<!--
			⚠ **Here as well, because a Workspace that has not opened is where a Restore matters most.**
			Backup is absent and says why (ADR-0042 re-homes both onto this screen), and restoring is the
			one transfer that works from here: it always makes a *new* Workspace and never reads this one.
		-->
		<KeepingYourWork {storage} />
	</main>
{:else if openDirectory === null}
	<!--
		The Workspace Home: a centred block that scrolls, which is what two lists want.

		Wide enough for the two columns `ProjectHub` lays out above `xl` — the Projects column is
		pinned to `--workspace-home-measure` and the Map Images column takes what is left — rather
		than the single `max-w-4xl` column it was while the two lists were stacked.
	-->
	<main class="mx-auto max-w-[90rem] p-8">
		<h1 class="text-3xl font-bold">Ballastella Editor</h1>
		<!--
			**Where the work is stored is not asked here.** Browser storage is the silent default and the
			first Workspace exists before anything is asked — which is what ADR-0001 always implied and
			what a hub that asked anyway got wrong, of everyone, including the majority of browsers where
			there is no picker to answer with. The section at the foot of this screen answers the
			question for whoever comes looking for it.

			**What stays on the hub is the recovery**, and it is not the same thing. A moved, renamed, or
			unplugged folder is a normal state with a way back (ADR-0008), and it has to be *immediate*:
			a hub that silently listed browser storage's Projects instead would be indistinguishable,
			from the user's side, from the tool having lost everything they had. It renders nothing when
			the Workspace is reachable, so it costs nothing on the ordinary path.
		-->
		<!--
			Wrapped at the Workspace Home measure: the recovery's alerts are multi-sentence prose, and
			`<main>` is as wide as the two columns together, which is far past a readable line length.
			The same measure as the Projects column beside it, so the two line up.
		-->
		<div class="workspace-home-column">
			<WorkspaceRecovery {storage} />
		</div>
		<ProjectHub {session} />
		<!--
			Backup, Restore, what this browser promised, the offer that answers it, unsaved changes with
			nowhere to go, and the way into a folder — all about the Workspace the author is in, and all
			of them re-homed here from the settings dialog ADR-0042 deletes. Wrapped at the Workspace
			Home measure for the reason the recovery above is: multi-sentence prose, in a `<main>` as
			wide as two columns.
		-->
		<div class="workspace-home-column">
			<KeepingYourWork {storage} />
		</div>
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

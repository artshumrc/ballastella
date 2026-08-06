<script lang="ts">
	// Publish: the Workspace becomes the website (SPEC stories 78–81, 88–90, 92).
	//
	// The dialog exists because publishing has things to *say* before it does anything, and two of
	// them are decisions rather than reports: ADR-0020 requires the Base Map's size be stated before
	// it is added, and ADR-0008's ~1 GB hosting cliff is a cliff rather than a slowdown, so a user
	// finding out from `git push` is the failure it names. So the plan is computed on open and shown,
	// and the button acts on the plan the user was shown.
	//
	// `<dialog>` + `showModal()` through `ModalDialog` is mandated (ADR-0016), which is what brings
	// Escape, the focus trap, and focus restoration.

	import { tick } from 'svelte';

	import {
		describeBytes,
		publishedSiteStaleness,
		type PublishPlan,
		type PublishedSite
	} from '@ballastella/core';

	import ModalDialog from '../components/ModalDialog.svelte';
	import type { EditorSession } from '../editor-session.svelte.js';
	import { loadViewerBundle, readBundleAsset } from './viewer-bundle-source';

	let { session, open = $bindable(false) }: { session: EditorSession; open?: boolean } = $props();

	let plan = $state<PublishPlan | null>(null);
	/** Why there is nothing to publish, or why publishing stopped. */
	let failure = $state('');
	/**
	 * A self-contained site: the Base Map's own files go into the Workspace too (SPEC story 88).
	 *
	 * On by default, because the Base Map a Project records is normally one this deployment serves
	 * from its own bundled extract — so a site published without it has no Base Map under its
	 * Historical Maps at all, which is not a state to arrive at by not reading a checkbox. Its size
	 * is stated either way (SPEC story 89).
	 */
	let includeBaseMap = $state(true);
	/** The address the user wants their Historical Maps to answer at, or `''` (SPEC story 92). */
	let canonicalUrl = $state('');

	let publishing = $state(false);
	let progress = $state<{ files: number; totalFiles: number } | null>(null);
	/** What happened, once it has. Announced, and it stays on screen after the dialog closes. */
	let published = $state<{ site: PublishedSite; files: number; stamped: number } | null>(null);

	/** The record the Workspace's own Published Site carries, and whether it is behind. */
	let staleness = $state('');

	const reset = () => {
		plan = null;
		failure = '';
		progress = null;
		published = null;
	};

	/**
	 * Work out the plan whenever the dialog opens.
	 *
	 * On open rather than once: a Workspace's byte total and its Project list both change while the
	 * app is running, and a plan computed at startup would state a size that is no longer true — at
	 * the one moment where the number is the whole point.
	 */
	$effect(() => {
		if (!open) return;
		reset();
		void (async () => {
			try {
				const bundle = await loadViewerBundle();
				const site = await session.readPublishedSite();
				plan = await session.planPublish({ bundle, includeBaseMap });
				staleness =
					site === null
						? ''
						: publishedSiteStaleness(site, {
								viewerVersion: bundle.version,
								projects: session.projects
							});
				// Offered back rather than asked for again: a citable address that changes every time it
				// is re-published is not citable (ADR-0004).
				canonicalUrl = plan.canonicalUrl ?? '';
			} catch (cause) {
				failure = cause instanceof Error ? cause.message : String(cause);
			}
		})();
	});

	/** Re-plan when the Base Map choice changes, so the stated size is the one being agreed to. */
	const chooseBaseMap = async (wanted: boolean) => {
		includeBaseMap = wanted;
		if (!open) return;
		try {
			plan = await session.planPublish({ bundle: await loadViewerBundle(), includeBaseMap });
		} catch (cause) {
			failure = cause instanceof Error ? cause.message : String(cause);
		}
	};

	const run = async () => {
		const agreed = plan;
		if (!agreed || publishing) return;
		publishing = true;
		failure = '';
		try {
			// The address is settled **first**, because core refuses one it cannot make an image service
			// out of and its refusal ends "Nothing has been changed." Publishing the whole site and then
			// asking would make that sentence false, in front of a user who has just had a website
			// written into their Workspace and been told otherwise — and `scholar.example`, with no
			// scheme, is the ordinary way to arrive there. Refused here, nothing has been written.
			const stamped =
				canonicalUrl.trim() === '' ? { images: 0 } : await session.stampCanonicalUrl(canonicalUrl);
			const site = await session.publish({
				plan: agreed,
				readAsset: readBundleAsset,
				onProgress: (seen) => {
					progress = { files: seen.files, totalFiles: seen.totalFiles };
				}
			});
			// Closed, and the close applied, *before* the result is set. The region that carries the
			// result is outside the dialog, and a mutation made while `showModal()` still holds the rest
			// of the document inert is one no screen reader is told about — so the `tick` is the
			// announcement rather than a tidy-up.
			staleness = '';
			open = false;
			await tick();
			published = { site, files: agreed.files.length, stamped: stamped.images };
		} catch (cause) {
			failure = cause instanceof Error ? cause.message : String(cause);
		} finally {
			publishing = false;
			progress = null;
		}
	};

	/**
	 * The line announced while the writing is happening, from **inside** the dialog.
	 *
	 * It has to be inside: `showModal()` makes the whole document outside the open `<dialog>` inert,
	 * and an inert `aria-live` region is not a quiet one — it is not announced at all. So progress
	 * lives in the modal, which is the only non-inert subtree while publishing runs, and the result
	 * below lives outside it, which is where the dialog has gone by the time there is a result.
	 * Nothing is said twice: this is empty except while `progress` is set, and that is exactly the
	 * span during which the other one is empty.
	 */
	const progressLine = $derived(
		progress ? `Publishing: ${progress.files} of ${progress.totalFiles} files.` : ''
	);

	/** What happened, announced once the dialog has closed and the region outside it is live again. */
	const result = $derived.by(() => {
		if (published) {
			const projects = published.site.projects.length;
			return (
				`Published: ${published.files} files written into your Workspace, listing ` +
				`${projects === 1 ? '1 Project' : `${projects} Projects`}.` +
				(published.stamped > 0
					? ` ${published.stamped === 1 ? '1 Historical Map' : `${published.stamped} Historical Maps`} ` +
						`stamped for ${canonicalUrl.trim()}.`
					: '')
			);
		}
		return '';
	});
</script>

<!--
	The result, announced from outside the dialog — where the dialog no longer is by the time this has
	anything to say, because `run` closes it before it sets `published`. Progress is announced from a
	second region inside the modal; see `progressLine`.

	Always rendered, empty when idle: an `aria-live` region inserted at the same moment as its first
	text is not reliably announced.

	`aria-live="polite"` rather than `role="status"`, which would be the idiomatic choice but for the
	hub's transfer region already being its one `status` role — two of them make `getByRole('status')`
	ambiguous, and ADR-0016's own note on this says a test that has to disambiguate is a hint that a
	screen-reader user would have to as well. `aria-atomic` so each update is read as a whole sentence
	rather than as the words that changed.
-->
<p
	aria-live="polite"
	aria-atomic="true"
	class="mt-2 text-sm opacity-80"
	data-testid="publish-status"
>
	{result}
</p>

{#if staleness && !open}
	<div
		aria-live="polite"
		class="mt-2 alert flex-col items-start alert-info"
		data-testid="publish-stale"
	>
		<p>{staleness}</p>
	</div>
{/if}

{#if failure && !open}
	<div role="alert" class="mt-2 alert flex-col items-start alert-error">
		<p>{failure}</p>
	</div>
{/if}

<ModalDialog bind:open title="Publish this Workspace as a website">
	{#if failure}
		<div role="alert" class="alert flex-col items-start alert-error">
			<p>{failure}</p>
		</div>
	{/if}

	{#if plan === null}
		<p>Working out what publishing would add…</p>
	{:else}
		<p>
			An <code>index.html</code> and a read-only viewer are written into your Workspace, beside the
			work already there:
			<strong>{plan.files.length} files, {describeBytes(plan.bytes)}</strong>. Your Historical Maps
			are not copied — publishing adds a website to the folder you already have.
		</p>
		<p class="mt-2 text-sm opacity-80">
			The site will list
			{plan.projects.length === 1 ? '1 Project' : `${plan.projects.length} Projects`}. Push the
			folder to GitHub Pages, or upload it to any web host; it works at a web address of its own and
			in a subfolder alike.
		</p>

		<label class="mt-4 flex items-start gap-3">
			<input
				type="checkbox"
				class="checkbox mt-1"
				checked={includeBaseMap}
				onchange={(event) => chooseBaseMap(event.currentTarget.checked)}
			/>
			<span>
				Include the Base Map, so the site works with no network connection
				<span class="block text-sm opacity-70">
					Without it, a Reader needs a network for the modern map underneath your work.
				</span>
			</span>
		</label>

		<label class="floating-label mt-6">
			<span>Address your Historical Maps will be published at (optional)</span>
			<input
				class="input w-full"
				bind:value={canonicalUrl}
				placeholder="https://your-name.github.io/your-repository"
			/>
		</label>
		<p class="mt-2 text-sm opacity-70">
			Fill this in and each Historical Map becomes a real IIIF image service at that address, which
			Allmaps and other tools can read directly. Your Projects keep working here either way.
		</p>

		{#each plan.warnings as warning (warning.kind)}
			<div
				role={warning.kind === 'base-map-size' ? 'status' : 'alert'}
				class="mt-4 alert flex-col items-start"
				class:alert-warning={warning.kind !== 'base-map-size'}
				class:alert-info={warning.kind === 'base-map-size'}
				data-warning={warning.kind}
			>
				<p>{warning.message}</p>
			</div>
		{/each}
	{/if}

	<!--
		Progress, seen and announced by the same element, from inside the modal so that it is not in
		the inert half of the document while it has something to say. Always rendered and empty when
		idle, for the same reason the region outside is.
	-->
	<p aria-live="polite" aria-atomic="true" class="mt-4" data-testid="publish-progress">
		{progressLine}
	</p>

	{#snippet actions()}
		<button class="btn" onclick={() => (open = false)} disabled={publishing}>Cancel</button>
		<!-- `aria-disabled`, not `disabled`: a `disabled` button leaves the tab order the moment it is
		     pressed, dropping a keyboard user's focus to `<body>` for the length of the publish
		     (SPEC story 95, WCAG 2.4.3). -->
		<button
			class="btn btn-primary"
			class:btn-disabled={publishing || plan === null}
			aria-disabled={publishing || plan === null}
			onclick={run}
		>
			{publishing ? 'Publishing…' : 'Publish'}
		</button>
	{/snippet}
</ModalDialog>

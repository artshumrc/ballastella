<script lang="ts">
	// Adding a Historical Map from a IIIF URL (SPEC stories 16, 17, 18, 19, 20, 24, 25, 26).
	//
	// The whole flow is keyboard-operable without anything special being done for it, and that is the
	// point of the elements chosen: the URL is an `<input>` in a `<form>`, so Enter submits; the
	// canvases are `<button>`s in a list, so Tab reaches each and Enter and Space activate it; the
	// community offer is a `<select>`; the lookup setting is a checkbox with a real `<label>`. A
	// div-with-onclick would have needed `tabindex`, a keydown handler, and a role — three things to
	// get right per control instead of none (SPEC story 95).
	//
	// **Everything from the remote document is interpolated as text, never `{@html}`.** A IIIF label
	// or metadata value is a stranger's string, and the Presentation API even permits a restricted
	// subset of HTML in it. Svelte escapes interpolation, so the cost of this is a library's italics
	// and the benefit is that ticket 10's Markdown-and-sanitisation path — which exists for the
	// *user's own* prose — is not pressed into service on an untrusted third-party document.

	import type { MapLayer } from '@ballastella/core';

	import type { EditorSession } from '../editor-session.svelte.js';
	import { AddRemoteMap } from './add-remote-map.svelte.js';

	let { session, onadded }: { session: EditorSession; onadded?: (layer: MapLayer) => void } =
		$props();

	const job = new AddRemoteMap(() => session);

	const busy = $derived(job.step === 'reading' || job.step === 'checking' || job.step === 'adding');

	/** What the announced region says, so a screen-reader user hears the same thing the page shows. */
	const status = $derived.by(() => {
		if (job.step === 'reading') return 'Reading that address…';
		if (job.step === 'checking')
			return 'Checking that the library allows Ballastella to read this image…';
		if (job.step === 'adding') return 'Adding the Layer…';
		if (job.service) {
			const found = job.communityCount;
			return (
				`${job.service.width} by ${job.service.height} pixels, served by ` +
				`${new URL(job.service.uri).hostname}.` +
				(found > 0 ? ` Import existing alignment — ${found} found.` : '')
			);
		}
		if (job.described) {
			return job.described.kind === 'collection'
				? `A Collection of ${job.items.length} items.`
				: `${job.canvases.length} images in this ${job.described.kind}.`;
		}
		return '';
	});

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		await job.read();
	};

	const add = async () => {
		const layer = await job.addSelected();
		if (layer) onadded?.(layer);
	};
</script>

<section class="mt-10" aria-labelledby="add-remote-heading">
	<h3 id="add-remote-heading" class="text-lg font-semibold">Add a Historical Map from a library</h3>

	<form class="mt-4 flex max-w-2xl flex-wrap items-end gap-2" onsubmit={submit}>
		<label class="floating-label grow">
			<span>IIIF Manifest, Collection, or image address</span>
			<input
				class="input w-full"
				type="url"
				inputmode="url"
				autocomplete="off"
				spellcheck="false"
				placeholder="https://…"
				data-testid="remote-url"
				bind:value={job.url}
				disabled={busy}
			/>
		</label>
		<button class="btn btn-primary" type="submit" data-testid="remote-read" disabled={busy}>
			{busy ? 'Working…' : 'Look up'}
		</button>
		{#if job.described || job.error}
			<button
				class="btn btn-ghost"
				type="button"
				data-testid="remote-reset"
				onclick={() => job.reset()}
			>
				Clear
			</button>
		{/if}
	</form>

	<!--
		The lookup setting, at the point of use rather than on a settings page (ADR-0015). A scholar
		working on embargoed material has to be able to see and change it in the same place they are
		about to add the map, not go looking for it afterwards.
	-->
	<div class="mt-4 max-w-2xl">
		<label class="label cursor-pointer justify-start gap-3">
			<input
				class="toggle toggle-sm"
				type="checkbox"
				data-testid="community-lookup-toggle"
				bind:checked={job.lookupEnabled}
			/>
			<span
				>{job.lookupEnabled
					? job.disclosure
					: 'Not checking Allmaps for existing georeferences.'}</span
			>
		</label>
	</div>

	<!--
		`aria-live="polite"` rather than `role="status"`: the save indicator is already this page's one
		`status` role, and two of them make `getByRole('status')` ambiguous — for a test and for a
		screen-reader user alike.
	-->
	<div aria-live="polite" aria-atomic="true" class="mt-3 min-h-6">
		{#if status}<p class="text-sm" data-testid="remote-status">{status}</p>{/if}
	</div>

	{#if job.error}
		<!--
			The refusal, in the words the core modules chose — they name the host, say what would have
			gone wrong, and offer the way through. `whitespace-pre-line` because those messages carry a
			paragraph break, and running the two paragraphs together is how a long, careful explanation
			becomes a wall nobody reads.
		-->
		<div role="alert" class="mt-4 alert max-w-prose flex-col items-start alert-warning">
			<p class="whitespace-pre-line" data-testid="remote-error">{job.error}</p>
		</div>
	{/if}

	{#if job.described}
		{@const described = job.described}
		<div class="mt-6 max-w-2xl rounded-box border border-base-300 p-4">
			<h4 class="font-semibold" data-testid="remote-label">{described.label || described.uri}</h4>
			{#if described.summary}<p class="mt-1 text-sm">{described.summary}</p>{/if}

			<!--
				Rights and attribution (SPEC stories 20 and 28). Shown while choosing, so a scholar knows
				what they are permitted to do *before* they build work on it — and recorded into
				`remote.json` as well, because ADR-0007 asks for them again at the moment an offline copy
				is made, long after the Manifest has been navigated away from.
			-->
			{#if described.rights}
				<p class="mt-3 text-sm" data-testid="remote-rights">
					<span class="font-medium">Rights:</span>
					{#if described.rightsLink}
						<!--
							`rightsLink` and not `rights`. Svelte does not sanitise `href`, so a Manifest
							declaring `"rights": "javascript:…"` would otherwise produce a link that runs script
							when a scholar clicks it to read the licence. `describeRemoteResource` is where that
							decision is made, beside the rest of the untrusted-input rules — and a rights URI
							that is not http(s) still shows, as text, because what the library said is worth
							reading either way.

							`resolve()` is for this app's own routes; a library's licence page is not one, so the
							rule is disabled here for the one case it does not cover.
						-->
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
						<a class="link" href={described.rightsLink} rel="noreferrer noopener" target="_blank"
							>{described.rights}</a
						>
					{:else}
						{described.rights}
					{/if}
				</p>
			{/if}
			{#if described.attribution}
				<p class="mt-1 text-sm" data-testid="remote-attribution">
					<span class="font-medium">{described.attribution.label || 'Attribution'}:</span>
					{described.attribution.value}
				</p>
			{/if}

			{#if described.metadata.length > 0}
				<details class="mt-3">
					<summary class="cursor-pointer text-sm">
						Catalogue details ({described.metadata.length})
					</summary>
					<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
						{#each described.metadata as row, index (index)}
							<dt class="font-medium">{row.label}</dt>
							<dd>{row.value}</dd>
						{/each}
					</dl>
					{#if described.metadataDropped > 0}
						<p class="mt-1 text-xs opacity-70">
							{described.metadataDropped} further rows are not shown.
						</p>
					{/if}
				</details>
			{/if}

			<!-- A Collection: one URL from a library, and the volumes inside it (SPEC story 17). -->
			{#if job.items.length > 0}
				<ul class="mt-4 flex flex-col gap-1" aria-label="Items in this Collection">
					{#each job.items as item (item.uri)}
						<li>
							<button
								class="btn w-full justify-start btn-ghost btn-sm"
								type="button"
								data-testid="remote-item"
								disabled={busy}
								onclick={() => job.read(item.uri)}
							>
								{item.label}
								<span class="opacity-60">({item.kind})</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}

			<!-- A multi-canvas Manifest: pick the canvas that is the map (SPEC story 19). -->
			{#if job.canvases.length > 1}
				<fieldset class="mt-4">
					<legend class="text-sm font-medium">Which image is the map?</legend>
					<ul class="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto">
						{#each job.canvases as canvas (canvas.uri)}
							<li>
								<button
									class="btn w-full justify-start btn-sm"
									class:btn-primary={canvas.uri === job.selectedCanvas}
									aria-current={canvas.uri === job.selectedCanvas ? 'true' : undefined}
									type="button"
									data-testid="remote-canvas"
									disabled={busy || canvas.imageService === ''}
									onclick={() => job.select(canvas.imageService)}
								>
									{canvas.label}
									{#if canvas.imageService === ''}
										<span class="opacity-60">(not a tiled image)</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				</fieldset>
			{/if}

			{#if job.service}
				{@const service = job.service}
				<div class="mt-4 border-t border-base-300 pt-4">
					<p class="text-sm">
						<span class="font-medium">Selected:</span>
						{service.width} × {service.height} pixels from
						<code>{new URL(service.uri).hostname}</code>
					</p>
					<p class="mt-1 text-xs opacity-70">
						This map stays on the library's server. It is <strong>referenced</strong>, not copied
						into your Project — so a Published Site of this Project needs the network to show it.
					</p>

					<!-- "Import existing alignment — 3 found." (SPEC story 25) -->
					{#if job.community?.state === 'found' && job.community.alignments.length > 0}
						{@const alignments = job.community.alignments}
						<label class="mt-3 block text-sm" data-testid="community-offer">
							<span class="font-medium">Import existing alignment — {alignments.length} found.</span
							>
							<select class="select mt-1 select-sm" bind:value={job.importIndex}>
								{#each alignments as offered (offered.index)}
									<option value={offered.index}>
										{offered.alignment.controlPoints.length} control points, {offered.alignment
											.transformationType}
									</option>
								{/each}
								<option value={-1}>Start a new alignment instead</option>
							</select>
						</label>
					{:else if job.community?.state === 'unavailable'}
						<p class="mt-3 text-sm opacity-70" data-testid="community-unavailable">
							Allmaps could not be reached, so Ballastella cannot say whether anyone has aligned
							this map already. You can still add it. ({job.community.detail})
						</p>
					{:else if job.community?.state === 'off'}
						<p class="mt-3 text-sm opacity-70" data-testid="community-off">
							Ballastella did not check Allmaps for existing georeferences of this map.
						</p>
					{/if}

					<button
						class="btn mt-4 btn-primary"
						type="button"
						data-testid="remote-add"
						disabled={busy}
						onclick={add}
					>
						Add as a Layer
					</button>
				</div>
			{/if}
		</div>
	{/if}
</section>

<script lang="ts">
	import { COMMUNITY_ALIGNMENT_DISCLOSURE } from '@ballastella/core';

	import Alert from '$lib/components/Alert.svelte';
	import ExternalLink from '$lib/components/ExternalLink.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';
	import { AddRemoteMap } from './add-remote-map.svelte.js';

	let {
		session,
		onadded
	}: {
		session: EditorSession;
		onadded: (notice: string) => void;
	} = $props();

	const job = new AddRemoteMap(() => session);
	const busy = $derived(job.step !== 'idle' && job.step !== 'choosing');

	const status = $derived.by(() => {
		if (job.step === 'reading') return 'Reading that address…';
		if (job.step === 'checking')
			return 'Checking that the library allows Ballastella to read this image…';
		if (job.step === 'downloading')
			return 'That address is an image file rather than a IIIF resource. Copying it into this Workspace…';
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

	const look = async (url?: string, fromCollection = false) => {
		if (await job.read(url, fromCollection)) onadded('');
	};

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		await look();
	};

	const add = async () => {
		if (await job.addSelected()) onadded(job.notice);
	};
</script>

<section class="mt-10" aria-labelledby="add-remote-heading">
	<h3 id="add-remote-heading" class="text-lg font-semibold">
		Add a Map Image from a URL or IIIF Resource
	</h3>

	<form class="mt-4 flex max-w-2xl flex-wrap items-end gap-2" onsubmit={submit}>
		<label class="floating-label grow">
			<span>Image URL or IIIF Resource</span>
			<input
				class="input w-full"
				type="url"
				inputmode="url"
				autocomplete="off"
				spellcheck="false"
				data-testid="remote-url"
				placeholder="Image URL or IIIF Resource"
				bind:value={job.url}
				disabled={busy}
			/>
		</label>
		<button class="btn btn-primary" type="submit" data-testid="remote-read" disabled={busy}>
			{busy ? 'Working…' : 'Look up'}
		</button>
		{#if job.described || job.error}
			<button
				class="btn btn-outline"
				type="button"
				data-testid="remote-reset"
				onclick={() => job.reset()}
			>
				Clear
			</button>
		{/if}
	</form>

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
					? COMMUNITY_ALIGNMENT_DISCLOSURE
					: 'Not checking Allmaps for existing georeferences.'}</span
			>
		</label>
	</div>

	<div aria-live="polite" aria-atomic="true" class="mt-3 min-h-6">
		{#if status}<p class="text-sm" data-testid="remote-status">{status}</p>{/if}
	</div>

	<Alert class="mt-4 max-w-prose whitespace-pre-line" testid="remote-error" text={job.error} />

	{#if job.described}
		{@const described = job.described}
		<div class="mt-6 max-w-2xl rounded-box border border-base-300 p-4">
			<h4 class="font-semibold" data-testid="remote-label">{described.label || described.uri}</h4>
			{#if described.summary}<p class="mt-1 text-sm">{described.summary}</p>{/if}

			{#if described.rights}
				<p class="mt-3 text-sm" data-testid="remote-rights">
					<span class="font-medium">Rights:</span>
					{#if described.rightsLink}
						<ExternalLink class="link" href={described.rightsLink}>{described.rights}</ExternalLink>
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

			{#if job.items.length > 0}
				<ul class="mt-4 flex flex-col gap-1" aria-label="Items in this Collection">
					{#each job.items as item (item.uri)}
						<li>
							<button
								class="btn w-full justify-start btn-outline btn-sm"
								type="button"
								data-testid="remote-item"
								disabled={busy}
								onclick={() => look(item.uri, true)}
							>
								{item.label}
								<span class="opacity-60">({item.kind})</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}

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

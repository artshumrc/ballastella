<script lang="ts">
	import { describeRemote, type GrantedRepository } from '@ballastella/core';

	import BusyButton from './BusyButton.svelte';

	let {
		repositories,
		newly = new Set<string>(),
		onchoose
	}: {
		repositories: readonly GrantedRepository[];
		newly?: ReadonlySet<string>;
		onchoose: (repository: GrantedRepository) => void;
	} = $props();

	const ordered = $derived(
		[...repositories].sort(
			(one, other) =>
				Number(newly.has(describeRemote(other))) - Number(newly.has(describeRemote(one)))
		)
	);

	let filter = $state('');

	const UNSELECTABLE =
		`You cannot put work into this one. If it is somebody else’s, ask them for write access ` +
		`to it.`;

	const PRIVATE_NOTE =
		`This one is private. Your work syncs to it exactly as it would to a public one, and ` +
		`nobody can read it without being signed in and given access. Share Links are the one ` +
		`thing that costs you: a reading site on a private repository needs a paid GitHub plan, ` +
		`and on a free account it is public repositories only.`;

	const matching = $derived(
		ordered.filter((repository) =>
			describeRemote(repository).toLowerCase().includes(filter.trim().toLowerCase())
		)
	);
</script>

<section class="m-4 rounded-box border border-base-300 p-4" data-testid="repository-choice">
	<h3 class="font-semibold">Choose where your map goes</h3>
	<p class="mt-1 max-w-prose text-sm opacity-70">
		These are the repositories on GitHub you have given Ballastella access to. If the one you want
		is not here, it is because it has not been given access yet rather than because it is not on
		GitHub.
	</p>

	{#if repositories.length === 0}
		<p class="mt-3 max-w-prose" data-testid="repository-choice-empty">
			You have not given Ballastella access to any repository yet, so there is nothing to choose
			from. A repository is the folder on GitHub your map will live in, and making one is the next
			step.
		</p>
	{:else}
		<label class="mt-3 block max-w-prose">
			<span class="sr-only">Search repositories</span>
			<input
				type="search"
				class="input-bordered input w-full"
				placeholder="Search repositories"
				autocomplete="off"
				bind:value={filter}
				data-testid="repository-filter"
			/>
		</label>

		{#if matching.length === 0}
			<p class="mt-3 max-w-prose text-sm opacity-70" data-testid="repository-filter-empty">
				No repositories match “{filter.trim()}”.
			</p>
		{:else}
			<div class="mt-3 max-h-64 overflow-y-auto" data-testid="repository-list">
				<ul class="flex flex-col gap-2" aria-label="Repositories you have given access to">
					{#each matching as repository (describeRemote(repository))}
						{@const unselectable = !repository.canPush}
						<li data-testid="granted-repository">
							<BusyButton
								busy={unselectable}
								class="btn btn-block w-full justify-start text-left"
								data-testid="choose-repository"
								onclick={() => onchoose(repository)}
							>
								<span class="font-mono">{describeRemote(repository)}</span>
								{#if newly.has(describeRemote(repository))}
									<span class="badge badge-sm badge-primary" data-testid="newly-granted">New</span>
								{/if}
								<span class="text-sm font-normal opacity-70" data-testid="push-mark">
									{unselectable ? 'Cannot be sent to' : 'Can be sent to'}
								</span>
							</BusyButton>
							{#if unselectable}
								<p class="mt-1 max-w-prose text-sm opacity-70" data-testid="unselectable-reason">
									{UNSELECTABLE}
								</p>
							{/if}
							{#if repository.isPrivate}
								<p class="mt-1 max-w-prose text-sm opacity-70" data-testid="repository-note">
									{PRIVATE_NOTE}
								</p>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/if}
</section>

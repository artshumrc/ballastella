<script lang="ts">
	import { describeRemote, type GrantedRepository } from '@ballastella/core';

	/**
	 * The repositories on GitHub a person may put their map in, and the press that chooses one.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * IT RENDERS A LIST IT IS GIVEN, AND ASKS GITHUB NOTHING
	 *
	 * The listing is `readGrantedRepositories`', and it is read once by whoever owns the sequence
	 * rather than here — so this component cannot disagree with the reading layer about which
	 * repositories exist, and cannot answer differently for somebody who happened to be signed in.
	 * Nothing here holds a credential, and nothing here connects anything.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * ⚠ A REPOSITORY THAT CANNOT BE PUBLISHED TO IS SHOWN AND REFUSED, NEVER HIDDEN
	 *
	 * That is the reason the marks are on every row rather than only the bad ones. Hiding a repository
	 * the author owns and can see on GitHub reproduces the very mystery this screen exists to remove:
	 * they go looking for the one they made, do not find it, and have no way to tell a permission they
	 * did not grant from a repository they did not make. So it is present, marked with why, and
	 * unselectable.
	 *
	 * ⚠ **Unselectable is `aria-disabled` rather than `disabled`.** A `disabled` button leaves the tab
	 * order, so the one row a keyboard or screen-reader user most needs to *read* — the one they
	 * expected to pick — would be the one row they cannot reach. The press is refused in the handler
	 * instead.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * AN EMPTY LIST IS A STEP, NOT A BLANK AREA
	 *
	 * Nothing granted is the ordinary state of a student who has just made an account, and an empty
	 * area with a heading over it reads as something that failed. The wording says what comes next; the
	 * press that does it belongs to whoever owns the sequence, and sits beside this.
	 */
	let {
		repositories,
		newly = new Set<string>(),
		onchoose
	}: {
		repositories: readonly GrantedRepository[];
		/**
		 * Full names (`owner/repository`) that were not granted when the author left to make one.
		 * Listed first and marked, so the one they just made is the one they see.
		 */
		newly?: ReadonlySet<string>;
		/** The repository chosen. Never called for a row that cannot be published to. */
		onchoose: (repository: GrantedRepository) => void;
	} = $props();

	/**
	 * The list with anything new at the top, and otherwise in the order it arrived.
	 *
	 * A student who has just made a repository is looking for one row and does not know GitHub's
	 * ordering, so the search is spared them. `sort` is stable, so the rest keeps the order
	 * `readGrantedRepositories` fixed.
	 */
	const ordered = $derived(
		[...repositories].sort(
			(one, other) =>
				Number(newly.has(describeRemote(other))) - Number(newly.has(describeRemote(one)))
		)
	);

	const chooseable = (repository: GrantedRepository): boolean =>
		repository.canPublish && !repository.isPrivate;

	/**
	 * Why this row cannot be chosen, or `''` when it can.
	 *
	 * ⚠ **Both reasons, when both hold.** A private repository somebody cannot publish to is two
	 * separate things to put right, and a sentence naming one of them sends them to fix half.
	 */
	function why(repository: GrantedRepository): string {
		const reasons: string[] = [];
		if (!repository.canPublish) {
			reasons.push(
				`You cannot put work into this one. If it is somebody else’s, ask them for write ` +
					`access to it.`
			);
		}
		if (repository.isPrivate) {
			reasons.push(
				`This one is private, so a map published in it would not be visible to anybody you sent ` +
					`the address to. Make it public on GitHub, or choose another.`
			);
		}
		return reasons.join(' ');
	}

	const choose = (repository: GrantedRepository): void => {
		if (chooseable(repository)) onchoose(repository);
	};
</script>

<section class="m-4 rounded-box border border-base-300 p-4" data-testid="repository-choice">
	<h3 class="font-semibold">Choose where your map goes</h3>
	<!--
		⚠ **What the list is showing, said before the list.** Without it an absent repository reads as a
		repository that does not exist, and the author's next move is to make a second one — which will
		be just as absent, because granting access is the step that was missed.
	-->
	<p class="mt-1 max-w-prose text-sm opacity-70">
		These are the repositories on GitHub you have given Ballastella access to. If the one you want
		is not here, it is because it has not been given access yet rather than because it is not on
		GitHub.
	</p>

	{#if repositories.length === 0}
		<!-- Nothing granted is a step with an instruction rather than a blank area. -->
		<p class="mt-3 max-w-prose" data-testid="repository-choice-empty">
			You have not given Ballastella access to any repository yet, so there is nothing to choose
			from. A repository is the folder on GitHub your map will live in, and making one is the next
			step.
		</p>
	{:else}
		<ul class="mt-3 flex flex-col gap-2" aria-label="Repositories you have given access to">
			{#each ordered as repository (describeRemote(repository))}
				{@const reason = why(repository)}
				{@const unselectable = reason !== ''}
				<li data-testid="granted-repository">
					<button
						class="btn btn-block w-full justify-start text-left"
						class:btn-disabled={unselectable}
						aria-disabled={unselectable}
						data-testid="choose-repository"
						onclick={() => choose(repository)}
					>
						<span class="font-mono">{describeRemote(repository)}</span>
						{#if newly.has(describeRemote(repository))}
							<span class="badge badge-sm badge-primary" data-testid="newly-granted">New</span>
						{/if}
						<!--
							The mark is on every row, including the ones that are fine. A mark that appeared only
							on the bad rows would leave the good ones saying nothing, and a person cannot tell
							"checked and fine" from "not checked" by absence.
						-->
						<span class="text-sm font-normal opacity-70" data-testid="publish-mark">
							{#if unselectable}
								Cannot be published to
							{:else}
								Can be published to
							{/if}
						</span>
					</button>
					{#if unselectable}
						<p class="mt-1 max-w-prose text-sm opacity-70" data-testid="unselectable-reason">
							{reason}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

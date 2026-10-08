<script
	lang="ts"
	generics="Item extends { readonly name: string; readonly directory: string; readonly href?: string }"
>
	// One hairline between rows and one above and below the list is the whole of the structure; the rule is `--color-rule`, which is a mix against `base-content` so that it is equally visible on either ground.

	import type { Snippet } from 'svelte';

	let {
		projects,
		heading = 'h2',
		media,
		facts,
		details,
		actions,
		showDirectory = true,
		class: listClass,
		testid,
		itemTestid
	}: {
		projects: readonly Item[];
		heading?: 'h2' | 'h3';
		media?: Snippet<[Item]>;
		facts?: Snippet<[Item]>;
		details?: Snippet<[Item]>;
		actions?: Snippet<[Item]>;
		showDirectory?: boolean;
		class?: string;
		testid?: string;
		itemTestid?: string;
	} = $props();
</script>

<ul class={['divide-y divide-rule border-y border-rule', listClass]} data-testid={testid}>
	{#each projects as project (project.directory)}
		<li class="flex flex-wrap items-center gap-4 py-4" data-testid={itemTestid}>
			{#if media}{@render media(project)}{/if}
			<div class="min-w-0 grow">
				<svelte:element this={heading} class="text-lg font-medium">
					{#if project.href}<a class="link" href={project.href}>{project.name}</a
						>{:else}{project.name}{/if}
				</svelte:element>
				{#if facts || showDirectory}
					<p class="text-sm break-words opacity-70">
						{#if facts}{@render facts(project)}{/if}
						{#if facts && showDirectory}
							·
						{/if}
						{#if showDirectory}folder <code>{project.directory}</code>{/if}
					</p>
				{/if}
				{#if details}{@render details(project)}{/if}
			</div>
			{#if actions}
				<div class="flex flex-wrap gap-2">{@render actions(project)}</div>
			{/if}
		</li>
	{/each}
</ul>

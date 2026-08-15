<script
	lang="ts"
	generics="Project extends { readonly name: string; readonly directory: string; readonly href: string }"
>
	// The list of Project cards, rendered by the editor's Hub and by a Published Site's Front Page
	// (SPEC stories 8, 52–54).
	//
	// ⚠ **A Project's display name is interpolated as text and never as markup.** It comes out of a
	// `project.json`, which may have arrived from a stranger by bundle or from a remote library, and a
	// Published Site runs on the author's own domain — so a name carrying `<img src=x onerror=…>`
	// rendered as HTML there is stored XSS on the scholar's own site (ADR-0009). Svelte's own escaping
	// is the whole mechanism: there is no `{@html}` here and no sanitiser, because nothing is ever
	// turned into markup. `href` is composed and encoded by the consumer, from the **folder** rather
	// than from the name.
	//
	// **The two apps differ by what they hand this component, and by nothing else.** There is no
	// `readOnly`, `mode` or `editable` prop: the Hub passes its last-saved line, its Front Page choice
	// and its per-Project controls as snippets, and the Front Page passes none of them and so has none
	// of them. What each list says when it is empty is the consumer's own prose — the two apps have
	// two different empty states to say (ADR-0032) and neither is a fact about a card.

	import type { Snippet } from 'svelte';

	let {
		projects,
		heading = 'h2',
		facts,
		details,
		actions,
		class: listClass,
		testid
	}: {
		/** The Projects to list, in the order they are to be read. Keyed by folder. */
		projects: readonly Project[];
		/**
		 * The heading level each Project's name is given.
		 *
		 * The Hub sits this list under its own “Projects” heading and the Front Page under the bar's
		 * `<h1>`, so the level that keeps a page's outline true is the page's to state.
		 */
		heading?: 'h2' | 'h3';
		/** Anything the consumer knows about a Project, said before the folder on the same line. */
		facts?: Snippet<[Project]>;
		/** More about the Project, under its facts: the Hub's Front Page choice and its cautions. */
		details?: Snippet<[Project]>;
		/**
		 * What can be done to the Project, in a row of its own.
		 *
		 * A card handed none lays itself out as one column rather than as an empty two, which is why
		 * the Front Page's cards are not the Hub's with a gap where the buttons were.
		 */
		actions?: Snippet<[Project]>;
		/** Where the list sits on its own page, in the consumer's terms — its margin and nothing else. */
		class?: string;
		/** A handle for the list as a whole, for a consumer whose tests address it. */
		testid?: string;
	} = $props();
</script>

<ul class={['flex flex-col gap-3', listClass]} data-testid={testid}>
	{#each projects as project (project.directory)}
		<li class="card bg-base-100 card-border">
			<div
				class={actions
					? 'card-body flex-row flex-wrap items-center justify-between gap-4'
					: 'card-body'}
			>
				<div>
					<svelte:element this={heading} class="text-lg font-medium">
						<a class="link" href={project.href}>{project.name}</a>
					</svelte:element>
					<p class="text-sm break-words opacity-70">
						{#if facts}{@render facts(project)} ·
						{/if}folder <code>{project.directory}</code>
					</p>
					{#if details}{@render details(project)}{/if}
				</div>
				{#if actions}
					<div class="flex flex-wrap gap-2">{@render actions(project)}</div>
				{/if}
			</div>
		</li>
	{/each}
</ul>

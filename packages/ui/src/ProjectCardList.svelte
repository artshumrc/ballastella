<script
	lang="ts"
	generics="Item extends { readonly name: string; readonly directory: string; readonly href?: string }"
>
	// The ruled list of rows both apps draw the Workspace Home from: the editor's Projects, the
	// editor's Map Images, and a Published Site's Front Page (sidereal-ruled SPEC stories 30–37).
	//
	// **Rows ruled from each other, not cards floating on the page** (ADR-0036). One hairline between
	// rows and one above and below the list is the whole of the structure; the rule is `--color-rule`,
	// which is a mix against `base-content` so that it is equally visible on either ground.
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
		media,
		facts,
		details,
		actions,
		class: listClass,
		testid,
		itemTestid
	}: {
		/**
		 * The rows to list, in the order they are to be read. Keyed by folder.
		 *
		 * Named `projects` because the Projects list is what this component is: the editor's Map Image
		 * list is the same row over a different subject, and giving it a second prop name would be the
		 * first step back towards a second component.
		 */
		projects: readonly Item[];
		/**
		 * The heading level each row's name is given.
		 *
		 * The Workspace Home sits each list under its own heading and the Front Page under the bar's
		 * `<h1>`, so the level that keeps a page's outline true is the page's to state.
		 */
		heading?: 'h2' | 'h3';
		/**
		 * A picture of the row's subject, before its name and on the same line (ADR-0030).
		 *
		 * The editor's Map Image list hands over a thumbnail; the Projects lists hand over nothing,
		 * and a Project's thumbnail is deliberately not derived from its Layers — that would make the
		 * Workspace Home read Project files and tile pyramids to draw its own list.
		 */
		media?: Snippet<[Item]>;
		/** Anything the consumer knows about the row, said before the folder on the same line. */
		facts?: Snippet<[Item]>;
		/** More about the row, under its facts: the editor's cautions and its used-by sentence. */
		details?: Snippet<[Item]>;
		/**
		 * What can be done to the row's subject, at the end of the row.
		 *
		 * Delete is last and is the only action in `error` (ADR-0036), which is what keeps it from
		 * being mistaken for the control beside it. A row handed no actions has none at all, which is
		 * why a Reader's Front Page is not the author's list with a gap where the buttons were.
		 */
		actions?: Snippet<[Item]>;
		/** Where the list sits on its own page, in the consumer's terms — its measure and its margin. */
		class?: string;
		/** A handle for the list as a whole, for a consumer whose tests address it. */
		testid?: string;
		/**
		 * A handle for each row, for a consumer whose tests count them.
		 *
		 * The editor's Map Image rows are reached this way — the row, not something inside it, is what
		 * a count and a `filter({ hasText })` address.
		 */
		itemTestid?: string;
	} = $props();
</script>

<ul class={['divide-y divide-rule border-y border-rule', listClass]} data-testid={testid}>
	{#each projects as project (project.directory)}
		<li class="flex flex-wrap items-center gap-4 py-4" data-testid={itemTestid}>
			{#if media}{@render media(project)}{/if}
			<!-- `grow` so a picture and a name stay beside each other rather than with the row's free
			     space opening up between them, and `min-w-0` so a long folder name wraps inside the
			     column instead of widening the row past its measure. -->
			<div class="min-w-0 grow">
				<svelte:element this={heading} class="text-lg font-medium">
					<!-- A row is a link only where there is somewhere to go. A Map Image is not a
					     destination — `/align` refuses to open without a Project — so its name is text,
					     which is the same rule the actions follow: what the consumer does not hand over,
					     the row does not have. -->
					{#if project.href}<a class="link" href={project.href}>{project.name}</a
						>{:else}{project.name}{/if}
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
		</li>
	{/each}
</ul>

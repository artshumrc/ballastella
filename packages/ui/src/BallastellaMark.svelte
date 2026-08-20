<script lang="ts">
	// The ballastella itself: a graduated staff, its sliding crosspiece, and the star being sighted.
	//
	// The instrument the project is named after (CONTEXT.md): a Control Point pair *is* a sighting, so
	// the mark is the act the tool exists for rather than a decoration on top of it.
	//
	// ⚠ **This is still placeholder geometry, and it says so where it came from too.** The same three
	// strokes were drawn in the repository's first commit as `assets/favicon.svg`, carrying the comment
	// that real identity work replaces them. Nothing here promotes a placeholder to a decision — it
	// draws the placeholder in the one place a mark now has to appear, at the one size and colour the
	// file version could not provide.
	//
	// **Inline rather than the favicon file, because a mark in the bar has to follow the theme.** An
	// `<img src="favicon.svg">` renders in its own document and cannot inherit anything, so it would be
	// stuck at one literal colour in both themes; `currentColor` here takes the ink of whatever draws
	// it, which in the masthead is the wordmark's own. That is also why the size is in `em` — the mark
	// scales with the type it sits beside instead of being set twice.
	//
	// ⚠ **The geometry is duplicated with `apps/{editor,viewer}/src/lib/assets/favicon.svg` and
	// `apps/editor/static/icons/icon.svg`, and it cannot be shared.** A favicon and an installed-app
	// icon must be standalone files with literal colours; a themed inline mark must be inline. Four
	// copies of two paths and a circle is the cost, so a change to the shape is a change to all four.

	let { class: className = '' }: { class?: string } = $props();
</script>

<!--
	`aria-hidden`, because the wordmark beside it already says "Ballastella" in text. A mark that
	announced the name again would make every screen reader read the app's name twice, and a mark that
	announced it *instead* would put the name in a place a translator cannot reach.
-->
<svg
	class={className}
	viewBox="0 0 32 32"
	width="1em"
	height="1em"
	aria-hidden="true"
	focusable="false"
>
	<g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
		<!-- The staff, and the crosspiece that slides along it. -->
		<path d="M5 27 L23 9" />
		<path d="M13 11 L23 21" />
	</g>
	<!-- The star, at the end of the sightline. -->
	<circle cx="26" cy="6" r="2.5" fill="currentColor" />
</svg>

<script lang="ts">
	// One Annotation's row, and the disclosure that opens it.
	//
	// **The row is the disclosure.** The editor used to render an Annotation's details as a *sibling of
	// the list*: a box headed "The west quay" sitting under a list in which "The west quay" is one of
	// four rows, with nothing joining the two. With four Annotations in a 24 rem column, which row the
	// panel belonged to was inferred rather than seen. So the details open inside the row they belong
	// to — the same idea the Layer card one level up already follows.
	//
	// **What the open row reveals is the consumer's**, and that is the whole of the difference between
	// the two apps here: the editor passes its Annotation editor, and a published site passes the
	// title and the rendered description with nothing to press. There is no `readOnly` prop and no
	// `mode` prop — a control a Reader must not have is a snippet the viewer does not pass.

	import { annotationOrdinal, type Annotation } from '@ballastella/core';
	import type { Snippet } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { prefersReducedMotion } from 'svelte/motion';
	import { slide } from 'svelte/transition';

	import { annotationName, shapeWord } from './annotation-name.js';
	import { KIND_STYLE } from './layer-kind-style.js';
	import { iconForGeometry } from './shape-icons.js';

	let {
		annotation,
		index,
		open,
		onopen,
		contents
	}: {
		annotation: Annotation;
		/**
		 * Where this Annotation sits in its collection, counted from zero.
		 *
		 * Read for the ordinal this row draws, for the untitled fallback's number, and by whatever the
		 * open row reveals, which is handed the same number — and that is why it is the *collection's*
		 * position rather than this row's: the one Annotation shown on its own under the drawing tools
		 * must read as the same "Untitled pin 3" it reads as in the list.
		 */
		index: number;
		open: boolean;
		/** The row was pressed: this Annotation's id to open it, `null` to close it. */
		onopen: (id: string | null) => void;
		/**
		 * What the open row reveals, given this Annotation and its place in the collection. Without it
		 * the row still opens, on nothing.
		 *
		 * The index goes with it because a consumer that names the Annotation must be able to name it
		 * the way the button above does — see `annotation-name.ts`. A snippet that has no use for it
		 * simply declares one parameter.
		 *
		 * Explicitly `| undefined` because `AnnotationList` forwards whatever it was given, and
		 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and undefined".
		 */
		contents?: Snippet<[Annotation, number]> | undefined;
	} = $props();

	/**
	 * How long a row takes to open or close.
	 *
	 * The same pair the Layer cards' reorder uses, read from the same signal — see `moveAnimation` in
	 * `LayerList.svelte`. A row that simply appeared would leave a scholar to work out where a panel
	 * of controls had come from; the slide is what says "out of this row".
	 *
	 * Zero when the user has asked for less motion, which is the whole of respecting that here: the
	 * row still opens, it simply arrives rather than travels.
	 */
	const reveal = $derived({
		duration: prefersReducedMotion.current ? 0 : 220,
		easing: cubicOut
	});

	/**
	 * This row's own button, so an opened row can be brought back into the column.
	 *
	 * A plain `let` rather than `$state`, for the reason `LayerList`'s button references are: nothing
	 * renders from it, it is read once after the row opens, and making it reactive would turn writing
	 * a `bind:this` into a state change.
	 */
	let button: HTMLButtonElement | undefined = undefined;

	/**
	 * The nearest ancestor that scrolls, or `null` when the page itself is what scrolls.
	 *
	 * Both answers are real layouts rather than one being a fallback: the editor's sidebar is a
	 * `overflow-y-auto` column, and a published site's Layer list is an ordinary block in a page that
	 * scrolls as a whole — which is also what the editor's sidebar becomes on a phone.
	 */
	const scrollingAncestor = (from: HTMLElement): HTMLElement | null => {
		for (let node = from.parentElement; node !== null; node = node.parentElement) {
			const overflow = getComputedStyle(node).overflowY;
			if (overflow === 'auto' || overflow === 'scroll') return node;
		}
		return null;
	};

	/** How still the column has to be before it counts as stopped. Two smooth-scroll frames and more. */
	const STILL_MS = 200;

	/** The longest the measurement will wait, however busy the column is. */
	const SETTLE_MS = 900;

	/**
	 * Resolve once nothing has scrolled `column` for {@link STILL_MS}, or once {@link SETTLE_MS} is up.
	 *
	 * ⚠ **A single `scrollend` is not enough, and the reason is worth keeping.** Opening a row that is
	 * only half in view scrolls the column *twice*: once to bring the button the pointer or the
	 * keyboard is on into view, and again when the panel underneath it appears. The first of those is
	 * instant, so its `scrollend` can land in the same task as the click — before this ever gets a
	 * listener on — or immediately after it, and a `once: true` listener that caught it would report
	 * "settled" while the second scroll had not begun. Measured in Chromium: `scrollend` at 47 ms,
	 * then a smooth scroll running from 81 ms to 347 ms. Stillness answers "has it stopped" for both.
	 */
	const scrollSettled = (column: HTMLElement | Document): Promise<void> =>
		new Promise((resolve) => {
			const done = (): void => {
				clearTimeout(still);
				clearTimeout(cap);
				column.removeEventListener('scroll', restart);
				resolve();
			};
			const restart = (): void => {
				clearTimeout(still);
				still = setTimeout(done, STILL_MS);
			};
			let still = setTimeout(done, STILL_MS);
			const cap = setTimeout(done, SETTLE_MS);
			column.addEventListener('scroll', restart);
		});

	/**
	 * Bring this row's header back onto the screen if opening it has taken it off.
	 *
	 * **A 24 rem sidebar can push a row off its own screen by opening it**: what the row reveals is
	 * taller than the column has left below it, and the column scrolls to show it. Only when the
	 * header has really left, though — scrolling a row that is already in view moves the page under a
	 * pointer that asked for nothing of the sort.
	 *
	 * ⚠ **The measurement waits for the column to stop moving, and `await tick()` is not that.** What
	 * takes the header off the top is not the reveal — the revealed region is *below* the button in
	 * the same `<li>` and cannot push it anywhere — it is what the consumer's own contents do when
	 * they appear. The editor's panel calls `scrollIntoView({ behavior: 'smooth' })` on itself, which
	 * the compositor performs over frames that have not happened yet one microtask after the click.
	 * Measured in Chromium with eight Annotations in a 260 px column: at the microtask the header sat
	 * 225 px inside the column, so the guard below found it in view and returned; when the scroll
	 * finished it was 38 px *above* the top edge. Identical under `prefers-reduced-motion: reduce` —
	 * Chrome does not make a smooth scroll synchronous for that setting.
	 *
	 * {@link scrollSettled} is what waits for it, and it waits for stillness rather than for a single
	 * `scrollend`, for the reason recorded there.
	 *
	 * **Nothing is focused.** Whatever had the keyboard keeps it; this moves the viewport and nothing
	 * else — which is what lets it run for a row opened from the map without stealing the pointer's
	 * place on the canvas.
	 */
	const keepInView = async (header: HTMLButtonElement): Promise<void> => {
		const column = scrollingAncestor(header);
		await scrollSettled(column ?? document);
		// ⚠ **Taken as an argument and checked afterwards**, because the wait outlives the row: `bind:this`
		// writes `null` back when the `<li>` goes, and a Layer card closed while the column was still
		// settling left this reading a property of nothing.
		if (!header.isConnected) return;
		const at = header.getBoundingClientRect();
		const box = column ? column.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
		if (at.top >= box.top && at.bottom <= box.bottom) return;
		header.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	};

	/**
	 * An open row is on the screen, **however it came to be open**.
	 *
	 * An effect rather than the tail of the click handler, because pressing this button is not the
	 * only way in: clicking an Annotation on the map opens its Layer's card and its row, and on a
	 * phone that row is a screen away from the pin that was tapped. One rule serves both, and it is
	 * the rule the row already owned for its own gesture.
	 */
	$effect(() => {
		if (!open || !button) return;
		void keepInView(button);
	});

	/**
	 * How one Annotation reads in the list.
	 *
	 * `annotation-name.ts`'s rather than this component's, because what the open row reveals names the
	 * same Annotation a few pixels below this button and the two must not be able to disagree.
	 */
	const name = $derived(annotationName(annotation, index));

	const Icon = $derived(iconForGeometry(annotation.geometry?.type));
</script>

<!--
	**The selected Annotation's row is marked in the Annotation Layer's own two colours, and the marks
	are on the whole row rather than on the header inside it.** In a 24 rem column of four
	near-identical rows a wash on the header strip alone was not enough to say which row had been
	chosen — the fault a scholar reported first — and the header is in any case only part of the row:
	the wash has to cover the header and whatever the row reveals together, so that the selected
	Annotation is one marked block instead of a tinted strip above an untinted one.

	`KIND_STYLE.annotation.tint` is the same 10% the card's header wears, from the one table every
	colour in this card comes from (`layer-kind-style.ts`). It is a wash rather than a fill for a
	reason: at 10% over `base-100` the row's text stays on the colour it was already legible on, where
	a `base-content` slab has to re-solve its own contrast and then repaint the text to win.

	⚠ **The spine is not the rule that was removed.** What was removed was `border-primary` over
	daisyUI's `menu-active`: two colours making two claims, `primary` being the *app's* action colour
	reserved for the controls outside the Layer cards, and `menu-active` painting `base-content` —
	near-black in the light theme — so a blue rule sat against a black slab in a card whose every other
	control is `info`. Nothing about either colour said "this belongs to the Annotations". This spine is
	the Annotation Layer's own ink, `--layer-kind-ink-annotation`, the same custom property
	`KIND_STYLE.annotation.ink` sets text in and `layout.css` computes from `--color-info`; and it is on
	the selected row only, where the removed rule was drawn on a row that was merely `menu-active`.

	An inset box shadow rather than `border-l-2`, because a border is layout: two pixels appearing on
	the left of the selected row would shift its text sideways as the selection moved down the list.

	Colour is not the only channel (the-annotation-inspector story 7): the name goes semibold, which
	survives a monochrome screen, and `aria-expanded` is what carries the state to a screen reader
	(story 8 of the same epic).
-->
<li
	class={[
		'border-b border-base-200 last:border-b-0',
		open && `${KIND_STYLE.annotation.tint} shadow-[inset_2px_0_0_var(--layer-kind-ink-annotation)]`
	]}
	data-testid="annotation-row-item"
>
	<!--
		**That button is also the disclosure, and its expanded state is the selection.** There is
		deliberately no `aria-pressed` beside it: a row that was pressed but not open, or open but not
		pressed, would be two answers to "which Annotation is active", and two properties for one fact
		are two things that can disagree (the-annotation-inspector story 54). `aria-expanded` is ADR-0016's shape for a
		disclosure, which is what this is, and it is the Layer card's own convention one level down
		rather than a second one invented here. There is no separate control beside the name for the same
		reason: the gesture that chooses an Annotation is the gesture that opens it.
	-->
	<button
		bind:this={button}
		type="button"
		class={['flex w-full items-center gap-2 rounded-none py-2', open && 'font-semibold']}
		aria-expanded={open}
		aria-controls={open ? `annotation-contents-${annotation.id}` : undefined}
		data-testid="annotation-row"
		data-annotation-id={annotation.id}
		onclick={() => onopen(open ? null : annotation.id)}
	>
		<!--
			**The number, so that "look at 3" identifies one Annotation across a desk** (stories 37, 38).
			It is the same number the mark on the map draws, from `annotationOrdinal` in `core` — one
			rule, so the canvas and the sidebar cannot disagree — and it is *inside the button* rather
			than positioned beside it, so a screen reader hears "3, shape, Untitled shape 3" and nothing
			about which Annotation is which depends on seeing a line (story 42).

			⚠ **Nothing writes it.** The number is this row's place in the collection it was handed, and
			deleting an Annotation renumbers the rest because the list renders again (ADR-0002).

			The kind's own ink rather than a plain `opacity-60` like the shape word: the number is what
			the mark on the map is wearing, and the ink is the measured mix `layout.css` computes from
			`--color-info` — 6.0:1 in the light theme and 8.8:1 in dark, on the row's own 10% wash. The
			raw token is 2.2:1 there and could not carry text this size.
		-->
		<span
			class={['shrink-0 text-xs font-semibold tabular-nums', KIND_STYLE.annotation.ink]}
			data-testid="annotation-row-ordinal"
		>
			{annotationOrdinal(index)}
		</span>

		<!--
			The same glyph the tool that drew it carries, and **beside the word rather than instead of
			it** (SPEC story 111) — the word is what a screen reader reads and what a glyph alone would
			have taken away.
		-->
		<Icon class="size-4 shrink-0 opacity-60" aria-hidden="true" />
		<span class="shrink-0 text-xs opacity-60">{shapeWord(annotation)}</span>
		<span class="truncate" data-testid="annotation-row-name">
			{name}
		</span>
	</button>

	{#if open}
		<!--
			Everything this Annotation is, inside the row it belongs to. One row is open at a time,
			because the consumer holds one open id.

			**`block` and `hover:bg-transparent` are undoing daisyUI's `menu`, not decoration.** Every
			child of a `menu` `<li>` that is not a list or a `.btn` is laid out as a menu item — grid, its
			own padding, and a background on hover — which is right for the row above and wrong for a
			panel of controls that happens to sit under it.

			`data-reveal-ms` is the number `reveal` computed, written out because it is otherwise visible
			only to something that can watch an animation — the same reason `LayerList` writes out
			`data-drop-target`. It is what lets a test read the reduced-motion branch's result where there
			is no paint.

			⚠ **It is evidence about the computation and about nothing else.** The attribute and the
			directive read one `$derived`, so a test on the attribute goes red when that number is wrong —
			and stays green when the transition is hard-coded past it, or deleted outright. Whether the
			row *animates*, and for how long, is unasserted at every seam;
			`.tracker/one-shell-two-apps/tickets/01-an-annotation-opens-in-its-own-row.md` records the gap
			under "Coverage gap".
		-->
		<div
			id="annotation-contents-{annotation.id}"
			class="block px-1 pb-2 hover:bg-transparent"
			data-testid="annotation-row-contents"
			data-reveal-ms={reveal.duration}
			transition:slide={reveal}
		>
			{@render contents?.(annotation, index)}
		</div>
	{/if}
</li>

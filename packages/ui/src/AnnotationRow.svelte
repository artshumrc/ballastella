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

	import type { Annotation } from '@ballastella/core';
	import { tick, type Snippet } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { prefersReducedMotion } from 'svelte/motion';
	import { slide } from 'svelte/transition';

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
		 * Only ever read for the untitled fallback's number, which is why it is the *collection's*
		 * position rather than this row's: the one Annotation shown on its own under the drawing tools
		 * must read as the same "Untitled pin 3" it reads as in the list.
		 */
		index: number;
		open: boolean;
		/** The row was pressed: this Annotation's id to open it, `null` to close it. */
		onopen: (id: string | null) => void;
		/**
		 * What the open row reveals. Without it the row still opens, on nothing.
		 *
		 * Explicitly `| undefined` because `AnnotationList` forwards whatever it was given, and
		 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and undefined".
		 */
		contents?: Snippet<[Annotation]> | undefined;
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

	/** The nearest ancestor that scrolls, or `null` when nothing above this one does. */
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
	const scrollSettled = (column: HTMLElement): Promise<void> =>
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
	 * Open this row, or close it, and keep it on screen either way.
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
	 * **Nothing is focused.** The button that was pressed is still there and still has the keyboard;
	 * this moves the viewport and nothing else.
	 */
	const toggle = async (): Promise<void> => {
		if (open) {
			onopen(null);
			return;
		}
		onopen(annotation.id);
		await tick();
		if (!button) return;
		const column = scrollingAncestor(button);
		if (!column) return;
		await scrollSettled(column);
		const header = button.getBoundingClientRect();
		const box = column.getBoundingClientRect();
		if (header.top >= box.top && header.bottom <= box.bottom) return;
		button.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	};

	/**
	 * How one Annotation reads in the list.
	 *
	 * Its title, which is **the user's own words and therefore untrusted text** — this is one of the
	 * places a stranger's `title` reaches the screen, and it is safe for a different reason from the
	 * rendered description below it: Svelte interpolates it, so the DOM never parses it as markup.
	 * Nothing may turn this into `{@html}`; a title that needs rendering is one that needs core's
	 * sanitiser.
	 */
	const name = $derived.by((): string => {
		const title = annotation.properties.title;
		if (title !== undefined && title !== '') return title;
		return `Untitled ${shapeWord(annotation)} ${index + 1}`;
	});

	const shapeWord = (one: Annotation): string => {
		switch (one.geometry?.type) {
			case 'Point':
				return 'pin';
			case 'LineString':
				return 'line';
			case 'Polygon':
				return 'shape';
			default:
				return 'Annotation';
		}
	};

	const Icon = $derived(iconForGeometry(annotation.geometry?.type));
</script>

<li class="border-b border-base-200 last:border-b-0">
	<!--
		**The open row is marked by the Annotation Layer's own wash, and nothing else.**
		`KIND_STYLE.annotation.tint` is the same 10% the card's header wears, from the one table every
		colour in this card comes from (`layer-kind-style.ts`).

		It was `border-primary` with daisyUI's `menu-active`, which is two colours making two claims:
		`primary` is the *app's* action colour, reserved for the controls outside the Layer cards, and
		`menu-active` paints `base-content` — near-black in the light theme — so a blue rule sat against
		a black slab in a card whose every other control is `info`. Reported as clashing, and it was:
		nothing about either colour said "this belongs to the Annotations".

		**The rule down the left edge went with them.** It was the third mark on a row that needed one,
		in a column that already draws a hairline between every row and a border around the whole list —
		a fourth vertical line, two pixels from the box's own. The wash alone says which row it is, and
		it is a wash rather than a fill for a reason: at 10% over `base-100` the row's text stays on the
		colour it was already legible on, where a `base-content` slab has to re-solve its own contrast
		and then repaint the text to win.

		Colour is not the only channel (SPEC story 111): the name goes semibold, which survives a
		monochrome screen, and `aria-expanded` is what carries the state to a screen reader.

		**That button is also the disclosure, and its expanded state is the selection.** There is
		deliberately no `aria-pressed` beside it: a row that was pressed but not open, or open but not
		pressed, would be two answers to "which Annotation is active", and two properties for one fact
		are two things that can disagree. `aria-expanded` is ADR-0016's shape for a disclosure, which is
		what this is, and it is the Layer card's own convention one level down rather than a second one
		invented here. There is no separate control beside the name for the same reason: the gesture
		that chooses an Annotation is the gesture that opens it.
	-->
	<button
		bind:this={button}
		type="button"
		class={[
			'flex w-full items-center gap-2 rounded-none py-2',
			open && `font-semibold ${KIND_STYLE.annotation.tint}`
		]}
		aria-expanded={open}
		aria-controls={open ? `annotation-contents-${annotation.id}` : undefined}
		data-testid="annotation-row"
		data-annotation-id={annotation.id}
		onclick={() => void toggle()}
	>
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
			{@render contents?.(annotation)}
		</div>
	{/if}
</li>

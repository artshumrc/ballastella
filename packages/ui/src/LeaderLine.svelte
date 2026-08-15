<script lang="ts">
	// The dashed line from the selected mark on a canvas to its row in the sidebar (SPEC stories 39,
	// 40, 41, 45, 46).
	//
	// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
	// │ IT CARRIES NO INFORMATION OF ITS OWN, AND THAT IS THE POINT.                               │
	// └───────────────────────────────────────────────────────────────────────────────────────────┘
	// The ordinal is on the mark and on the row, and the row's `aria-expanded` says which Annotation
	// is active — tickets 01 and 08 built both precisely so that this layer can be decoration. So it
	// is `aria-hidden`, it takes no pointer events, it holds nothing focusable, and nothing on either
	// screen becomes unclear if it is never drawn. Which is also why the whole feature was sequenced
	// last and was allowed to be dropped.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHY THE REDRAW IS IMPERATIVE AND TOUCHES NOTHING BUT ONE ATTRIBUTE
	//
	// This recomputes on every frame of a pan. Everything it reads is a `getBoundingClientRect`, and
	// the only thing it writes is the `points` attribute on the polyline below — no component state,
	// no store, no document. `editor-annotations.e2e.ts` already holds the line that typing must not
	// rebuild the Layer stack and that a keystroke must not tear the ordinal marks off the map; the
	// assertion added beside them is that *selecting* an Annotation costs zero store reads and zero
	// store writes, which is the shape of regression a leader is most likely to introduce.
	//
	// Putting the geometry in a `$state` and letting Svelte render it would work and is not free: it
	// schedules a flush per frame for a value only this element reads.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// REDUCED MOTION
	//
	// A line is not motion, and `prefersReducedMotion` does not suppress it. It has no entrance
	// animation of its own — a leader that faded in on every selection would be exactly the thing the
	// setting is about, so there is nothing here to make conditional.

	import { leaderPath, type Box } from './leader-line.js';

	let {
		mark,
		row,
		canvas,
		sidebar,
		watch
	}: {
		/**
		 * The selected mark on the canvas, read at draw time.
		 *
		 * A function rather than an element, because the mark is drawn imperatively by MapLibre —
		 * `annotation-ordinals.ts` and `overlay-points.ts` both attach a `Marker` — so it is outside
		 * every consumer's component tree and is found by querying for it. Reading the consumer's own
		 * selection inside the accessor is also what makes the redraw below react to it.
		 */
		mark: () => Element | null | undefined;
		/** That mark's row in the sidebar. */
		row: () => Element | null | undefined;
		/** The box the mark has to be inside: the map pane, not the whole screen. */
		canvas: () => Element | null | undefined;
		/** The scrolling column the row has to be inside. */
		sidebar: () => Element | null | undefined;
		/**
		 * The consumer's own signal that the camera has moved, given the redraw to call.
		 *
		 * The map's own `move` and `zoom` rather than a timer or an animation frame loop: a line
		 * recomputed on a schedule is a line that lags the map it is drawn over, and one recomputed
		 * for ever is one that costs a frame's work when nothing is selected. Returns its unsubscribe.
		 */
		watch?: (redraw: () => void) => () => void;
	} = $props();

	/**
	 * The layer itself, and the one line in it.
	 *
	 * Plain `let`s rather than `$state`, which is `LayerList`'s convention for a `bind:this` nothing
	 * renders from: these are read by {@link draw} and never by the template, and making them
	 * reactive would turn mounting into a state change.
	 */
	let layer: SVGSVGElement | undefined = undefined;
	let line: SVGPolylineElement | undefined = undefined;

	const boxOf = (element: Element | null | undefined): Box | null =>
		element ? element.getBoundingClientRect() : null;

	/**
	 * Recompute the line and write it out.
	 *
	 * ⚠ **`layer`'s own box is the origin**, because the element is `inset: 0` inside the container
	 * that spans the sidebar and the canvas — so it *is* that container's box, measured rather than
	 * passed in. One fewer prop, and no way for a consumer to hand in a box the line is not drawn in.
	 */
	const draw = (): void => {
		if (!layer || !line) return;
		const column = boxOf(sidebar());
		const pane = boxOf(canvas());
		const path =
			column === null || pane === null
				? null
				: leaderPath({
						layer: layer.getBoundingClientRect(),
						mark: boxOf(mark()),
						canvas: pane,
						row: boxOf(row()),
						sidebar: column
					});

		if (path === null) {
			line.removeAttribute('points');
			layer.dataset.drawn = 'no';
			return;
		}
		line.setAttribute('points', path);
		layer.dataset.drawn = 'yes';
	};

	/** Whether a redraw is already queued, so several signals in one turn cost one measurement. */
	let queued = false;

	/**
	 * Redraw once the turn that asked for it has finished.
	 *
	 * ⚠ **This is a correctness fix and not a throttle, and the reason is worth keeping.** MapLibre
	 * repositions each `Marker` from its *own* `move` listener, and listeners run in the order they
	 * were registered — the pane binds this one when the map is created, and every mark is added to
	 * the map long afterwards. So a redraw performed inside the `move` handler measures the mark at
	 * the position it held **one camera movement ago**. Measured: after a single `setCenter` the
	 * leader's end was 11 000 px from the mark it named, and every frame of a continuous pan was one
	 * frame stale.
	 *
	 * A microtask rather than an animation frame, because MapLibre fires and finishes its whole
	 * listener chain inside one task: the queue drains after the last of them and before the browser
	 * paints, so the line is drawn in the same frame as the map it is drawn over rather than in the
	 * next one.
	 */
	const schedule = (): void => {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			draw();
		});
	};

	/** Whether {@link followAnimations} already has a redraw running once a frame. */
	let following = false;

	/**
	 * Redraw once a frame for as long as something in the sidebar is animating.
	 *
	 * ⚠ **This is what carries the row's expand and collapse, and it is not an event listener because
	 * there is no event to listen for.** Svelte drives a `transition:` — and `animate:flip` on the
	 * Layer cards — through `element.animate()`
	 * (`svelte/src/internal/client/dom/elements/transitions.js`): a Web Animations API animation with
	 * no name, which dispatches neither `animationend` nor `transitionend`. Counted on the container
	 * over a full open → close → open cycle of two rows, `animationend` fired **zero** times. What
	 * used to carry this was daisyUI's colour transition on the newly-open row happening to end at
	 * about the same moment as the slide, which a design tweak to the open row could take away
	 * without anything going red.
	 *
	 * A `flip` is the case an end-of-animation signal would not be enough for on its own: it finishes
	 * with neither an event nor a DOM change, and because `getBoundingClientRect` includes the FLIP
	 * transform, a single redraw taken as the cards begin to move reads a row at the position it is
	 * animating *from*. Following the frames is what makes that come out right at both ends.
	 *
	 * ⚠ **`getAnimations` is asked of the sidebar and never of the canvas.** The canvas holds an
	 * `infinite` keyframe animation — the pending Control Point's pulse in the editor's `layout.css`
	 * — and a loop that ran while anything in it was running would never stop.
	 */
	const followAnimations = (): void => {
		if (following) return;
		const running = (): boolean =>
			(sidebar()?.getAnimations({ subtree: true }) ?? []).some(
				(animation) => animation.playState === 'running'
			);
		if (!running()) return;
		following = true;
		// Drawn before the test, so the frame that finds nothing running is also the frame that draws
		// the settled geometry.
		const step = (): void => {
			draw();
			if (running()) requestAnimationFrame(step);
			else following = false;
		};
		requestAnimationFrame(step);
	};

	/**
	 * Redraw whenever what is selected changes.
	 *
	 * The accessors read the consumer's own state — which Annotation is open, which Control Point is
	 * selected — so calling them here is how those become this effect's dependencies. Nothing else is
	 * read, and in particular the map's camera is not: a `$derived` over the camera would put a
	 * component flush in every frame of a pan.
	 *
	 * Choosing a row is also what starts the slide that opens it and the one that closes whatever was
	 * open before, and Svelte has started both by the time an effect runs — so this is the one place
	 * that can hand them to {@link followAnimations} at the frame they begin.
	 */
	$effect(() => {
		draw();
		followAnimations();
	});

	/**
	 * Everything else that moves either end.
	 *
	 * Its own effect, so that a change of selection does not tear these down and set them up again.
	 *
	 * - **the map's own move and zoom**, through {@link watch};
	 * - **scroll, in the capture phase on the window**, which is the only way to hear a scroll inside
	 *   the sidebar: scroll events do not bubble, but they do capture;
	 * - **window resize**, which changes both boxes and can cross the stacking breakpoint;
	 * - **the end of a CSS transition** anywhere in the container. ⚠ This is *not* what carries the
	 *   row's expand and collapse — {@link followAnimations} is, and its note says why an event
	 *   cannot be. It is a backstop for the CSS transitions the two columns really do run, which
	 *   nothing else would hear the end of;
	 * - **anything appearing in or leaving either box**: a Layer card opening, a row being rendered
	 *   for the first time, a mark being added to the map. One `MutationObserver` over the two
	 *   subtrees answers "which Layers are shown" and "is the row there yet" together, and it watches
	 *   `childList` only — MapLibre repositions a marker by writing its `transform`, so an attribute
	 *   observer would fire on every frame of a pan for something `watch` already covers. A card
	 *   arriving or leaving is also how a Layer reorder and a collapse that finished announce
	 *   themselves, so this is the other place {@link followAnimations} is offered the frame.
	 */
	$effect(() => {
		const column = sidebar();
		const pane = canvas();
		const container = layer?.parentElement ?? null;

		const unwatch = watch?.(schedule);
		window.addEventListener('scroll', schedule, true);
		window.addEventListener('resize', schedule);
		container?.addEventListener('transitionend', schedule, true);

		const observer = new MutationObserver(() => {
			schedule();
			followAnimations();
		});
		for (const subtree of [column, pane]) {
			if (subtree) observer.observe(subtree, { childList: true, subtree: true });
		}

		// ⚠ **`schedule` and not `draw`.** `draw` reads the accessors, and reading them here would make
		// every one of the consumer's own signals — which Annotation is selected above all — a
		// dependency of *this* effect, so choosing a row would tear all of these listeners down and set
		// them up again. The effect above is what redraws on a change of selection.
		schedule();

		return () => {
			unwatch?.();
			observer.disconnect();
			window.removeEventListener('scroll', schedule, true);
			window.removeEventListener('resize', schedule);
			container?.removeEventListener('transitionend', schedule, true);
		};
	});
</script>

<!--
	One layer for one line. `aria-hidden` and `pointer-events: none` are in the stylesheet beside the
	dashes — see `.leader-line` in `layout.css` — and the element holds nothing focusable, so it is
	not in the tab order and there is nothing here for a screen reader to meet.

	`data-drawn` is what says whether there is a line, written out because an SVG polyline with no
	`points` is otherwise indistinguishable from one that was never asked for.
-->
<svg
	bind:this={layer}
	class="leader-line"
	aria-hidden="true"
	focusable="false"
	data-testid="leader-line"
	data-drawn="no"
>
	<polyline bind:this={line} class="leader-line-path" />
</svg>

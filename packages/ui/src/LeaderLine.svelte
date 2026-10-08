<script lang="ts">
	import { leaderPath, type Box } from './leader-line.js';

	let {
		mark,
		row,
		canvas,
		sidebar,
		watch
	}: {
		mark: () => Box | null | undefined;
		row: () => Element | null | undefined;
		canvas: () => Element | null | undefined;
		sidebar: () => Element | null | undefined;
		watch?: (redraw: () => void) => () => void;
	} = $props();

	let layer: SVGSVGElement | undefined = undefined;
	let line: SVGPolylineElement | undefined = undefined;

	const boxOf = (element: Element | null | undefined): Box | null =>
		element ? element.getBoundingClientRect() : null;

	const draw = (): void => {
		if (!layer || !line) return;
		const column = boxOf(sidebar());
		const pane = boxOf(canvas());
		const path =
			column === null || pane === null
				? null
				: leaderPath({
						layer: layer.getBoundingClientRect(),
						mark: mark() ?? null,
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

	let queued = false;

	const schedule = (): void => {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			draw();
		});
	};

	let following = false;

	const followAnimations = (): void => {
		if (following) return;
		const running = (): boolean =>
			(sidebar()?.getAnimations({ subtree: true }) ?? []).some(
				(animation) => animation.playState === 'running'
			);
		if (!running()) return;
		following = true;
		// Drawn before the test, so the frame that finds nothing running is also the frame that draws the settled geometry.
		const step = (): void => {
			draw();
			if (running()) requestAnimationFrame(step);
			else following = false;
		};
		requestAnimationFrame(step);
	};

	$effect(() => {
		draw();
		followAnimations();
	});

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

<!-- `aria-hidden` and `pointer-events: none` are in the stylesheet beside the dashes — see `.leader-line` in `layout.css` — and the element holds nothing focusable, so it is not in the tab order and… -->
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

// `Element.animate()` for this package's component seam, because happy-dom implements no Web
// Animations API and Svelte drives a `transition:` through one whenever it has a duration or a delay
// to serve.
//
// **A transition with neither never reaches it.** `svelte/src/internal/client/dom/elements/
// transitions.js` (5.56.8) short-circuits on `if (!options?.duration && !options?.delay)`, calling
// `on_begin()` and `on_finish()` and returning before any animation is constructed — so the
// reduced-motion branch, whose duration is zero, does not touch this file at all.
//
// Without this, mounting a component with a `transition:` and then opening or closing the block it
// sits in throws `element.animate is not a function` from inside Svelte's own runtime. It surfaces
// as an *unhandled* exception rather than a failed assertion — the throw is in a microtask — so the
// symptom is a suite that fails somewhere other than where the fault is, and an element that is
// transitioning out never gets removed.
//
// ⚠ **This is a second copy of `apps/editor/vitest-setup/web-animations.ts`, and it has to be.**
// A vitest setup file is loaded by path, and nothing in this package may reach into an app
// (ADR-0034, `scripts/check-ui-package-imports.mjs`). The shim is not shared behaviour with a
// consumer either — it is scaffolding for a DOM implementation, and each seam that mounts a
// component with a `transition:` needs one of its own.
//
// ⚠ **NOTHING AT THIS SEAM MAY ASSERT ANYTHING ABOUT AN ANIMATION.** This is not a Web Animations
// implementation and must not be treated as evidence about one. It has no clock, no timeline, no
// keyframes and no paint: it finishes on the next microtask whatever duration it was handed, so a
// test that waited for a transition would be waiting on this file rather than on the component, and
// a test that measured one would be measuring nothing. What a component *decides* about an
// animation — the duration it asks for, which is the whole of respecting `prefers-reduced-motion` —
// is a value it can put in the DOM, and that is where such claims are asserted.
//
// The reason it finishes rather than hanging is the removal: Svelte takes a node out of the DOM when
// its outro *finishes*, so an animation that never finished would leave every collapsed row in the
// document and quietly break the counts a dozen honest assertions make.

/** The smallest thing Svelte's transition runtime reads: `onfinish`, `cancel`, and the two fields. */
class ImmediateAnimation {
	currentTime = 0;
	playState: 'running' | 'finished' | 'idle' = 'running';
	onfinish: (() => void) | null = null;
	effect: unknown = null;

	#done = false;

	constructor(duration: number) {
		queueMicrotask(() => {
			if (this.#done) return;
			this.#done = true;
			this.currentTime = duration;
			this.playState = 'finished';
			this.onfinish?.();
		});
	}

	cancel(): void {
		this.#done = true;
		this.playState = 'idle';
	}
}

Element.prototype.animate = function (
	_keyframes: unknown,
	options?: number | { duration?: number | string | null }
): Animation {
	const duration = typeof options === 'number' ? options : Number(options?.duration ?? 0);
	return new ImmediateAnimation(Number.isFinite(duration) ? duration : 0) as unknown as Animation;
} as Element['animate'];

/**
 * Always empty, which is the only answer this seam can honestly give.
 *
 * `LeaderLine` asks the sidebar what is animating in it, and happy-dom has no `getAnimations` at all
 * — without this, mounting it throws. Answering "nothing" is truthful here rather than a
 * simplification: the shim above has no timeline and finishes on the next microtask, so there is no
 * interval during which anything *is* running to report. It follows, per this file's ⚠ above, that
 * nothing at this seam tests the frame loop that reads it; `e2e/` does.
 */
Element.prototype.getAnimations = (): Animation[] => [];

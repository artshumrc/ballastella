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

Element.prototype.getAnimations = (): Animation[] => [];

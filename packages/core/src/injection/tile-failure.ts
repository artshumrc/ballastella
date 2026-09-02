// What a Reader — or a scholar — is told when a Map Image's tiles stop arriving.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS HERE AND NOT BESIDE `baseMapUnavailableNotice`
//
// `base-map/resolve.ts` is the obvious home for a Map Image's failure and the wrong one:
// everything in `base-map/` takes a `BaseMapEntry` and answers questions about the modern
// reference map underneath the work, and this answers a question about the work itself. What
// decides *this* wording is not a catalog entry but the refusal the injection layer met — so it
// lives beside {@link createStoreImageFetch}, which is the module that produces the facts and the
// one place that can classify them.
//
// It follows `baseMapUnavailableNotice` in every other respect, deliberately, because it is the same
// promise made about a different failure:
//
//   - **One function, rendered by both deployments.** The published viewer renders it and the editor
//     renders it. Two templates would be two answers to one outage, and the scholar who shares a
//     site is the same person who reads it.
//   - **Three things, in the order the questions arrive**: it is not you; your work is safe; here is
//     what would fix it.
//   - **Visible text, never a tooltip** (ADR-0016: daisyUI renders tooltips through CSS `::before`,
//     so they are neither announced nor dismissable).
//
// ⚠ **The remedies are what the branch is for.** A Reader who reconnects when the site is simply
// missing a file has been sent to do something that cannot work, and one told "that server is having
// a bad afternoon" when their own wifi is off is worse off than one told nothing. So the rows are
// told apart on the facts the refusal carried — a status, or the absence of one — and never on which
// application is asking.

/**
 * Why a Map Image's tiles could not be fetched, in the terms the remedy turns on.
 *
 * `host` is `null` when the bytes were being read from the site or Workspace the page itself came
 * from, and a hostname when they were being read from somebody else's server — a Library holding a
 * referenced image (ADR-0023). That is the same `null`-means-here convention
 * `baseMapUnavailableNotice` takes, and for the same reason: naming a whole URL at a Reader names a
 * path they cannot act on, while the host identifies who is having the bad afternoon.
 */
export type TileSourceFailure =
	/** The request got no answer at all — a dropped connection, a refused socket, a CORS refusal. */
	| { readonly kind: 'no-answer'; readonly host: string | null }
	/** The server answered, and said it does not hold the file the map is drawn from. */
	| { readonly kind: 'file-missing'; readonly host: string | null }
	/** The server answered with a failure of its own. */
	| { readonly kind: 'server-error'; readonly host: string | null; readonly status: number }
	/**
	 * The read failed for a reason none of the rows above describes — a storage backend refusing, a
	 * permission withdrawn, something unforeseen.
	 *
	 * ⚠ **This row exists so that the other three cannot be made to lie.** The three failures with a
	 * remedy of their own are the three above; this is the honest fourth answer for everything else,
	 * and the alternative — folding an unknown failure into `no-answer` — would tell a scholar whose
	 * browser storage refused to check their connection. It says what happened and offers the only
	 * remedy that is true of every case, which is to try again.
	 */
	| { readonly kind: 'unreadable'; readonly host: string | null; readonly detail: string };

/** `null` means the page's own origin — see {@link TileSourceFailure}. */
const where = (host: string | null): string => (host === null ? 'this site' : host);

/**
 * The sentence shown when a Map Image's tiles stop arriving.
 *
 * @param failure why the tiles could not be fetched
 * @param mapName the Layer's name, or `null` when the failure cannot be attributed to one Layer —
 *   a pass-through request carries a URL and not a Layer, and a sentence that named the wrong map
 *   would send a scholar to check an Alignment that is fine
 */
export function mapImageTilesUnavailableNotice(
	failure: TileSourceFailure,
	mapName: string | null = null
): string {
	const subject = mapName === null ? 'A Map Image on this page' : `The Map Image “${mapName}”`;
	return `${subject} ${cause(failure)} ${SAFE} ${remedy(failure)}`;
}

/**
 * What happened, said as a fact about a server rather than as an error code.
 *
 * "stopped drawing" rather than "failed to load": the failure this sentence exists for is a
 * *mid-session* one, where some of the map is already on screen and stays there. A word implying
 * nothing arrived would contradict the rectangle the Reader is looking at.
 */
function cause(failure: TileSourceFailure): string {
	switch (failure.kind) {
		case 'no-answer':
			return `stopped drawing, because ${where(failure.host)} could not be reached.`;
		case 'file-missing':
			return `stopped drawing, because ${where(failure.host)} does not hold the file it is drawn from.`;
		case 'server-error':
			return `stopped drawing, because ${where(failure.host)} answered ${failure.status}.`;
		case 'unreadable':
			return `stopped drawing, because its tiles could not be read from ${where(failure.host)}: ${failure.detail}`;
	}
}

/**
 * It is not you, and your work is safe — the two things a Reader needs before the remedy.
 *
 * ⚠ **Every clause here has to be true in all four rows**, which is why it is one constant rather
 * than four sentences. It claims nothing about what *is* drawn beyond "whatever had already been
 * drawn is still there", which is the contract the injection layer actually keeps: a refused tile
 * discards no tile that arrived. Anything stronger — that the map is complete, that the geography is
 * under it — would be false in a row somebody meets.
 */
const SAFE =
	'Nothing you did caused this, and nothing has been lost: the Annotations and the rest of the ' +
	'author’s work are unaffected, and whatever of the map had already been drawn is still on screen.';

/**
 * What would help — and, as importantly, what would not.
 *
 * The four rows differ here and nowhere else. `resolve`-style row tests in
 * `tile-failure.test.ts` drive every one of them, plus one asserting that no row makes a claim
 * belonging to another: telling somebody to reconnect when the file is simply absent is advice that
 * cannot work, and it is the failure `baseMapUnavailableNotice` was split into rows to end.
 */
function remedy(failure: TileSourceFailure): string {
	switch (failure.kind) {
		case 'no-answer':
			// Deliberately does not decide between the two. `status === 0` is the browser saying it got
			// nothing back, and from inside the page a dropped connection and a server that has stopped
			// answering are indistinguishable — so the sentence says both rather than guessing, which is
			// the same discipline `online.svelte.ts` applies to `navigator.onLine`.
			return (
				'That is either your connection or that server, and there is no way to tell which from ' +
				`here. ${WHEN_IT_ANSWERS_AGAIN}`
			);
		case 'file-missing':
			// No recovery clause: there is nothing to come back. Telling somebody to reload a page to
			// re-request a file the site does not carry is advice that cannot work, which is the whole
			// reason this row is told apart from the two that can recover.
			return (
				'Reconnecting will not help, because the file is not there to fetch. Whoever made ' +
				'this site has to restore it.'
			);
		case 'server-error':
			// The server answered, so the connection demonstrably works. That is the one thing this row
			// can say with certainty and the one thing the row above cannot.
			return (
				'The server answered, so your own connection is working and it is that server that is ' +
				`failing. ${WHEN_IT_ANSWERS_AGAIN}`
			);
		case 'unreadable':
			return 'Reloading the page is the thing most likely to help.';
	}
}

/**
 * What actually happens when the bytes become fetchable again — measured, not assumed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS DOES NOT SAY "THE MAP FINISHES DRAWING ON ITS OWN"
 *
 * ⚠ It used to, and it was **false for the commoner half of the failure**. `viewer-reader.e2e.ts`
 * drives both shapes and the two do not recover alike:
 *
 *   - a refused **`info.json`** DOES heal with no gesture at all, because `WebGL2Renderer.render`
 *     calls `loadMissingImagesInViewport()` on every frame and re-asks for it until it arrives —
 *     given frames to run in, which is what {@link keepAskingForMissingTiles} is for;
 *   - a refused **tile cell** does NOT. The renderer never asks for it again — **not even after a
 *     zoom**, which was measured too, because the failed cell is already in its tile cache. Only a
 *     rebuilt layer re-requests it.
 *
 * So a Reader who followed the old sentence — "worth checking your connection and waiting rather than
 * reloading" — waited in front of a warning that would never go, over a map that would never finish.
 * A sentence promising something the code cannot do is the failure mode this module exists to stop.
 *
 * Hiding and showing the Layer is named as well as reloading because it is the cheaper of the two and
 * it is measured to work: the Reader keeps their place on the map, their Annotations, and every other
 * Layer.
 */
const WHEN_IT_ANSWERS_AGAIN =
	'When it is answering again the map picks up what it can by itself; anything still missing ' +
	'comes back if you hide this Layer and show it again, or reload the page.';

/**
 * How long to wait before each successive re-ask, in milliseconds.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A SCHEDULE HERE AT ALL, AND WHY IT ENDS
 *
 * `loadMissingImagesInViewport()` runs on every painted frame — but **MapLibre does not paint when
 * nothing changes.** So the self-healing half of the sentence above held only for a Reader whose map
 * happened to still be settling: an unrelated straggler repaint, the tail of the Base Map's tiles,
 * had to land after the bytes became fetchable. In front of a map that had fully settled — no click,
 * no zoom, nobody touching anything — zero frames were painted, the record was never re-requested,
 * and the notice stayed up for ever. That is precisely the Reader this sentence is addressed to, and
 * for them it was false.
 *
 * The fix is to give the renderer frames of its own while something is missing. Not a permanent
 * animation loop: a site that stays broken must not cost a Reader their battery, and each frame is
 * another request to a server already known to be failing.
 *
 * **It doubles, and then it stops.** Fast at the start because most outages that recover recover
 * within seconds and that is when a Reader is still watching; slow at the end because by then the
 * server is not coming back on this pageview. The budget is eleven re-asks over 151,750ms — two
 * minutes and thirty-two seconds of *delivered frames*, which is longer in wall-clock time whenever
 * the tab is not being painted — after which the remedy the sentence already names — hide the Layer
 * and show it again, or reload — is the one that applies, and it is a gesture that works for the
 * tile-cell half too.
 *
 * Both figures are pinned in `tile-failure.test.ts`, because they are quoted in ADR-0028.
 */
export const TILE_RECOVERY_DELAYS: readonly number[] = [
	250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000
];

/**
 * Ask the renderer to draw again, on the schedule above, until it is told to stop.
 *
 * @param askAgain draw one frame — `map.triggerRepaint()` in the viewer, which is what gets
 *   `WebGL2Renderer.render` called and so what re-requests a refused `info.json`. It is handed
 *   `delivered`, and **the schedule does not advance until that is called**: see below.
 * @returns stop asking. Called when the bytes come back, and on teardown.
 *
 * ⚠ **The step is spent by a frame, not by time passing.** A repaint request is not a frame:
 * MapLibre's `triggerRepaint` schedules through `requestAnimationFrame` and is a no-op while a
 * request is already outstanding, and a background tab runs no animation frames at all. A schedule
 * that armed the next wait from the timer alone would therefore spend its whole budget in a hidden
 * tab on a single frame that paints, once, on return — one re-ask where the ADR promises eleven, and
 * for a Reader who did nothing more unusual than look at another tab during an outage. So the next
 * wait is armed by `delivered`, and a step that never paints simply leaves the schedule parked with
 * nothing pending until it does.
 *
 * ⚠ **Armed when the notice goes up, never re-armed by the refusals it provokes.** Each nudge that
 * fails reports another refusal, so a caller that re-armed on every refusal would have built exactly
 * the unbounded loop this schedule exists to avoid. The caller therefore drives this off *whether*
 * something is missing and not off each refusal — one armed schedule per outage, and it runs out.
 */
export function keepAskingForMissingTiles(askAgain: (delivered: () => void) => void): () => void {
	let next = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const schedule = (): void => {
		const delay = TILE_RECOVERY_DELAYS[next];
		if (stopped || delay === undefined) return;
		next += 1;
		timer = setTimeout(() => {
			timer = undefined;
			// One advance per step however many times a caller reports a frame: a map that paints for
			// its own reasons must not shorten the budget.
			let spent = false;
			askAgain(() => {
				if (spent) return;
				spent = true;
				schedule();
			});
		}, delay);
	};

	schedule();

	return () => {
		stopped = true;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
}

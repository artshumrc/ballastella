/**
 * The app's dismissible messages, in one stack.
 *
 * Every message here was a line in the page's flow that nothing could put away: an outcome, a
 * refusal or a notice that pushed the work down the screen and stayed there for the rest of the
 * session. A daisyUI toast is `position: fixed`, so two of them are two stacks in the same corner
 * overlapping each other — which is why the messages are collected here and rendered once by
 * `ToastStack`, rather than each call site growing a toast of its own.
 *
 * ADR-0016 records that the toast is presentation only: the announcement is the live region's, and
 * `ToastStack` owns it. Nothing in this module decides wording.
 *
 * **Keyed by `testid`, one standing message per source.** A source states what it currently has to
 * say and this decides whether that is news, so a re-render cannot stack four copies of the same
 * sentence — and the id changes when the words do, which is what makes the stack re-announce.
 */

import { untrack } from 'svelte';

/** How much of the reader's attention the message is worth, in daisyUI's own vocabulary. */
export type ToastTone = 'info' | 'warning' | 'error';

export interface Toast {
	id: number;
	/** The name the line carried before it became a toast, so a spec still finds it by that name. */
	testid: string;
	text: string;
	tone: ToastTone;
	/**
	 * Whether this is a refusal, which is announced on insertion (`role="alert"`) rather than by the
	 * stack's polite region — ADR-0016's amendment, and the same split the lines themselves used.
	 */
	refusal: boolean;
}

class ToastStore {
	#items = $state<Toast[]>([]);
	#nextId = 1;

	get items(): readonly Toast[] {
		return this.#items;
	}

	/**
	 * State a source's current message. `''` withdraws whatever it last said.
	 *
	 * ⚠ **The list is read untracked, and that is load-bearing.** `Toast` calls this from an effect
	 * over its own text; deciding whether the message is news means reading what is standing, and a
	 * tracked read there makes an effect that reads and writes the same state — which Svelte stops
	 * with `effect_update_depth_exceeded`, taking the whole screen with it.
	 */
	post(message: Omit<Toast, 'id'>): void {
		untrack(() => {
			if (message.text === '') {
				this.#withdraw(message.testid);
				return;
			}
			const standing = this.#items.find((item) => item.testid === message.testid);
			if (standing?.text === message.text) return;
			// A new id even when one was standing: the stack keys on it, so the message is re-inserted
			// and therefore re-announced. Words that changed are news whether or not the old ones were
			// read.
			const posted = { ...message, id: this.#nextId++ };
			this.#items = [...this.#items.filter((item) => item.testid !== message.testid), posted];
		});
	}

	/** The source has nothing to say any more — the condition passed, or its screen went away. */
	withdraw(testid: string): void {
		untrack(() => this.#withdraw(testid));
	}

	/** The reader has read it. By id, so dismissing does not race a source posting something new. */
	dismiss(id: number): void {
		untrack(() => {
			this.#items = this.#items.filter((item) => item.id !== id);
		});
	}

	#withdraw(testid: string): void {
		if (!this.#items.some((item) => item.testid === testid)) return;
		this.#items = this.#items.filter((item) => item.testid !== testid);
	}
}

export const toasts = new ToastStore();

import { untrack } from 'svelte';

export type ToastTone = 'info' | 'warning' | 'error';

interface Toast {
	id: number;
	testid: string;
	text: string;
	tone: ToastTone;
	refusal: boolean;
}

class ToastStore {
	#items = $state<Toast[]>([]);
	#nextId = 1;

	get items(): readonly Toast[] {
		return this.#items;
	}

	post(message: Omit<Toast, 'id'>): void {
		untrack(() => {
			if (message.text === '') {
				this.#withdraw(message.testid);
				return;
			}
			const standing = this.#items.find((item) => item.testid === message.testid);
			if (standing?.text === message.text) return;
			const posted = { ...message, id: this.#nextId++ };
			this.#items = [...this.#items.filter((item) => item.testid !== message.testid), posted];
		});
	}

	withdraw(testid: string): void {
		untrack(() => this.#withdraw(testid));
	}

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

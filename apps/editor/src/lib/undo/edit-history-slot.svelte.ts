import type { EditHistory } from '@ballastella/core';

class EditHistorySlot {
	#owner = '';
	history = $state.raw<EditHistory | null>(null);

	show(owner: string, history: EditHistory): void {
		this.#owner = owner;
		this.history = history;
	}

	clear(owner: string): void {
		if (this.#owner !== owner) return;
		this.#owner = '';
		this.history = null;
	}
}

export const editHistorySlot = new EditHistorySlot();

import { messageOf } from '@ballastella/core';

export class Task {
	working = $state(false);
	problem = $state('');

	run = async (act: () => Promise<unknown>): Promise<void> => {
		this.problem = '';
		this.working = true;
		try {
			await act();
		} catch (cause) {
			this.problem = messageOf(cause);
		} finally {
			this.working = false;
		}
	};
}

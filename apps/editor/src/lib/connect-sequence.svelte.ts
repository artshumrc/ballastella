import { readItem, writeItem } from './browser-storage.js';

const RESUMING_KEY = 'ballastella.connect-sequence-resuming';
const ACCOUNT_KEY = 'ballastella.connect-sequence-account-known';
export const gitHubAccountKnown = (): boolean => readItem('sessionStorage', ACCOUNT_KEY) === 'yes';
export const rememberGitHubAccount = (): void => writeItem('sessionStorage', ACCOUNT_KEY, 'yes');

function resuming(): boolean {
	const held = readItem('sessionStorage', RESUMING_KEY) === 'yes';
	if (held) writeItem('sessionStorage', RESUMING_KEY, null);
	return held;
}

class ConnectSequence {
	open = $state(resuming());
	syncOpen = $state(false);
	signInRefusal = $state('');

	beginSignIn(
		storage: { beginGitHubSignIn(options: { installed: boolean }): string },
		installed: boolean
	): string {
		this.signInRefusal = '';
		writeItem('sessionStorage', RESUMING_KEY, 'yes');
		const problem = storage.beginGitHubSignIn({ installed });
		if (problem !== '') writeItem('sessionStorage', RESUMING_KEY, null);
		return problem;
	}
}

export const connectSequence = new ConnectSequence();

export const CREDENTIAL_KEY = 'ballastella.github-credential';

export interface CredentialStore {
	read(): string | null;
	write(token: string): void;
	clear(): void;
}

export interface CredentialStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function quietly<T>(act: () => T, fallback: T): T {
	try {
		return act();
	} catch {
		return fallback;
	}
}

export function webCredentialStore(
	storage: CredentialStorage,
	key = CREDENTIAL_KEY
): CredentialStore {
	return {
		read: () => quietly(() => storage.getItem(key) || null, null),
		write: (token) => quietly(() => storage.setItem(key, token), undefined),
		clear: () => quietly(() => storage.removeItem(key), undefined)
	};
}

export function memoryCredentialStore(): CredentialStore {
	let held: string | null = null;
	return {
		read: () => held,
		write: (token) => {
			held = token;
		},
		clear: () => {
			held = null;
		}
	};
}

// Probe with a read: opening a Project must not write to web storage (ADR-0010).
export function browserCredentialStore(): CredentialStore {
	try {
		if (typeof sessionStorage === 'undefined') return memoryCredentialStore();
		void sessionStorage.length;
		return webCredentialStore(sessionStorage);
	} catch {
		return memoryCredentialStore();
	}
}

export function closedWhileReviewing(
	reviewing: () => boolean,
	inner: CredentialStore
): CredentialStore {
	return {
		read: () => (reviewing() ? null : inner.read()),
		write: (token) => {
			if (!reviewing()) inner.write(token);
		},
		clear: () => {
			if (!reviewing()) inner.clear();
		}
	};
}

const MIN_CREDENTIAL_LENGTH = 20;

export function describeTokenProblem(pasted: string): string {
	const token = pasted.trim();
	if (token === '') {
		return (
			`Paste the token GitHub showed you when you created it. It is shown once, on the page that ` +
			`made it, and cannot be read back afterwards — if it has gone, make another one.`
		);
	}
	if (/\s/.test(token)) {
		return (
			`That does not look like a token: it has a space or a line break in it. A GitHub token is ` +
			`one unbroken run of letters, digits and underscores, so something else was copied along ` +
			`with it.`
		);
	}
	if (!/^[A-Za-z0-9_]+$/.test(token)) {
		return (
			`That does not look like a token. A GitHub token is made only of letters, digits and ` +
			`underscores, so a repository address or a URL is a different thing.`
		);
	}
	if (token.length < MIN_CREDENTIAL_LENGTH) {
		return (
			`That is too short to be a GitHub token — they are forty characters or more. Only part of ` +
			`it was copied; select the whole of it and paste again.`
		);
	}
	return '';
}

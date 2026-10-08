import { encodeBase64, textField, type Bytes, type StorePath } from '../store/project-store.js';
import {
	keysNamed,
	keysWithPrefix,
	parseWorkspaceScopedKey,
	removeAll,
	removeQuietly,
	workspaceNames,
	workspaceScopedKey
} from './workspace-scoped-key.js';

export const JOURNAL_FORMAT_VERSION = 1;
export const JOURNAL_KEY_PREFIX = 'ballastella.journal.';
export const HELD_KEY_PREFIX = 'ballastella.held.';
const HELD_COPIES_PER_PATH = 3;

const journalKey = (workspace: string, path: StorePath): string =>
	workspaceScopedKey(JOURNAL_KEY_PREFIX, workspace, path);

const heldKey = (workspace: string, path: StorePath, fingerprint: string): string =>
	workspaceScopedKey(HELD_KEY_PREFIX, workspace, `${fingerprint}/${path}`);

function parseHeldKey(
	key: string
): { workspace: string; path: StorePath; fingerprint: string } | null {
	const named = parseWorkspaceScopedKey(HELD_KEY_PREFIX, key);
	if (named === null) return null;
	const cut = named.subject.indexOf('/');
	if (cut === -1) return null;
	return {
		workspace: named.workspace,
		fingerprint: named.subject.slice(0, cut),
		path: named.subject.slice(cut + 1)
	};
}

function parseJournalKey(key: string): { workspace: string; path: StorePath } | null {
	const named = parseWorkspaceScopedKey(JOURNAL_KEY_PREFIX, key);
	return named === null ? null : { workspace: named.workspace, path: named.subject };
}

const journalAndHeldKeys = (storage: JournalStorage) => [
	...keysNamed(storage, JOURNAL_KEY_PREFIX, parseJournalKey),
	...keysNamed(storage, HELD_KEY_PREFIX, parseHeldKey)
];

export interface JournalStorage {
	readonly length: number;
	key(index: number): string | null;
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface StoreContentObserver {
	mark(): number;
	observe(path: StorePath, bytes: Bytes, at: number): void;
}

interface HeldCopy {
	readonly workspace: string;
	readonly path: StorePath;
	readonly bytes: Bytes;
	readonly at: string;
	readonly reason: string;
	readonly fingerprint: string;
}

abstract class JournalRefusal extends Error {
	constructor(
		message: string,
		readonly path: StorePath,
		readonly size: number,
		cause: unknown
	) {
		super(message, { cause });
	}
}

export class JournalFullError extends JournalRefusal {
	override readonly name = 'JournalFullError';
	constructor(path: StorePath, size: number, cause: unknown) {
		super(
			`Ballastella has run out of room to keep a copy of ${describeFile(path, size)} while ` +
				`it saves. Your edit is still being saved — what is missing is the spare copy that ` +
				`would survive closing this tab first. Wait for “Saved” before you leave this page.`,
			path,
			size,
			cause
		);
	}
}

export class JournalUnavailableError extends JournalRefusal {
	override readonly name = 'JournalUnavailableError';
	constructor(path: StorePath, size: number, cause: unknown) {
		super(
			`This browser will not let Ballastella keep a copy of ${describeFile(path, size)} while ` +
				`it saves — usually because site data is blocked, as it is in a private window. Your ` +
				`edit is still being saved; it is the spare copy that is unavailable. Wait for ` +
				`“Saved” before you leave this page.`,
			path,
			size,
			cause
		);
	}
}

function refusalFor(path: StorePath, size: number, cause: unknown): JournalRefusal {
	const name = cause instanceof Error ? cause.name : '';
	const code =
		typeof (cause as { code?: unknown })?.code === 'number' ? (cause as DOMException).code : 0;
	const full =
		name === 'QuotaExceededError' ||
		name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
		code === 22 ||
		code === 1014;
	return full
		? new JournalFullError(path, size, cause)
		: new JournalUnavailableError(path, size, cause);
}

function describeFile(path: StorePath, size: number): string {
	const segments = path.split('/');
	const name = segments[segments.length - 1] ?? path;
	const inside = segments.length > 1 ? ` in “${segments[0]}”` : '';
	return `“${name}”${inside} (${describeSize(size)})`;
}

export function describeSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} bytes`;
}

function storedField(storage: JournalStorage, key: string, field: 'bytes' | 'held'): string | null {
	try {
		const raw = storage.getItem(key);
		if (raw === null) return null;
		const value = (JSON.parse(raw) as Record<string, unknown>)[field];
		return typeof value === 'string' ? value : null;
	} catch {
		return null;
	}
}

export function fingerprintOf(bytes: Bytes): string {
	const round = (basis: number): string => {
		let hash = basis;
		for (const byte of bytes) {
			hash ^= byte;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, '0');
	};
	return `${bytes.length.toString(36)}-${round(0x811c9dc5)}${round(0x9dc5811c)}`;
}

export interface JournalEntry {
	readonly workspace: string;
	readonly path: StorePath;
	readonly bytes: Bytes;
	readonly at: string;
	readonly held: string | null;
}

export interface JournalProblem {
	readonly key: string;
	readonly reason: 'unreadable' | 'from-a-newer-version';
	readonly detail: string;
	readonly kept: boolean;
}

export class WriteAheadJournal {
	readonly #storage: JournalStorage;
	readonly #workspace: string;
	readonly #held = new Map<StorePath, string | null>();
	// When each baseline was observed, so a read that began earlier cannot overwrite a newer one.
	readonly #heldAt = new Map<StorePath, number>();
	#clock = 0;

	constructor(storage: JournalStorage, workspace: string) {
		this.#storage = storage;
		this.#workspace = workspace;
	}

	get workspace(): string {
		return this.#workspace;
	}

	record(path: StorePath, bytes: Bytes): void {
		const key = journalKey(this.#workspace, path);
		const encoded = encodeBase64(bytes);
		const held = this.#baseline(key, path);
		const value = JSON.stringify({
			formatVersion: JOURNAL_FORMAT_VERSION,
			at: new Date().toISOString(),
			...(held === null ? {} : { held }),
			bytes: encoded
		});
		try {
			this.#storage.setItem(key, value);
		} catch (cause) {
			if (storedField(this.#storage, key, 'bytes') === encoded) return;
			throw refusalFor(path, bytes.length, cause);
		}
	}

	#baseline(key: string, path: StorePath): string | null {
		const remembered = this.#held.get(path);
		if (remembered !== undefined) return remembered;
		const carried = storedField(this.#storage, key, 'held');
		this.#held.set(path, carried);
		return carried;
	}

	forget(path: StorePath): void {
		const key = journalKey(this.#workspace, path);
		const taken = storedField(this.#storage, key, 'bytes');
		const bytes = taken === null ? null : decodeBytes(taken);
		// Filing a fingerprint of zero bytes would say the store holds an empty file, which is a fact nobody established.
		if (bytes !== null) this.#remember(path, fingerprintOf(bytes));
		removeQuietly(this.#storage, key);
	}

	discard(path: StorePath): void {
		removeQuietly(this.#storage, journalKey(this.#workspace, path));
	}

	mark(): number {
		this.#clock += 1;
		return this.#clock;
	}

	observe(path: StorePath, bytes: Bytes, at: number): void {
		if (at <= (this.#heldAt.get(path) ?? 0)) return;
		this.#remember(path, fingerprintOf(bytes), at);
	}

	hold(path: StorePath, bytes: Bytes, at: string, reason: string): string | null {
		const fingerprint = fingerprintOf(bytes);
		const key = heldKey(this.#workspace, path, fingerprint);
		if (this.#storage.getItem(key) === null && this.#atCapacity(path)) return null;
		try {
			this.#storage.setItem(
				key,
				JSON.stringify({
					formatVersion: JOURNAL_FORMAT_VERSION,
					at,
					reason,
					bytes: encodeBase64(bytes)
				})
			);
		} catch {
			return null;
		}
		removeQuietly(this.#storage, journalKey(this.#workspace, path));
		return fingerprint;
	}

	#atCapacity(path: StorePath): boolean {
		const held = keysNamed(this.#storage, HELD_KEY_PREFIX, parseHeldKey).filter(
			(named) => named.workspace === this.#workspace && named.path === path
		);
		return held.length >= HELD_COPIES_PER_PATH;
	}

	#remember(path: StorePath, fingerprint: string, at?: number): void {
		this.#held.set(path, fingerprint);
		this.#heldAt.set(path, at ?? this.mark());
	}

	forgetUnder(prefix: string): number {
		for (const path of [...this.#held.keys()]) {
			if (!path.startsWith(prefix)) continue;
			this.#held.delete(path);
			this.#heldAt.delete(path);
		}
		return removeAll(
			this.#storage,
			journalAndHeldKeys(this.#storage).filter(
				(named) => named.workspace === this.#workspace && named.path.startsWith(prefix)
			)
		);
	}
}

const damaged = (storage: JournalStorage, key: string, copy: string, why: string) =>
	discard(
		storage,
		key,
		'unreadable',
		`${copy} ${why} and has been discarded. Nothing in your Workspace has been changed.`
	);

export function readJournal(
	storage: JournalStorage,
	workspace: string
): { readonly entries: readonly JournalEntry[]; readonly problems: readonly JournalProblem[] } {
	const entries: JournalEntry[] = [];
	const problems: JournalProblem[] = [];

	for (const key of keysWithPrefix(storage, JOURNAL_KEY_PREFIX)) {
		const named = parseJournalKey(key);
		if (named === null) {
			problems.push(discard(storage, key, 'unreadable', 'Its name could not be read.'));
			continue;
		}
		if (named.workspace !== workspace) continue;
		const raw = storage.getItem(key);
		if (raw === null) continue;
		const copy = `The saved copy of “${named.path}”`;
		let record: { formatVersion?: unknown; at?: unknown; bytes?: unknown; held?: unknown };
		try {
			record = JSON.parse(raw) as typeof record;
		} catch {
			problems.push(damaged(storage, key, copy, 'is damaged'));
			continue;
		}
		if (typeof record.formatVersion !== 'number' || !Number.isInteger(record.formatVersion)) {
			problems.push(damaged(storage, key, copy, 'does not say what version wrote it'));
			continue;
		}
		if (record.formatVersion > JOURNAL_FORMAT_VERSION) {
			problems.push({
				key,
				reason: 'from-a-newer-version',
				kept: true,
				detail:
					`An unsaved change to “${named.path}” was set aside by a newer version of ` +
					`Ballastella (format ${record.formatVersion}; this copy reads ` +
					`${JOURNAL_FORMAT_VERSION}). It has been left exactly as it is rather than ` +
					`restored. Update your copy of Ballastella to recover it.`
			});
			continue;
		}

		const bytes = typeof record.bytes === 'string' ? decodeBytes(record.bytes) : null;
		if (bytes === null) {
			problems.push(damaged(storage, key, copy, 'could not be decoded'));
			continue;
		}

		entries.push({
			workspace: named.workspace,
			path: named.path,
			bytes,
			at: textField(record.at),
			held: typeof record.held === 'string' && record.held !== '' ? record.held : null
		});
	}

	entries.sort((a, b) => a.path.localeCompare(b.path));
	problems.sort((a, b) => a.key.localeCompare(b.key));
	return { entries, problems };
}

export function readHeldCopies(
	storage: JournalStorage,
	workspace: string
): { readonly copies: readonly HeldCopy[]; readonly problems: readonly JournalProblem[] } {
	const copies: HeldCopy[] = [];
	const problems: JournalProblem[] = [];
	for (const named of keysNamed(storage, HELD_KEY_PREFIX, parseHeldKey)) {
		if (named.workspace !== workspace) continue;
		const raw = storage.getItem(named.key);
		if (raw === null) continue;
		const copy = `A kept copy of “${named.path}”`;
		let envelope: { bytes?: unknown; at?: unknown; reason?: unknown };
		try {
			envelope = JSON.parse(raw) as typeof envelope;
		} catch {
			problems.push(damaged(storage, named.key, copy, 'is damaged'));
			continue;
		}
		const bytes = typeof envelope.bytes === 'string' ? decodeBytes(envelope.bytes) : null;
		if (bytes === null) {
			problems.push(damaged(storage, named.key, copy, 'could not be decoded'));
			continue;
		}
		copies.push({
			workspace,
			path: named.path,
			bytes,
			at: textField(envelope.at),
			reason: textField(envelope.reason),
			fingerprint: named.fingerprint
		});
	}
	copies.sort((a, b) => a.path.localeCompare(b.path) || a.fingerprint.localeCompare(b.fingerprint));
	problems.sort((a, b) => a.key.localeCompare(b.key));
	return { copies, problems };
}

export function forgetHeldCopy(
	storage: JournalStorage,
	workspace: string,
	path: StorePath,
	fingerprint: string
): boolean {
	const key = heldKey(workspace, path, fingerprint);
	return storage.getItem(key) !== null && removeQuietly(storage, key);
}

export const journalledWorkspaces = (storage: JournalStorage): string[] =>
	workspaceNames(journalAndHeldKeys(storage));

export const discardJournal = (storage: JournalStorage, workspace: string): number =>
	removeAll(
		storage,
		journalAndHeldKeys(storage).filter((named) => named.workspace === workspace)
	);

export function browserJournalStorage(): JournalStorage | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		// Read, never write: Safari with cookies blocked throws from every property, and a write probe would cost quota.
		void localStorage.length;
		return localStorage;
	} catch {
		return null;
	}
}

const discard = (
	storage: JournalStorage,
	key: string,
	reason: JournalProblem['reason'],
	detail: string
): JournalProblem => ({ key, reason, detail, kept: !removeQuietly(storage, key) });

function decodeBytes(value: string): Bytes | null {
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length) as Bytes;
	for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at) & 0xff;
	return bytes;
}

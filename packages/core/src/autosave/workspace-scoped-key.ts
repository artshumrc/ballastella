// The key shape shared by everything this application keeps in `localStorage` per Workspace.
//
// Extracted rather than spelled twice (ticket 21). `journal.ts` had these three functions inline,
// and `deleted-projects.ts` needs exactly the same shape for exactly the same reason: two records
// keyed only by their subject would let an edit typed into "Marking 2026" be replayed into whichever
// Workspace happened to be open at the next startup, and a *deletion* performed in one Workspace be
// finished in another. A second hand-written copy of the encoding is a second thing that can drift
// from the first, and the failure it would produce — a key one module writes and the other cannot
// read — is silent.
//
// `encodeURIComponent` on both halves, and it is what makes the key unambiguous rather than merely
// tidy: a Workspace name is arbitrary user text in any script (`toWorkspaceName` keeps letters,
// marks, numbers, spaces, `(`, `)`, `_` and `-`), a store path contains `/`, and
// concatenating the two raw would let a Workspace called `a/b` and a Workspace called `a` holding
// `b/…` produce the same key. Encoding escapes `/` in both, so the single unescaped `/` is the only
// separator.

import type { JournalStorage } from './journal.js';

/** The key naming `subject` inside `workspace`, under `prefix`. */
export const workspaceScopedKey = (prefix: string, workspace: string, subject: string): string =>
	`${prefix}${encodeURIComponent(workspace)}/${encodeURIComponent(subject)}`;

/** The `{ workspace, subject }` a key names, or `null` if it is not one written under `prefix`. */
export function parseWorkspaceScopedKey(
	prefix: string,
	key: string
): { workspace: string; subject: string } | null {
	if (!key.startsWith(prefix)) return null;
	const body = key.slice(prefix.length);
	const cut = body.indexOf('/');
	if (cut === -1) return null;
	try {
		return {
			workspace: decodeURIComponent(body.slice(0, cut)),
			subject: decodeURIComponent(body.slice(cut + 1))
		};
	} catch {
		// A malformed `%` escape. Someone else's key under our prefix, or a truncated one; either way
		// it names no Workspace and no subject, so it is a problem to report rather than a record.
		return null;
	}
}

/** Every key currently in `storage` under `prefix`, snapshotted so removals cannot skip one. */
export function keysWithPrefix(storage: JournalStorage, prefix: string): string[] {
	const keys: string[] = [];
	for (let index = 0; index < storage.length; index += 1) {
		const key = storage.key(index);
		if (key !== null && key.startsWith(prefix)) keys.push(key);
	}
	return keys;
}

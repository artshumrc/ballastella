// The OPFS root as a place that holds **several named Workspaces**, rather than as one Workspace
// (ADR-0024's amendment to ADR-0001).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE ROOT STOPPED BEING A WORKSPACE
//
// ADR-0024 needs a Review Workspace: a named, throwaway Workspace holding one Project somebody sent,
// several of which may exist at once. With the root itself as the Workspace, each of those would be a
// **subdirectory of the user's own** — invisible in the Project list, because `listProjects` matches
// only top-level `<dir>/project.json`, but counted in its size and swept into its backup. So the
// containment has to be real, and this is where it is.
//
// It is also the smaller half of the change than it looks. `DirectoryHandleStore` takes a directory
// *resolver*, so a named Workspace is a resolver that opens one subdirectory of the root — the store
// itself does not change at all, which is why `OpfsProjectStore` still passes the shared adapter
// suite with no edit to the suite.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE NAME IS THE DIRECTORY, AS IT IS FOR A FOLDER WORKSPACE
//
// A folder Workspace's name is the folder's name; nothing is stored anywhere saying otherwise. A
// browser-managed one works the same way — the directory in the OPFS root *is* the Workspace and its
// name *is* the name — so there is no second record to keep in sync, nothing to migrate, and nothing
// that can disagree with the disk. {@link toWorkspaceName} is what makes a typed name usable as a
// directory name, and it is deliberately gentle: `Marking 2026` stays `Marking 2026`, because a bar
// that says "marking-2026" after the user typed "Marking 2026" has renamed their work without asking.
//
// The Project-level slug (`toDirectoryName`) is narrow because a Project directory is also a `?p=`
// query value and a path segment inside a Published Site. A Workspace directory is neither: it sits
// **above** the store root, so no store path ever contains it, and nothing published carries it.

import { OpfsProjectStore } from './opfs-project-store.js';

/**
 * The Workspace a first visit lands in.
 *
 * Named rather than blank because the navigation bar says which Workspace you are in on every screen
 * (SPEC story 88), and it has to say something true from the first frame. "Browser storage" was what
 * the bar said before this, which describes the *backing* and not the Workspace — and from ticket 14
 * onward a user can be inside a throwaway Review Workspace that is also browser-backed.
 */
export const DEFAULT_WORKSPACE_NAME = 'My Workspace';

/**
 * A typed name reduced to something that is one directory name on every filesystem.
 *
 * Conservative about characters and generous about shape. Letters, numbers, spaces, `(`, `)`, `_`
 * and `-` survive; everything else — `/` and `\` above all, but also the characters Windows refuses
 * in a filename and the control characters — is dropped, so the result cannot be a path, cannot
 * escape the root, and cannot be `.` or `..`. Runs of whitespace collapse and the ends are trimmed,
 * because a directory called `"Marking "` is one nobody can type again.
 *
 * **Parentheses survive because {@link createOpfsWorkspace} writes them**, and this function has to
 * be idempotent for that to work: it suffixes a taken name with ` (2)`, and a normalisation that
 * dropped the brackets would hand back `Marking 2` — a *different* name from the one it had just
 * checked was free, which is a uniqueness check that does not check the name it returns.
 *
 * A name that reduces to nothing gets {@link DEFAULT_WORKSPACE_NAME} rather than being refused: the
 * user asked for a Workspace, and a script this function cannot transliterate is not a reason to
 * decline to make one.
 */
export function toWorkspaceName(displayName: string): string {
	const cleaned = displayName
		.normalize('NFC')
		.replace(/[^\p{L}\p{N} ()_-]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 64)
		.trim();
	return cleaned === '' || cleaned === '.' || cleaned === '..' ? DEFAULT_WORKSPACE_NAME : cleaned;
}

/**
 * Two Workspace names compared the way a filesystem would.
 *
 * The same argument as `foldName` in `project/workspace.ts`, and the same failure if it is skipped:
 * APFS and NTFS are both case-insensitive and APFS folds Unicode composition as well, so
 * `getDirectoryHandle('Marking', { create: true })` hands back the existing `marking` on the backend
 * most users have. A uniqueness check comparing raw strings would let "Marking" open "marking" — and
 * for a Workspace that means one Workspace opened under two names, with the second one's Projects
 * appearing in the first.
 */
const fold = (name: string): string => name.normalize('NFC').toLowerCase();

/** The OPFS root, which is not itself a Workspace any more. */
const opfsRoot = (): Promise<FileSystemDirectoryHandle> => navigator.storage.getDirectory();

/**
 * Every named Workspace in browser-managed storage, in the order a person reads a list.
 *
 * There is no index file and nothing to keep in sync — the Workspaces *are* whatever directories are
 * in the OPFS root, which is the same argument ADR-0008 makes for Projects inside one. `sort` rather
 * than filesystem order, because `entries()` promises none and a switcher whose items move between
 * visits is one a user has to read every time.
 */
export async function listOpfsWorkspaces(): Promise<string[]> {
	const names: string[] = [];
	for await (const [name, handle] of (await opfsRoot()).entries()) {
		if (handle.kind === 'directory') names.push(name);
	}
	return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Make sure a named Workspace exists, and answer with its name.
 *
 * Called on the way in, so the Workspace the bar names is one that is really there — a directory the
 * store would otherwise only create at the first write, which would leave a brand new Workspace
 * absent from {@link listOpfsWorkspaces} until somebody typed into it.
 */
export async function ensureOpfsWorkspace(name: string): Promise<string> {
	const wanted = toWorkspaceName(name);
	await (await opfsRoot()).getDirectoryHandle(wanted, { create: true });
	return wanted;
}

/**
 * Create a Workspace under a name near `displayName`, and answer with the name it really got.
 *
 * Suffixed rather than refused when the name is taken, unlike a Project: a Workspace name is not an
 * identity anybody has been given a link to, and "Marking 2026 (2)" beside "Marking 2026" is exactly
 * what a teacher opening a second batch means. Refusing would be a dialog in the way of the one
 * gesture this feature is.
 */
export async function createOpfsWorkspace(displayName: string): Promise<string> {
	const preferred = toWorkspaceName(displayName);
	const taken = new Set((await listOpfsWorkspaces()).map(fold));
	// Each candidate is normalised before it is tested, so the name checked is the name created. See
	// the note on {@link toWorkspaceName}: a suffix the normaliser rewrites is a uniqueness check
	// answered about a different string from the one that ends up on disk.
	let name = preferred;
	for (let suffix = 2; taken.has(fold(name)); suffix += 1) {
		name = toWorkspaceName(`${preferred} (${suffix})`);
	}
	return ensureOpfsWorkspace(name);
}

/**
 * Delete a Workspace and everything in it.
 *
 * No confirmation and no size check here — both belong to the screen that asks, which names the
 * Workspace and what it weighs before it calls this (ADR-0016). What this owns is that the deletion
 * is real and recursive: a Workspace half deleted is one that still appears in the switcher and opens
 * onto part of somebody's work.
 */
export async function deleteOpfsWorkspace(name: string): Promise<void> {
	await (await opfsRoot()).removeEntry(name, { recursive: true });
}

/** Open one named Workspace as a store. The store itself knows nothing about the name. */
export const openOpfsWorkspace = (name: string): OpfsProjectStore => OpfsProjectStore.open(name);

/**
 * What the browser answered when asked to keep this origin's storage.
 *
 * Three states rather than two, because "this browser has no such API" is not a refusal and must not
 * be reported to the user as one.
 */
export type StoragePersistence = 'granted' | 'refused' | 'unsupported';

/**
 * Ask the browser to stop treating this origin's storage as evictable, and report what it said.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS IS A DATA-LOSS FIX, NOT A NICETY (ADR-0024)
 *
 * `navigator.storage.persist()` was called nowhere in this tree, so OPFS data was best-effort and
 * evictable under disk pressure. That was tolerable while browser storage was a starter store; it is
 * not, now that it is the primary home for a shared pool of gigabyte pyramids (ADR-0023) — and it is
 * where every user on Firefox, Safari, and iPadOS keeps everything they have, because File System
 * Access exists on none of them.
 *
 * **`persisted()` is asked first, and that is not an optimisation.** Firefox's `persist()` opens a
 * permission prompt; asking again on every load of an origin that already has the grant is the
 * nagging ADR-0012 rules out. Chromium grants or declines silently on its own heuristics — installing
 * the app is what usually turns it — so the answer is worth *recording* rather than acting on.
 *
 * The refusal is returned rather than swallowed because the user is entitled to know that the thing
 * holding all of their work is evictable, and what to do about it. Workspace settings says so.
 *
 * `storage` is injectable so the three answers can be asserted. A real browser cannot be made to
 * produce all three — Chromium decides on its own heuristics, and Firefox's `persist()` blocks on a
 * permission prompt that never appears with no user gesture — so a test against the real API can only
 * assert that *something* came back, which is the shape of assertion that passes when the function
 * has been deleted. The real call is exercised by the running app in `e2e/editor-workspace.e2e.ts`.
 */
export async function requestPersistentStorage(
	storage: StorageManager | undefined = typeof navigator === 'undefined'
		? undefined
		: navigator.storage
): Promise<StoragePersistence> {
	if (typeof storage?.persist !== 'function' || typeof storage?.persisted !== 'function') {
		return 'unsupported';
	}
	try {
		if (await storage.persisted()) return 'granted';
		return (await storage.persist()) ? 'granted' : 'refused';
	} catch {
		// A browser that has the methods and throws from them is one that cannot answer, which is what
		// `unsupported` means to every caller. Reporting it as a refusal would tell the user their
		// browser declined something it was never asked.
		return 'unsupported';
	}
}

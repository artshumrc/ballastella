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
 * The longest a Workspace name may be, in **code points**.
 *
 * 64 is well inside every filesystem's per-component limit once encoded, and long enough that no
 * plausible name meets it. It is a cap on a directory name, not on a sentence.
 */
export const MAX_WORKSPACE_NAME_LENGTH = 64;

/** The code points of a string, so slicing cannot cut a character in half. See {@link truncate}. */
const codePoints = (value: string): string[] => [...value];

/**
 * The first `limit` **code points**, never `limit` code units.
 *
 * ⚠ **`String#slice` is the wrong tool and the bug it caused is not theoretical.** It counts UTF-16
 * code units, so slicing at 64 through an astral character — a mathematical letter, an emoji, most
 * of Deseret and Gothic — leaves a **lone surrogate** at the end. That is not a character: it is
 * half of one, a name OPFS may refuse outright, and a string a second pass through
 * {@link toWorkspaceName} silently repairs into something *different*. That second fact is what
 * mattered, because {@link createOpfsWorkspace} relies on this function being idempotent.
 */
const truncate = (value: string, limit: number): string =>
	codePoints(value).slice(0, limit).join('');

/**
 * A typed name reduced to something that is one directory name on every filesystem.
 *
 * Conservative about characters and generous about shape. Letters, numbers, combining marks,
 * spaces, `(`, `)`, `_` and `-` survive; everything else — `/` and `\` above all, but also the
 * characters Windows refuses in a filename and the control characters — is dropped, so the result
 * cannot be a path, cannot escape the root, and cannot be `.` or `..`. Runs of whitespace collapse
 * and the ends are trimmed, because a directory called `"Marking "` is one nobody can type again.
 *
 * **Combining marks are kept** (`\p{M}`) because dropping them is not a safety property, it is
 * mangling somebody's language: NFC composes what it can, and a script whose marks have no composed
 * form — Devanagari, Thai, Arabic — would otherwise have every one of them replaced by a space.
 *
 * **Parentheses survive because {@link createOpfsWorkspace} writes them**, and this function has to
 * be idempotent for that to work: it suffixes a taken name with ` (2)`, and a normalisation that
 * dropped the brackets would hand back `Marking 2` — a *different* name from the one it had just
 * checked was free, which is a uniqueness check that does not check the name it returns.
 *
 * ⚠ **Idempotence is a contract here, not an observation**, and it is asserted in
 * `opfs-workspaces.test.ts` over specimens that have broken it: an astral character straddling the
 * length cap, and a name that is already exactly the cap.
 *
 * A name that reduces to nothing gets {@link DEFAULT_WORKSPACE_NAME} rather than being refused: the
 * user asked for a Workspace, and a script this function cannot transliterate is not a reason to
 * decline to make one.
 */
export function toWorkspaceName(displayName: string): string {
	const cleaned = truncate(
		displayName
			.normalize('NFC')
			.replace(/[^\p{L}\p{M}\p{N} ()_-]+/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
		MAX_WORKSPACE_NAME_LENGTH
	).trim();
	return cleaned === '' || cleaned === '.' || cleaned === '..' ? DEFAULT_WORKSPACE_NAME : cleaned;
}

/**
 * `preferred` with ` (n)` on the end, **shortening the stem to make room** rather than losing it.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 * │ THE TAB-FREEZING BUG THIS EXISTS TO END.                                                   │
 * └───────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * The obvious spelling is `toWorkspaceName(`${preferred} (${suffix})`)`. When `preferred` is already
 * at the length cap, the normaliser truncates the suffix straight back off and hands back
 * `preferred` — **unchanged**. The candidate is therefore taken, on every iteration, for every
 * value of `suffix`, and `createOpfsWorkspace`'s loop spins on the main thread for ever. A user
 * typing a long name twice froze the tab.
 *
 * So the marker is reserved first and the stem is cut to fit. Every suffix then yields a distinct
 * name, which is what makes the search terminate, and the name a user gets is recognisably the one
 * they typed rather than a truncation with no number on it.
 */
function suffixedWorkspaceName(preferred: string, suffix: number): string {
	const marker = ` (${suffix})`;
	const room = MAX_WORKSPACE_NAME_LENGTH - codePoints(marker).length;
	// `room` is only ever small for an absurd suffix; one code point of stem still distinguishes.
	const stem = truncate(preferred, Math.max(1, room)).trim();
	return toWorkspaceName(`${stem || DEFAULT_WORKSPACE_NAME}${marker}`);
}

/**
 * How many suffixes are tried before the request is refused.
 *
 * Bounded on purpose. {@link suffixedWorkspaceName} guarantees each candidate differs, so this is
 * not what makes the loop terminate — it is what makes a *future* change to that function unable to
 * hang the tab again. A thousand Workspaces sharing one name is a condition to report, not one to
 * keep searching through.
 */
const SUFFIX_ATTEMPTS = 1000;

/** A Workspace could not be given a free name near the one that was asked for. */
export class WorkspaceNameExhaustedError extends Error {
	constructor(preferred: string) {
		super(
			`There are already too many Workspaces called “${preferred}” to make another one. ` +
				`Rename or delete some of them, or choose a different name. Nothing has been created.`
		);
		this.name = 'WorkspaceNameExhaustedError';
	}
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
	if (!taken.has(fold(preferred))) return ensureOpfsWorkspace(preferred);
	// Each candidate is already normalised, so the name checked is the name created. See the note on
	// {@link toWorkspaceName}: a suffix the normaliser rewrites is a uniqueness check answered about
	// a different string from the one that ends up on disk — and, when the rewrite is a no-op, a loop
	// that never advances.
	for (let suffix = 2; suffix <= SUFFIX_ATTEMPTS; suffix += 1) {
		const candidate = suffixedWorkspaceName(preferred, suffix);
		if (!taken.has(fold(candidate))) return ensureOpfsWorkspace(candidate);
	}
	throw new WorkspaceNameExhaustedError(preferred);
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

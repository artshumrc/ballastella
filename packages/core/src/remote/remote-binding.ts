// Which repository a Workspace belongs to: the binding, and nothing else (ADR-0032, ADR-0033).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE BINDING IS A FILE IN THE WORKSPACE
//
// `review.json`'s precedent, for a related reason: a fact *about this Workspace* belongs inside the
// Workspace, so it travels with the directory wherever the directory goes — to a second browser
// profile, into a folder on disk, and, uniquely here, back out of the Remote. A binding kept in
// `localStorage` would be a fact about this browser, and a Clone would have to be told its own Remote
// by whoever cloned it.
//
// It is *inside* the published tree deliberately, which is the one thing that separates it from the
// review mark. The binding never changes, so it causes no churn on the Remote; and because it is
// published, a Clone reads its own Remote out of the files it just downloaded.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// UNREADABLE MEANS UNBOUND, WHICH IS THE OPPOSITE DIRECTION FROM THE REVIEW MARK
//
// `readReviewMark` answers "review" for a file it cannot read, because the failure to avoid there is
// an afternoon's work done in a Workspace built to be thrown away. Here the safe direction is the
// other one: the worst outcome of a mangled `remote.json` is a Publish button aimed at an address
// nobody has checked, and the cost of answering "unbound" is that the user binds again. So every
// failure — absent, unreachable, not JSON, missing an owner — comes back `null`, and nothing on this
// path throws at startup.

import { assertNotReviewing, readReviewMark } from '../project/review-workspace.js';
import type {
	Bytes,
	ProjectStore,
	ReadOnlyProjectStore,
	StorePath
} from '../store/project-store.js';

/**
 * Where the binding lives, relative to the Workspace root.
 *
 * A top-level *file*, so it cannot collide with a Project: `listProjects` matches only
 * `<directory>/project.json` (ADR-0008), and `toDirectoryName` turns any name a user could type into
 * a slug with no `.` in it, so no Project directory can ever be called this.
 */
export const REMOTE_BINDING_PATH = 'remote.json' as StorePath;

/**
 * The format version of the binding itself.
 *
 * Separate from a Project's `formatVersion` and, like the review mark's, deliberately not checked
 * against the future: a binding from a newer build still names a repository, and refusing to read it
 * would leave a scholar unbound on the machine that can still publish.
 */
export const REMOTE_BINDING_FORMAT_VERSION = 1;

/** The one branch Ballastella publishes to. One branch, one commit per publish. */
export const DEFAULT_REMOTE_BRANCH = 'main';

/**
 * GitHub's own rule for an account name and for a repository name: letters, digits and `-_.`, with
 * an owner allowing no dot.
 *
 * ⚠ **Checked rather than trusted, on both the address a user pastes and the binding read back off
 * disk**, because both go straight into a URL path. One pair of patterns for the two readers, so
 * they cannot come to disagree about what a repository may be called.
 */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * A repository name, with the two path segments that are not names refused.
 *
 * ⚠ **`.` and `..` match {@link REPOSITORY_PATTERN} exactly**, and both are interpolated straight
 * into a URL path: `ada/..` normalises to `api.github.com/repos/ada`, an endpoint about a *user*,
 * and on the raw host it climbs out of the repository altogether. `encodeURIComponent` is no defence
 * — it leaves `.` alone and `fetch` resolves the traversal afterwards, which is the trap the note on
 * {@link parseRemoteBinding} records.
 *
 * The two exact strings, rather than the character: real repositories are called `.github` and
 * `foo.js`, and banning the dot would refuse them.
 */
export const isRepositoryName = (value: string): boolean =>
	REPOSITORY_PATTERN.test(value) && value !== '.' && value !== '..';

/**
 * An account name, by {@link OWNER_PATTERN}.
 *
 * Exported beside {@link isRepositoryName} so that every reader of an address — the bind's parse
 * here, and the candidates an opened Remote's address produces — asks one pair of questions rather
 * than keeping its own copy of GitHub's rules.
 */
export const isOwnerName = (value: string): boolean => OWNER_PATTERN.test(value);

/**
 * `{ owner, repository, branch }` out of untrusted members, or `null` when they are not a repository.
 *
 * ⚠ **The one place the character sets are applied to a record read back out of storage**, so that
 * every reader of a persisted repository identity — the binding document, the installation-local
 * relationship, a Baseline offered as evidence — agrees about what a repository may be called. Two
 * readers with their own copies of the rules are two readers that can come to disagree, and the
 * disagreement is silent: one of them interpolates `ada/..` into an API path.
 *
 * An absent or empty branch normalises to {@link DEFAULT_REMOTE_BRANCH}, for the reason
 * {@link parseRemoteBinding} gives — a record written before anybody thought about branches names
 * the branch Ballastella publishes to.
 */
export function normaliseRemoteIdentity(record: {
	readonly owner?: unknown;
	readonly repository?: unknown;
	readonly branch?: unknown;
}): { owner: string; repository: string; branch: string } | null {
	const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
	const owner = text(record.owner);
	const repository = text(record.repository);
	if (!isOwnerName(owner) || !isRepositoryName(repository)) return null;
	return { owner, repository, branch: text(record.branch) || DEFAULT_REMOTE_BRANCH };
}

/** Which repository this Workspace is published to. */
export interface RemoteBinding {
	readonly formatVersion: number;
	readonly owner: string;
	readonly repository: string;
	readonly branch: string;
}

export function serialiseRemoteBinding(binding: RemoteBinding): Bytes {
	return new TextEncoder().encode(`${JSON.stringify(binding, null, '\t')}\n`) as Bytes;
}

/**
 * Read a binding's bytes, or `null` when they are not a binding this build can act on.
 *
 * A document naming no owner or no repository is `null` rather than a half-binding: everything
 * downstream builds a URL out of both, and `https://api.github.com/repos//maps` is a request nobody
 * meant to make. Unknown members are carried nowhere — the document holds four things by contract,
 * and a Publish rewrites it from this build's model only when the user binds again.
 *
 * ⚠ **The owner and the repository are checked against GitHub's own character sets, exactly as
 * {@link parseRemoteReference} checks what a user typed, and this is the *less* trusted of the two
 * inputs.** It is a file on disk — one a restored Backup, a colleague's folder, or a `remote.json`
 * downloaded out of somebody else's published tree can put there — and both fields are
 * interpolated straight into an API path by the publish engine. An owner of `ada/../../orgs` or a
 * repository of `atlas?x=1` would retarget every request the engine makes. `encodeURIComponent` at
 * the interpolation is **not** the fix and must not be mistaken for one: it leaves `.` alone, so
 * `..` survives it and `fetch` normalises the traversal away afterwards. Checked here instead, so
 * the binding is safe by construction wherever it is interpolated.
 */
export function parseRemoteBinding(bytes: Bytes): RemoteBinding | null {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return null;
	}
	if (typeof raw !== 'object' || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const identity = normaliseRemoteIdentity(record);
	if (identity === null) return null;
	const formatVersion = record['formatVersion'];
	return {
		formatVersion:
			typeof formatVersion === 'number' ? formatVersion : REMOTE_BINDING_FORMAT_VERSION,
		...identity
	};
}

/**
 * The Remote this Workspace is bound to, or `null` when it is bound to nothing.
 *
 * Never throws. See this module's header for why unreadable means unbound here and means the
 * opposite in `readReviewMark`.
 */
export async function readRemoteBinding(
	store: ReadOnlyProjectStore
): Promise<RemoteBinding | null> {
	// Every failure is the same answer, including {@link PathNotFoundError}: an absent binding and an
	// unreachable Workspace are both "do not offer to publish", and the app reports an unreachable
	// Workspace in its own words elsewhere (ADR-0008) rather than through this.
	const bytes = await store.read(REMOTE_BINDING_PATH).catch(() => null);
	return bytes === null ? null : parseRemoteBinding(bytes);
}

/**
 * Bind a Workspace to a repository, refusing a Review Workspace.
 *
 * ⚠ **The refusal is here rather than only in the menu that offers it** (ADR-0024).
 * Publishing somebody else's Project to your own address is promotion by another route and a worse
 * one, and a guard that lives in markup is one route away from being absent — a Clone, a restored
 * Backup, and a future URL parameter all reach a store without passing a menu.
 *
 * @throws ReviewWorkspaceError when the Workspace is a review copy
 */
export async function writeRemoteBinding(
	store: ProjectStore,
	workspaceName: string,
	binding: RemoteBinding
): Promise<void> {
	assertNotReviewing(workspaceName, await readReviewMark(store), 'bound to a repository on GitHub');
	await store.write(REMOTE_BINDING_PATH, serialiseRemoteBinding(binding));
}

/**
 * Unbind a Workspace.
 *
 * Idempotent, because `ProjectStore.delete` is. The Remote itself is untouched: unbinding is this
 * machine forgetting where it published, never a deletion of anybody's site.
 */
export async function clearRemoteBinding(store: ProjectStore): Promise<void> {
	await store.delete(REMOTE_BINDING_PATH);
}

/** `owner/repository`, which is how GitHub itself names a repository and how the bar shows it. */
export function describeRemote(binding: {
	readonly owner: string;
	readonly repository: string;
}): string {
	return `${binding.owner}/${binding.repository}`;
}

/**
 * `owner/repository` out of whatever the user pasted, or `null` when it is neither.
 *
 * A repository's address is the thing a scholar copies out of their browser's URL bar, so the whole
 * `https://github.com/owner/repository` is accepted alongside the short form — refusing it would be
 * refusing the likeliest paste. Nothing deeper is taken: a URL naming a file inside a repository is
 * not a repository, and silently truncating one to its first two segments would bind a Workspace to
 * something the user did not name.
 */
export function parseRemoteReference(
	pasted: string
): { readonly owner: string; readonly repository: string } | null {
	const trimmed = pasted
		.trim()
		.replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
		// The trailing slash first: a clone URL is `…/atlas.git`, and stripping the suffix before the
		// slash leaves `atlas.git` behind for anybody who copied the address with one on the end.
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '');
	const segments = trimmed.split('/');
	if (segments.length !== 2) return null;
	const [owner, repository] = segments;
	if (owner === undefined || !isOwnerName(owner)) return null;
	if (repository === undefined || !isRepositoryName(repository)) return null;
	return { owner, repository };
}

/**
 * What makes two repository references **the same Remote**, as one comparable string.
 *
 * ⚠ **The owner and the repository fold case and the branch does not.** GitHub treats an account and
 * a repository name case-insensitively — `Ada/Atlas` and `ada/atlas` are one repository and one
 * Published Site — while git refs are byte-compared, so `main` and `Main` are two branches and a
 * Workspace synchronized with one has no relationship with the other.
 *
 * ⚠ **The one rule, asked rather than restated.** An Open selects an existing Workspace by it and an
 * Import refuses its own Remote by it; two spellings of "the same repository" would let an Import be
 * refused as a duplicate of a Workspace no Open would ever have reused, or worse, the other way
 * round.
 *
 * An absent or empty branch is {@link DEFAULT_REMOTE_BRANCH}, exactly as
 * {@link normaliseRemoteIdentity} reads one.
 */
export const remoteIdentityKey = (remote: {
	readonly owner: string;
	readonly repository: string;
	readonly branch?: string;
}): string =>
	`${remote.owner.toLowerCase()}/${remote.repository.toLowerCase()}#${remote.branch || DEFAULT_REMOTE_BRANCH}`;

/** Whether two references name one repository and one branch. {@link remoteIdentityKey}'s rule. */
export const isSameRemote = (
	one: { readonly owner: string; readonly repository: string; readonly branch?: string },
	other: { readonly owner: string; readonly repository: string; readonly branch?: string }
): boolean => remoteIdentityKey(one) === remoteIdentityKey(other);

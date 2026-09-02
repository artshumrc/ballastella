// Which repository a Workspace belongs to: what a reference is, and what makes two of them the same.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RELATIONSHIP IS INSTALLATION-LOCAL, SO THIS MODULE HOLDS NO DOCUMENT
//
// A Workspace's Remote is kept by the installation that synchronizes with it (ADR-0044), and
// nothing writes a second copy into the tree: a file in the Workspace saying which repository it
// belongs to is a claim that can disagree with the one the installation acts on, and it travels —
// into a Backup, into a fork, into a colleague's folder — where it would let a repository nobody
// chose claim a Workspace. What a Published Site needs to name its own repository it carries in its
// own record (`ballastella-site.json`), which publishing writes and which says nothing about any
// Workspace.
//
// So what is left here are the rules every reader of a repository reference has to agree about, in
// one place: the character sets GitHub itself enforces, the shape a reference has, and the
// comparison that decides whether two of them are one repository.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CHARACTER SETS ARE CHECKED, NEVER TRUSTED
//
// Both fields are interpolated straight into an API path by the synchronization engine. An owner of
// `ada/../../orgs` or a repository of `atlas?x=1` would retarget every request it makes, and
// `encodeURIComponent` at the interpolation is **not** the fix: it leaves `.` alone, so `..`
// survives it and `fetch` normalises the traversal away afterwards. Checked here instead, so a
// reference is safe by construction wherever it is interpolated.

/** The one branch Ballastella publishes to. One branch, one commit per publish. */
export const DEFAULT_REMOTE_BRANCH = 'main';

/**
 * GitHub's own rule for an account name and for a repository name: letters, digits and `-_.`, with
 * an owner allowing no dot.
 *
 * ⚠ **Checked rather than trusted, on the address a user pastes and on every record read back out
 * of storage**, because both go straight into a URL path. One pair of patterns for every reader, so
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
 * — it leaves `.` alone and `fetch` resolves the traversal afterwards, which is the trap this
 * module's header records.
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
 * every reader of a persisted repository identity — the installation-local relationship, a Baseline
 * offered as evidence, a Published Site's own record — agrees about what a repository may be called.
 * Two readers with their own copies of the rules are two readers that can come to disagree, and the
 * disagreement is silent: one of them interpolates `ada/..` into an API path.
 *
 * An absent or empty branch normalises to {@link DEFAULT_REMOTE_BRANCH}: a record written before
 * anybody thought about branch names means the branch Ballastella synchronizes with.
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

/** `owner/repository`, which is how GitHub itself names a repository and how the bar shows it. */
export function describeRemote(remote: {
	readonly owner: string;
	readonly repository: string;
}): string {
	return `${remote.owner}/${remote.repository}`;
}

/**
 * `owner/repository` out of whatever the user pasted, or `null` when it is neither.
 *
 * A repository's address is the thing a scholar copies out of their browser's URL bar, so the whole
 * `https://github.com/owner/repository` is accepted alongside the short form — refusing it would be
 * refusing the likeliest paste. Nothing deeper is taken: a URL naming a file inside a repository is
 * not a repository, and silently truncating one to its first two segments would connect a Workspace
 * to something the user did not name.
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

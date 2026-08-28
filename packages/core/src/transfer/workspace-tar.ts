// What a Workspace backup *is*, shared by the writer and the reader (ADR-0024).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY TAR, AND WHY THE MEASUREMENT IS A TEST RATHER THAN A SENTENCE
//
// ADR-0024 moves whole-Workspace transfer off zip for two reasons, and both were, when it was
// written, quoted from `modern-tar`'s README. Neither may be built on unverified, so
// `tar-format.test.ts` measures them and this module is downstream of that file rather than of the
// README. What it measured, at `modern-tar` 0.8.2:
//
//   - **It streams, in both directions, with backpressure**, and that is asserted in bytes moved
//     through a stream rather than in bytes a garbage collector has got round to freeing. Holding one
//     entry's body unread stalls the producer 9.00 MiB into a 64 MiB entry, so the decoder does not
//     buffer whole entries; an unread packer sink stalls its writer around 7.94 MiB; and across a
//     whole archive the producer never runs more than ~9 MiB ahead of a slow consumer, whatever the
//     archive's size. This is the property a zip cannot have at all — a zip is unreadable without the
//     central directory at its end — and it is what makes restoring a large backup on an iPad
//     possible.
//
//     ⚠ This comment used to claim "2.80 MiB of peak heap growth" over a 512 MiB round trip. **That
//     figure measured nothing** — a typed array's payload is external memory and never appears in
//     `heapUsed`, so the same bound passed for a consumer holding the entire archive. Do not
//     reintroduce a memory-figure assertion without reading the note in `tar-format.test.ts` first:
//     three instruments were tried and all three gave an answer that could not be trusted.
//   - **Paths past tar's 100-byte `name` field survive exactly**, by USTAR `prefix` up to 256 bytes
//     and by a PAX `path` record beyond it, including Devanagari, CJK, Arabic and emoji. That is
//     load-bearing twice over here: `<project-dir-up-to-64>/annotations/<uuid>.geojson` is already
//     121 bytes before the Workspace name is prepended, and the Workspace name is **user data** —
//     `toWorkspaceName` keeps Devanagari, Thai and Arabic combining marks intact, and a backup that
//     mangled one would undo that care at the one moment the user is trusting the tool with
//     everything they have.
//
// A third thing fell out of the measurement that ADR-0024 does not claim and that is worth having:
// **a truncated tar throws.** Every cut this was tried at raised `Tar archive is truncated.` rather
// than yielding a short archive. The whole reason the zip is going is that the zip reader read a
// 70,000-entry archive back as 4,464 files with no error at all, so a format that refuses to be
// silently short is not a nice-to-have; it is the requirement, and it is now asserted.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ARCHIVE IS ROOTED AT A DIRECTORY NAMED AFTER THE WORKSPACE
//
// Every entry is `<workspace-name>/<store-path>`, and the archive opens with the directory entry
// for `<workspace-name>/` itself. Three things follow, and each is a requirement rather than a
// convenience:
//
//   - **The Workspace's name travels with its contents.** A Project bundle deliberately does *not*
//     carry its own directory name — ADR-0024's Project-level archive is rooted at `project.json`
//     so the importer chooses the name and a collision is a question for the user. A Workspace
//     backup is the opposite case: restore creates a **new** Workspace, so there is nothing to
//     collide with, and the name is the one piece of the user's work that has nowhere else to live.
//     It is not in any file: the directory name *is* the name (ADR-0008), precisely so there would
//     be no second record to disagree with the disk.
//   - **`tar xf backup.tar` produces a folder named after the Workspace**, on a computer with no
//     browser involved. For the Firefox, Safari and iPad users this whole path exists for, the
//     archive is the only copy of their work that is not inside a browser they cannot see into
//     (ADR-0001), and an archive that explodes fifty loose files into the current directory is a
//     worse artefact than one that does not.
//   - **The long-path behaviour is exercised by every real backup rather than by a test fixture.**
//     The Workspace name is a prefix on every path in the archive, so a 64-code-point name pushes
//     an ordinary annotation path to nearly 190 bytes. The measurement is not a corner case here;
//     it is the common case.
//
// The empty-Workspace case is why the directory entry is written even though nothing reads
// directory entries back: a Workspace with no files would otherwise be an archive with no entries,
// carrying no name, and restoring it could only guess.

import { MAX_WORKSPACE_NAME_LENGTH, toWorkspaceName } from '../store/opfs-workspaces.js';
import { isTempPath } from '../store/project-store.js';

/**
 * Every entry's modification time, and a constant rather than the clock.
 *
 * The same two reasons `ZIP_ENTRY_MTIME` gives, and both apply here.
 * It makes a backup **byte-reproducible** — the same Workspace twice, and a Workspace that has been
 * through a restore, produce identical archives — which is what lets the round-trip test assert
 * *lossless* rather than merely *plausible*. And it refuses to imply that an archive carries useful
 * times: a Project's `updatedAt` lives inside `project.json` precisely because archiving destroys
 * filesystem times (ADR-0008).
 *
 * ⚠ **Constructed from UTC, where the zip's constant is constructed from local fields, and the
 * difference is not cosmetic.** A zip stores a DOS timestamp with no zone, so building it from local
 * fields is what makes a Project archived in Boston and one archived in Amsterdam identical. Tar stores
 * **seconds since the Unix epoch**, which *is* absolute — so the local-field spelling that makes a
 * zip reproducible would make a tar differ by the exporter's UTC offset, and two scholars backing up
 * the same shared Workspace would get archives that are not the same bytes. `tar-format.test.ts`
 * asserts that a constant `mtime` reproduces and that leaving it to the clock does not, so the
 * property is checked rather than assumed; the zone correctness is why the constant is spelled this
 * way and not the other.
 *
 * 1980 rather than the epoch for no format reason — tar can represent either — but because a
 * timestamp of exactly zero reads to most tools as *absent* rather than as *deliberate*, and this
 * one is deliberate.
 */
export const TAR_ENTRY_MTIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0, 0));

/** What a backup file is called, given the Workspace's name. */
export const backupFileName = (workspaceName: string): string => `${workspaceName}.tar`;

/** The MIME type a backup is offered under. */
export const BACKUP_MEDIA_TYPE = 'application/x-tar';

/**
 * The archive path an entry gets, given the Workspace's name and the entry's store path.
 *
 * One function rather than two string templates, because the writer and the reader have to agree
 * exactly and this is the whole of the agreement.
 */
export const archivePathFor = (workspaceName: string, storePath: string): string =>
	`${workspaceName}/${storePath}`;

/** The directory entry the archive opens with, which is what carries the name. */
export const workspaceDirectoryEntry = (workspaceName: string): string => `${workspaceName}/`;

/**
 * The PAX key carrying the Workspace's name **as the user has it**, when that is not a legal
 * Workspace directory name.
 *
 * A folder Workspace's name is the operating system's folder name, which has never been through
 * {@link toWorkspaceName}: `Dave's maps`, `maps, 1625`, a name over 64 code points, an NFD `Café
 * Notes`. The archive's root directory must be the normalised form or restore refuses it — see
 * `exportWorkspaceTar` for the bug that caused — so this is where the original goes instead of being
 * dropped.
 *
 * **Prefixed and dotted the way PAX vendor keys are**, so it can never collide with a standard record
 * (`path`, `size`, `mtime`, …) that a future `modern-tar` or another tool might act on. `tar` ignores
 * unknown keys entirely, so an archive carrying this is an ordinary tar everywhere else.
 *
 * ⚠ **Untrusted.** It is a string out of a file somebody else made. It is only ever used as the
 * *preferred* name handed to whoever creates the destination Workspace, and that caller normalises it
 * — `createOpfsWorkspace` runs {@link toWorkspaceName} — so it cannot become a path. See
 * {@link backupDisplayName}, which bounds it before it goes anywhere.
 */
export const BACKUP_DISPLAY_NAME_RECORD = 'BALLASTELLA.workspace';

/**
 * The original Workspace name a backup carries, or `null` if it carries none worth using.
 *
 * Bounded rather than trusted. A display name is a folder name: it is not a path, holds no control
 * characters, and is not a megabyte of text. Anything else is dropped and the archive's own directory
 * name is used instead, which is always legal — so a hostile or damaged record degrades to the
 * behaviour we would have had without the record at all, rather than to a refusal.
 */
export function backupDisplayName(pax: Record<string, string> | undefined): string | null {
	const value = pax?.[BACKUP_DISPLAY_NAME_RECORD];
	if (typeof value !== 'string' || value === '') return null;
	if (value.includes('/') || value.includes('\\')) return null;
	// eslint-disable-next-line no-control-regex -- a control character in a name is not a name
	if (/[\u0000-\u001f\u007f]/.test(value)) return null;
	// Generous: four times the Workspace-name cap, since this is a name the user already has on disk
	// somewhere and the cap is ours rather than the filesystem's.
	if ([...value].length > MAX_WORKSPACE_NAME_LENGTH * 4) return null;
	return value;
}

/**
 * The longest a path inside a backup may be, in UTF-8 bytes.
 *
 * Not a tar limit — PAX has none worth naming — but a bound on what a stranger's archive may ask the
 * store to write, in the same spirit as `PROJECT_ZIP_LIMITS`. A Workspace name is at most 64 code
 * points, a Project directory at most 64 ASCII characters, and the deepest real path under those is
 * an annotation or a tile; 1,024 bytes leaves several times the room any of them need.
 */
export const MAX_BACKUP_PATH_BYTES = 1024;

/** Why a backup will not be read. Each one is refused with nothing left behind. */
export type BackupRejection =
	/** The bytes are not a tar archive, or the archive is damaged or truncated. */
	| 'not-a-tar'
	/** The archive does not open with a single Workspace directory. */
	| 'no-workspace-directory'
	/** An entry would be written outside the Workspace being restored into. */
	| 'path-traversal'
	/** The archive declares, or turns out to hold, more than a Workspace is allowed to. */
	| 'too-large'
	/** There is not enough room in the browser's storage to restore this. */
	| 'insufficient-quota';

/**
 * A backup that will not be restored, with a message for the person holding it.
 *
 * Separate from {@link ProjectFormatTooNewError}, which restore lets through untouched for the same
 * reason the zip importer does: ADR-0010's refusal already names the remedy, and it is the same
 * sentence the user sees when the same Project sits in their own Workspace.
 */
export class BackupRejectedError extends Error {
	readonly reason: BackupRejection;

	constructor(reason: BackupRejection, message: string) {
		super(`${message} Nothing has been restored.`);
		this.name = 'BackupRejectedError';
		this.reason = reason;
	}
}

/**
 * Refuse an entry name that is not a plain relative path inside the Workspace.
 *
 * The same list the zip importer checks, and checked here for the same reason it is checked there
 * rather than left to the store: the store refuses most of these too, but only at the moment of
 * writing — by which point earlier entries are already on disk.
 *
 * **The stakes are higher on this path than on the zip's**, which is why it is not merely copied but
 * stated. A Project bundle is rooted inside one Project directory, so an escaping entry lands elsewhere
 * in the Workspace. A Workspace backup is rooted at the Workspace, so an escaping entry lands
 * elsewhere in the **OPFS root** — which holds *every other Workspace the user has* (ADR-0008),
 * including the one they are restoring in order to recover from damage to. On a folder-backed
 * Workspace it lands somewhere in a folder the user granted for one purpose.
 *
 * @throws BackupRejectedError
 */
export function assertSafeBackupPath(name: string): void {
	const reject = (why: string): never => {
		throw new BackupRejectedError(
			'path-traversal',
			`This backup contains an entry that would not stay inside the Workspace: “${name}” ${why}.`
		);
	};

	if (name === '') reject('has no name');
	if (name.startsWith('/')) reject('is an absolute path');
	if (/^[A-Za-z]:/.test(name)) reject('is an absolute path with a drive letter');
	if (name.includes('\\')) reject('uses a backslash as a separator');
	// eslint-disable-next-line no-control-regex -- a control character in a filename is not a filename
	if (/[\u0000-\u001f\u007f]/.test(name)) reject('contains a control character');
	if (new TextEncoder().encode(name).length > MAX_BACKUP_PATH_BYTES) {
		reject(`is longer than the ${MAX_BACKUP_PATH_BYTES} bytes any path in a Workspace needs`);
	}

	const segments = name.split('/');
	// A tar records a directory as an entry whose name ends in `/`, so its final empty segment is
	// legitimate. Any other empty segment is a `//` in the path.
	const named = segments.at(-1) === '' ? segments.slice(0, -1) : segments;
	for (const segment of named) {
		if (segment === '..') reject('climbs out of the Workspace');
		if (segment === '.') reject('contains a “.” segment');
		if (segment === '') reject('contains an empty path segment');
	}
	// The store's reserved suffix, for the reason the zip importer gives: the suffix marks a path
	// `list` hides, so an entry claiming one is asking to put a file in the Workspace that nothing
	// there can see — which no honest backup has any reason to do, since export reads through `list`
	// and could not have produced one.
	if (isTempPath(name)) reject('uses the name Ballastella reserves for its own unfinished writes');
}

/**
 * The Workspace name a backup's leading directory entry carries, or `null` if it is not one.
 *
 * **Normalised through {@link toWorkspaceName} on the way out**, and the round trip through it has to
 * be a no-op or the archive is refused. That check is the point rather than a formality: the
 * normaliser is idempotent by contract (`opfs-workspaces.test.ts` asserts it), so a name that changes
 * under it is a name our own exporter could not have written — someone has hand-built the archive, or
 * a filesystem has folded the name — and restoring under a *different* name than the archive says is
 * precisely the silent mangling {@link toWorkspaceName} exists to prevent.
 */
export function backupWorkspaceName(entryName: string): string | null {
	if (!entryName.endsWith('/')) return null;
	const name = entryName.slice(0, -1);
	if (name === '' || name.includes('/')) return null;
	if ([...name].length > MAX_WORKSPACE_NAME_LENGTH) return null;
	return toWorkspaceName(name) === name ? name : null;
}

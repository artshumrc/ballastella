// What a **handoff bundle** is, shared by the writer and the reader (ADR-0024).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A BUNDLE IS ONE PROJECT, AND IT OPENS ONLY INTO A REVIEW WORKSPACE
//
// ADR-0024 splits transfer into two artefacts that were one file format and served neither purpose
// well. A **backup** is the whole Workspace, restored into a new Workspace of its own
// (`workspace-tar.ts`). A **bundle** is one Project, self-contained: `project.json`, its
// `annotations/`, and the `images/<id>/` and `alignments/<id>.json` its Layers reference.
//
// **The archive's shape is the zip's, unchanged, and that is deliberate.** Entries are
// Project-relative — `project.json` at the root, never under a directory named after the Project —
// so a Project's identity stays its directory name (ADR-0008) and the *reader* chooses that name
// rather than inheriting one from a stranger's archive. The shared material keeps the
// Workspace-rooted paths it has always occupied, so `hoistedImageId` performs the same split on the
// way in that it always has and `assertReferencesPresent` works on the same path set.
//
// **What did change is what it may be opened *as*.** A bundle carries `alignments/<image-id>.json`,
// and under ADR-0023 there is exactly one Alignment per Map Image in a Workspace, so a bundle's
// contents can never be laid straight over an existing Workspace's shared pool. Two readings follow
// from that, and the format serves both:
//
//   - **Review** opens the bundle into a marked, throwaway Workspace holding exactly that one
//     Project, several of which may exist at once. See `project/review-workspace.ts` for the mark and
//     `open-project-bundle.ts` for the reading.
//   - **Import** copies the Project into the ordinary Workspace the user already has open (ADR-0037),
//     giving every incoming Map Image a *fresh* identity so nothing of theirs is overwritten. Its
//     read-only half is `project-bundle-source.ts`; the writable Workspace belongs to the Import
//     engine, on the far side of that boundary.
//
// ⚠ **The collision is avoided by representation rather than by prohibition, and the difference
// matters here.** Nothing may write a stranger's `alignments/<id>.json` over the user's own; what
// Import does instead is make the incoming map a distinct Map Image with an Alignment of its own. It
// is worth stating where the format is defined, because the archive's Workspace-rooted shared paths
// are what would otherwise make a straight copy look easy.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A TAR AND NOT A ZIP, ON THIS PATH TOO
//
// The whole-Workspace path moved first (`workspace-tar.ts`), and the arguments are the same here with
// one addition. The zip writer counted entries in a sixteen-bit field: 70,000 entries produced an
// archive whose index claimed 4,464, and `unzipSync` read back 4,464 files **with no error at all**.
// The zip exporter refused above 65,535 files so that never shipped — and a single 2 GB pyramid runs
// to tens of thousands of files, so a Project with two large archival scans was refused *by the
// export path a student uses to hand their work in*.
//
// Tar has no central directory and no entry count, so the ceiling does not exist; it is streamable in
// both directions, so a large bundle can be read on an iPad; and a truncated tar **throws** rather
// than coming back plausibly short, which is measured in `tar-format.test.ts` at every cut it was
// tried at. That last property is the one this path most needed: a handoff is a file that has
// travelled, and a download that stopped half way is its likeliest damage.

import { toWorkspaceName } from '../store/opfs-workspaces.js';
import { isTempPath } from '../store/project-store.js';

/**
 * What a bundle file is called, given the Project's directory name.
 *
 * **Distinguishable from a backup at a glance and in a file picker**, which is why it is not simply
 * `<directory>.tar`. The two artefacts are opened by different buttons, into different places, with
 * different consequences, and a Downloads folder holding `marking-2026.tar` beside
 * `amsterdam-1625.tar` gives a user no way to tell which is which — on the one path where picking
 * wrong means opening somebody's whole Workspace expecting one Project.
 *
 * Both are ordinary tars and `tar xf` reads either; the suffix is for the person, not for the parser.
 */
export const bundleFileName = (directory: string): string => `${directory}.project.tar`;

/** The MIME type a bundle is offered under. An ordinary tar, because that is what it is. */
export const BUNDLE_MEDIA_TYPE = 'application/x-tar';

/**
 * The name to open a bundle's Review Workspace under, taken from the file the user picked.
 *
 * The archive deliberately does not carry a Workspace name — it is one Project, and a Project's
 * archive has never carried its own directory name. But the Review Workspace has to be *called*
 * something before `project.json` has been read, because it is created first and the mark written
 * into it before a single Project byte lands (see `open-project-bundle.ts` for why that order). The
 * file's own name is what the user recognises at that moment, and it is replaced by the Project's
 * display name as soon as the manifest has been parsed.
 *
 * Untrusted, like any filename: it goes through {@link toWorkspaceName}, which cannot produce a path.
 */
export function bundleWorkspaceName(fileName: string): string {
	const stem = fileName.replace(/\.project\.tar$/i, '').replace(/\.tar$/i, '');
	return toWorkspaceName(stem);
}

/**
 * The longest a path inside a bundle may be, in UTF-8 bytes.
 *
 * The same bound and the same argument as `MAX_BACKUP_PATH_BYTES`: not a tar limit — PAX has none
 * worth naming — but a bound on what a stranger's archive may ask the store to write. A bundle's
 * paths are Project-relative and therefore *shorter* than a backup's by the Workspace name, so this
 * is generous several times over.
 */
export const MAX_BUNDLE_PATH_BYTES = 1024;

/** Why a bundle will not be opened. Each one leaves no Review Workspace behind. */
export type BundleRejection =
	/** The bytes are not a tar archive, or the archive is damaged or truncated. */
	| 'not-a-tar'
	/** No `project.json` at the root of the archive, so this is not a Project bundle. */
	| 'no-project-file'
	/** An entry would be written outside the Review Workspace. */
	| 'path-traversal'
	/** The archive declares, or turns out to hold, more than one Project is allowed to. */
	| 'too-large'
	/** `project.json` names a file, or an image directory needs one, that is not in the archive. */
	| 'missing-reference'
	/** The archive carries `project.json` twice, so which Project it holds cannot be decided. */
	| 'duplicate-manifest'
	/** There is not enough room in the browser's storage to open this. */
	| 'insufficient-quota';

/**
 * A bundle that will not be opened, with a message for the person who was handed it.
 *
 * Separate from `ProjectFormatTooNewError`, which the reader lets through untouched for the
 * reason both other transfer paths do: ADR-0010's refusal already names the remedy, and it is the
 * same sentence the user sees when the same Project sits in their own Workspace.
 */
export class BundleRejectedError extends Error {
	readonly reason: BundleRejection;

	constructor(reason: BundleRejection, message: string) {
		super(`${message} Nothing has been opened.`);
		this.name = 'BundleRejectedError';
		this.reason = reason;
	}
}

/**
 * Refuse an entry name that is not a plain relative path inside the Project.
 *
 * The same list the backup reader checks, and checked here for the same reason: the store refuses
 * most of these too, but only at the moment of writing — by which point earlier entries are on disk.
 *
 * **The stakes are lower here than on either other path, and the check is kept anyway.** A bundle is
 * written into a Review Workspace created seconds ago, so an escaping entry lands inside a directory
 * that is about to be thrown away — unless it climbs out of the Workspace altogether, which is the
 * case this exists for: the OPFS root holds *every* Workspace the user has (ADR-0008), and on a
 * folder-backed one it is a folder granted for one purpose. A bundle is the artefact most likely to
 * have come from a stranger, so it gets the strictest reading rather than the most relaxed.
 *
 * @throws BundleRejectedError
 */
export function assertSafeBundlePath(name: string): void {
	const reject = (why: string): never => {
		throw new BundleRejectedError(
			'path-traversal',
			`This bundle contains an entry that would not stay inside the Project: “${name}” ${why}.`
		);
	};

	if (name === '') reject('has no name');
	if (name.startsWith('/')) reject('is an absolute path');
	if (/^[A-Za-z]:/.test(name)) reject('is an absolute path with a drive letter');
	if (name.includes('\\')) reject('uses a backslash as a separator');
	// eslint-disable-next-line no-control-regex -- a control character in a filename is not a filename
	if (/[\u0000-\u001f\u007f]/.test(name)) reject('contains a control character');
	if (new TextEncoder().encode(name).length > MAX_BUNDLE_PATH_BYTES) {
		reject(`is longer than the ${MAX_BUNDLE_PATH_BYTES} bytes any path in a Project needs`);
	}

	const segments = name.split('/');
	// A tar records a directory as an entry whose name ends in `/`, so its final empty segment is
	// legitimate. Any other empty segment is a `//` in the path.
	const named = segments.at(-1) === '' ? segments.slice(0, -1) : segments;
	for (const segment of named) {
		if (segment === '..') reject('climbs out of the Project');
		if (segment === '.') reject('contains a “.” segment');
		if (segment === '') reject('contains an empty path segment');
	}
	// The store's reserved suffix, for the reason the other two readers give: the suffix marks a path
	// `list` hides, so an entry claiming one is asking to put a file in the Workspace that nothing
	// there can see — which no honest bundle has any reason to do, since export reads through `list`
	// and could not have produced one.
	if (isTempPath(name)) reject('uses the name Ballastella reserves for its own unfinished writes');
}

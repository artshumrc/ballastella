import { createTarDecoder } from 'modern-tar';

import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import { writeAlignmentBytes } from '../alignment/alignment-file.js';
import {
	BALLASTELLA_CANONICAL_URL,
	PROJECT_FILE_NAME,
	ProjectFormatTooNewError,
	parseProjectFile
} from '../project/project-file.js';
import { describeBytes } from '../project/workspace-size.js';
import { REMOTE_BINDING_PATH } from '../remote/remote-binding.js';
import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';
import type { TransferProgressListener } from './transfer.js';
import {
	assertSafeBackupPath,
	BackupRejectedError,
	backupDisplayName,
	backupWorkspaceName
} from './workspace-tar.js';

/**
 * The Workspace a restore writes into, and the way to throw it away again.
 *
 * **Restore never overwrites and never merges** (ADR-0024), so it does not take a store: it takes the
 * means of *making* one. Both real uses need that. A new computer has nothing to overwrite; and
 * recovering from damage is the exact moment the damaged Workspace has to survive, because a user
 * cannot know what the backup predates until they have looked at both. Merging would be the
 * Alignment-collision problem in another hat — under ADR-0023 there is exactly one Alignment per
 * Historical Map in a Workspace, so merging a backup either overwrites an Alignment that several of
 * the user's own Projects are drawn by, or refuses.
 *
 * `discard` is what makes "nothing has been restored" true rather than aspirational. Because the
 * destination is brand new, throwing it away costs the user nothing — which is a luxury the zip
 * importer did not have, and why its rollback had to enumerate the files it had written.
 */
export interface RestoreDestination {
	/**
	 * The name the Workspace really got.
	 *
	 * Not necessarily the one the backup carries: the user may already have a Workspace by that name —
	 * restoring the same backup twice to compare them is a thing people do — and ticket 12 suffixes
	 * rather than refusing.
	 */
	readonly name: string;
	readonly store: ProjectStore;
	/** Throw the whole Workspace away, with everything restore has written into it. */
	discard(): Promise<void>;
}

/** Make a Workspace for a restore to write into, near the name the backup carries. */
export type OpenRestoreDestination = (preferredName: string) => Promise<RestoreDestination>;

/**
 * What the browser will say about its storage, or `null` when it will not say.
 *
 * A function rather than a direct `navigator.storage.estimate()` call, because `packages/core` has to
 * stay Node-safe — the barrel is imported by both apps' root layouts and a value-import of anything
 * browser-only breaks prerender — and because a quota refusal that cannot be provoked in a test is a
 * quota refusal nobody has ever seen work.
 */
export type EstimateStorage = () => Promise<{ quota?: number; usage?: number } | null>;

export interface RestoreWorkspaceTarOptions {
	readonly onProgress?: TransferProgressListener;
	/**
	 * How many bytes the archive is, known before it is opened.
	 *
	 * Required for the quota check, and available for free: the user picked a `File`, and `File.size`
	 * is its length. See {@link restoreWorkspaceTar} for why this number is an honest bound on what
	 * will be written, which is a property a zip does not have.
	 */
	readonly archiveBytes?: number;
	readonly estimateStorage?: EstimateStorage;
}

export interface WorkspaceRestore {
	/** The name the new Workspace got, which the caller now has to switch to. */
	readonly workspaceName: string;
	/**
	 * The Workspace's name as the backup carried it, which may differ from the above if it was taken.
	 *
	 * The user's own name for it: the PAX record when the archive has one, and the archive's root
	 * directory otherwise. For a folder Workspace those differ — `Dave's maps` is not a legal
	 * Workspace directory name — and this is the one a person recognises.
	 */
	readonly backupName: string;
	/**
	 * The archive's actual root directory, which is always a legal Workspace name.
	 *
	 * Separate from {@link backupName} rather than folded into it, because they are different facts:
	 * this one is what `tar xf` produces and what the restore fence checked, and that one is what the
	 * user calls it. Collapsing them is how a caller ends up showing a normalised name as though the
	 * user had typed it.
	 */
	readonly backupDirectoryName: string;
	/** How many files were **written**. Never how many the archive held — see {@link declined}. */
	readonly totalFiles: number;
	readonly totalBytes: number;
	/** The Project directories that now list on the hub. */
	readonly projects: readonly string[];
	/**
	 * Paths the archive carried that were deliberately **not** written, and are not counted above.
	 *
	 * Empty for every restore into a new Workspace, which is every restore today. It is not empty for
	 * a destination that already holds an Alignment for a Historical Map the backup also has, because
	 * ADR-0023 makes the one already there the safe one to keep. Reported rather than swallowed: a
	 * transfer that says it delivered more than it did is the failure this format change escaped.
	 */
	readonly declined: readonly string[];
	/**
	 * What the user has to be told, in the words they should see.
	 *
	 * Not a boolean flag for the UI to phrase, because ADR-0006's staleness warning and story 111's
	 * "visible text rather than tooltips" are both about the *sentence*, and a flag is how two screens
	 * end up saying different things about the same fact.
	 */
	readonly notice: string;
}

/**
 * How many `project.json` files a backup may hold, and how large each may be.
 *
 * These are buffered rather than streamed to disk — see {@link restoreWorkspaceTar} — so unlike every
 * other file in the archive they are a memory cost that scales with the archive's *claims*. A
 * Workspace with a thousand Projects is not a Workspace; a `project.json` of a megabyte is not a
 * manifest. Both are generous by a wide margin and exist so that a hostile archive cannot turn "write
 * the manifests last" into "hold a gigabyte of JSON".
 */
const MAX_PROJECTS = 1000;
const MAX_PROJECT_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Read a Workspace backup into a **new** Workspace, streaming.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * **THE ORDER OF OPERATIONS IS THE DESIGN, BECAUSE A TAR CANNOT BE VALIDATED FIRST**
 *
 * The zip importer validated the entire archive before writing a byte, and it can, because a zip has
 * a central directory at its end listing everything in it. Reading that index is also exactly why a
 * zip cannot be streamed, and why a ~400 MB backup could not be restored on an iPad at all — half of
 * what tar was chosen for (ADR-0024).
 *
 * So a streaming restore cannot have "validate everything, then write". What it has instead:
 *
 * 1. **Quota is checked before anything is opened**, against the archive's own byte length. That
 *    works here and would not work for a zip: nothing in a tar is compressed, so the file's size *is*
 *    a close upper bound on what it unpacks to, and there is no deflate-bomb class to bound. Refused
 *    beforehand with the numbers, rather than discovered at eighty per cent.
 * 2. **The destination is created only after the archive's first entry has been read**, because that
 *    entry is the directory carrying the Workspace's name. An archive that does not open with one is
 *    refused before a Workspace has been made at all.
 * 3. **Every entry is checked as it arrives** — inside the Workspace's own directory, no traversal,
 *    no reserved name — and written straight through. This is the streaming part, and it is why peak
 *    memory is one file rather than one archive.
 * 4. **`project.json` files are held back and written last**, per the zip importer's discipline. The
 *    Workspace's list of Projects *is* whichever directories hold a `project.json` (ADR-0008), so an
 *    interrupted restore leaves a directory of orphaned files rather than a Project that lists on the
 *    hub and opens with half its Layers missing. The first is litter; the second reads as the tool
 *    having eaten somebody's work.
 * 5. **Each is parsed as it is held back**, so ADR-0010's refusal of a `formatVersion` from the future
 *    happens while the only thing at stake is a Workspace nobody has seen yet.
 * 6. **Anything that fails at any point discards the whole destination.** That is what makes the
 *    refusals' closing sentence true. It is available because the destination is new — see
 *    {@link RestoreDestination}.
 *
 * ⚠ **What this does not do, stated rather than implied.** Nothing here detects a concurrent edit.
 * Ticket 18 deliberately left that open and ADR-0023 accepts it: a colleague's change arriving through
 * a synced Workspace between a read and a write is lost, and the mitigation is visibility rather than
 * prevention. A backup and restore is exactly the place somebody might assume that gap is covered, so:
 * it is not. Restoring is not a merge, does not compare timestamps, and does not know whether the
 * backup is older or newer than anything. It makes a second Workspace and puts the archive's contents
 * in it; deciding which of the two is the good one is the user's, which is the whole reason the old
 * one is left alone.
 *
 * @throws BackupRejectedError for anything wrong with the archive or with the room to hold it
 * @throws ProjectFormatTooNewError for a Project from a newer version of the app (ADR-0010)
 */
export async function restoreWorkspaceTar(
	archive: ReadableStream<Uint8Array>,
	open: OpenRestoreDestination,
	options: RestoreWorkspaceTarOptions = {}
): Promise<WorkspaceRestore> {
	await assertRoomToRestore(options);

	const entries = archive.pipeThrough(createTarDecoder({ strict: true }));
	const reader = entries.getReader();

	let destination: RestoreDestination | null = null;
	try {
		const first = await readEntry(reader);
		if (first.done) {
			// `no-workspace-directory` rather than `not-a-tar`, because it *is* a tar: two zero blocks
			// is a well-formed archive holding nothing. Saying "this is not a tar" about a file that
			// parsed perfectly sends the user off to check the wrong thing.
			throw new BackupRejectedError(
				'no-workspace-directory',
				'This is a valid archive, but it holds nothing at all — not even the folder a ' +
					'Ballastella backup names its Workspace with.'
			);
		}
		const backupName = backupWorkspaceName(first.value.header.name);
		// Drained whichever way this goes: an unread body stalls the decoder, and the refusal below
		// would then be reported from a stream nobody had finished with.
		await first.value.body.cancel();
		if (backupName === null) {
			throw new BackupRejectedError(
				'no-workspace-directory',
				`A Ballastella backup begins with the folder it is a backup of, and this one begins with ` +
					`“${first.value.header.name}”. If it came from another program, or was repacked, ` +
					`restore cannot tell what Workspace it holds.`
			);
		}

		// The name the user has for this Workspace, which for a folder-backed one is not a legal
		// Workspace directory name and therefore is not what the archive is rooted at. Whoever creates
		// the destination normalises it — `createOpfsWorkspace` does — so this is a *preference*, and
		// the archive's own directory name is the fallback because that one is always legal.
		const displayName = backupDisplayName(first.value.header.pax) ?? backupName;

		destination = await open(displayName);
		const outcome = await drainInto(destination.store, reader, backupName, options);

		return {
			workspaceName: destination.name,
			backupName: displayName,
			backupDirectoryName: backupName,
			totalFiles: outcome.files,
			totalBytes: outcome.bytes,
			projects: outcome.projects,
			declined: outcome.declined,
			// ADR-0006: a restored Workspace is data, not a site. Said here rather than left for the
			// user to discover, because what they would otherwise discover is a Published Site that
			// still opens and quietly shows the work they had *before* the backup — or, for the Base
			// Map extract, a reader looking at a blank map with no explanation, which is exactly the
			// failure ticket 17 found the product had no notice for.
			notice:
				`Restored into a new Workspace called “${destination.name}”. Your other Workspaces have ` +
				`not been touched. A backup holds your work rather than a website, so publish this ` +
				`Workspace again to turn it back into one — and if you had made a Project available ` +
				`offline, make its offline copy again.` +
				// A restore that wrote less than the archive held **says so, in the same breath**. See
				// `drainInto` for why anything can be declined at all, and why reporting it is not
				// optional: an archive is somebody's work, and a transfer that quietly delivers less
				// than it was given is the exact failure this whole format change escaped.
				(outcome.declined.length === 0
					? ''
					: ` ${outcome.declined.length} ${
							outcome.declined.length === 1 ? 'Alignment' : 'Alignments'
						} in the backup ${outcome.declined.length === 1 ? 'was' : 'were'} not restored, ` +
						`because this Workspace already had one for the same Historical Map: ` +
						`${outcome.declined.join(', ')}.`)
		};
	} catch (cause) {
		// The refusal's closing sentence is "Nothing has been restored", and this is what makes it
		// true. A discard that itself fails must not replace the reason the restore was refused: the
		// user needs to know what was wrong with their backup far more than they need to know that
		// cleaning up after it also went badly.
		if (destination) await destination.discard().catch(() => undefined);
		await reader.cancel().catch(() => undefined);
		throw cause;
	}
}

/**
 * Refuse a restore there is no room for, **before the destination exists**.
 *
 * `navigator.storage.estimate()` reached through an injected function, so this is provokable in a
 * test rather than only in a browser with a full disk. Silent when the browser will not answer:
 * refusing a restore because the quota API is unavailable would refuse it on Safari, and a restore
 * that fails part way is still better than one that cannot be attempted. The numbers are named
 * because "not enough space" without them is a message a user cannot act on.
 */
async function assertRoomToRestore(options: RestoreWorkspaceTarOptions): Promise<void> {
	const { archiveBytes, estimateStorage } = options;
	if (archiveBytes === undefined || !estimateStorage) return;

	const estimate = await estimateStorage().catch(() => null);
	const quota = estimate?.quota;
	const usage = estimate?.usage;
	if (typeof quota !== 'number' || typeof usage !== 'number') return;

	const free = quota - usage;
	if (free >= archiveBytes) return;

	throw new BackupRejectedError(
		'insufficient-quota',
		`This backup needs about ${describeBytes(archiveBytes)} and there is ${describeBytes(
			Math.max(0, free)
		)} free — ${describeBytes(usage)} of the ${describeBytes(quota)} this browser allows is ` +
			`already in use. Delete a Workspace you no longer need, or free space on this device, and ` +
			`try again.`
	);
}

interface RestoreOutcome {
	readonly files: number;
	readonly bytes: number;
	readonly projects: readonly string[];
	readonly declined: readonly string[];
}

/**
 * Write the archive's entries into the new Workspace, manifests last.
 *
 * ⚠ **`files` and `bytes` count what was *written*, never what was *read*, and the difference is the
 * whole point.** An Alignment goes through ticket 18's one writer, which may decline it — see
 * {@link writeRestored} — and the first cut of this function incremented the counters regardless.
 * That made a restore report more than it had delivered: the archive's Alignment was dropped and
 * still counted. **A transfer that reports more than it wrote is the zip writer claiming 4,464 of
 * 70,000 with a different spelling** — which is the failure this entire format change exists to
 * escape. So a declined file is counted nowhere and named in {@link RestoreOutcome.declined}, and
 * the caller says so.
 *
 * ⚠ **`writeRestored`'s own decline is still unreached, and that is stated rather than implied.**
 * The claim here used to be that ticket 14's Review Workspaces reach it; they do not. A bundle goes
 * through `open-project-bundle.ts`, which has its own writer with its own decline — the *equivalent*
 * path in a different module. A restore destination is still always a brand-new Workspace, so
 * nothing on this path has an Alignment to refuse: what makes the counting correct here is that it
 * is written to be correct, not that a test has driven it. Duplicate entries in a *restore* archive
 * are the case that would reach it, and no test lays one down.
 */
async function drainInto(
	store: ProjectStore,
	reader: ReadableStreamDefaultReader<{
		header: { name: string; type?: string; pax?: Record<string, string> };
		body: ReadableStream<Uint8Array>;
	}>,
	backupName: string,
	options: RestoreWorkspaceTarOptions
): Promise<RestoreOutcome> {
	const prefix = `${backupName}/`;
	/** The manifests, held back until everything they name is on disk. Small and few by contract. */
	const manifests: { path: StorePath; bytes: Bytes }[] = [];
	/** Paths the archive carried that were not written, so the caller can say so. */
	const declined: string[] = [];

	let files = 0;
	let bytes = 0;
	// A tar declares no totals — it has no index — so progress is a count rather than a proportion.
	// Saying "412 files" is honest; inventing a denominator from the archive's byte length and the
	// average file size would not be.
	const report = (path: string | null): void =>
		options.onProgress?.({ files, totalFiles: files, bytes, totalBytes: bytes, path });

	report(null);

	for (;;) {
		const next = await readEntry(reader);
		if (next.done) break;
		const { header, body } = next.value;

		// A directory entry holds nothing. The store creates missing parents on write and an empty
		// directory holds no scholarship, so they are drained and dropped — including the Workspace's
		// own, which has already done its job by naming the archive.
		if (header.type === 'directory' || header.name.endsWith('/')) {
			await body.cancel();
			continue;
		}

		// Two checks, in this order, and deliberately **not** three.
		//
		// The fence first: an entry outside the folder the archive named is refused before anything
		// is derived from it. On ticket 12's OPFS root, "outside" means another Workspace of the
		// user's — including the damaged one they are restoring in order to recover from.
		if (!header.name.startsWith(prefix)) {
			throw new BackupRejectedError(
				'path-traversal',
				`This backup contains “${header.name}”, which is outside the “${backupName}” folder the ` +
					`archive says it is a backup of.`
			);
		}
		// Then the path that will actually be written, once the Workspace prefix has come off. This is
		// the *store's* path, and the store is what has to be protected.
		//
		// ⚠ **There used to be a third check here, on `header.name` before the prefix was stripped, and
		// the mandated mutation check is what removed it.** Deleting it left the entire suite green,
		// and no specimen could be constructed that only it would catch: the fence above rejects
		// anything outside the Workspace folder, and every traversal segment that survives the fence
		// survives the slice too, so the check below sees it. Its only distinct reach was the byte
		// bound applied to the archive path rather than the store path — a difference of at most the
		// Workspace name's own length. A guard that cannot be made to fire is worse than no guard,
		// because a reader counts it as protection; so it is gone rather than kept and excused.
		const path = header.name.slice(prefix.length) as StorePath;
		assertSafeBackupPath(path);

		// ⚠ **A restored Backup arrives unbound** (SPEC story 41, ADR-0032). `remote.json` is inside the
		// published tree, so a Backup taken from a bound Workspace carries it — and restoring it would
		// hand the user a Publish button aimed at a live, cited address, from a state they restored
		// precisely because something had gone wrong. Dropped on the way *in* rather than left out of
		// the Backup: the Backup is a faithful copy of the Workspace, and it is the arrival that has to
		// be safe. Not counted and not reported as declined — `declined` is about work that was in the
		// archive and is not in the Workspace, and this is neither.
		if (path === REMOTE_BINDING_PATH) {
			await body.cancel();
			continue;
		}

		const content = await collect(body);

		if (isProjectManifest(path)) {
			if (manifests.length >= MAX_PROJECTS) {
				throw new BackupRejectedError(
					'too-large',
					`This backup holds more than ${MAX_PROJECTS} Projects, which is more than a Workspace ` +
						`is. It has not been read further.`
				);
			}
			if (content.length > MAX_PROJECT_FILE_BYTES) {
				throw new BackupRejectedError(
					'too-large',
					`“${path}” in this backup is ${describeBytes(content.length)}, and a ` +
						`${PROJECT_FILE_NAME} is a short manifest rather than a document of that size.`
				);
			}
			// Parsed *now*, while the only thing at stake is a Workspace nobody has seen. ADR-0010's
			// refusal has to land before the manifests are written, or a Project from a newer version of
			// the app would list on the hub of a Workspace this build then could not open.
			readManifest(content);
			manifests.push({ path, bytes: content });
			continue;
		}

		if ((await writeRestored(store, path, content)) === 'declined') {
			declined.push(path);
			report(path);
			continue;
		}
		files += 1;
		bytes += content.length;
		report(path);
	}

	// Last, and only now. Everything each one names is already on disk, so the moment a Project
	// appears on the hub is the moment it is whole.
	//
	// A manifest is never an Alignment, so `writeRestored` cannot decline one — but it is called
	// through the same function rather than around it, so there is only ever one way a restored byte
	// reaches the store, and the counting below cannot drift from the loop above.
	for (const manifest of manifests) {
		if ((await writeRestored(store, manifest.path, manifest.bytes)) === 'declined') {
			declined.push(manifest.path);
			continue;
		}
		files += 1;
		bytes += manifest.bytes.length;
		report(manifest.path);
	}
	report(null);

	return {
		files,
		bytes,
		// Only the Projects that really landed. A manifest counted here but not on disk would put a
		// Project on the hub of the caller's report that is not on the hub of the Workspace.
		projects: manifests
			.map((manifest) => manifest.path)
			.filter((path) => !declined.includes(path))
			.map((path) => path.slice(0, -PROJECT_FILE_NAME.length - 1)),
		declined
	};
}

/**
 * Whether a Workspace-relative path is a Project's manifest — `<directory>/project.json` and nothing
 * else.
 *
 * Exactly the shape `listProjects` matches (ADR-0008), because "what makes a Project appear on the
 * hub" is the only question the write-last rule is about. A `project.json` deeper in the tree is an
 * ordinary file with an unlucky name and is written with the rest.
 */
function isProjectManifest(path: string): boolean {
	const segments = path.split('/');
	return segments.length === 2 && segments[1] === PROJECT_FILE_NAME;
}

/**
 * Parse a manifest, re-ending ADR-0010's refusal for this path.
 *
 * The same class and the same `formatVersion`, so everything catching it still does; only the closing
 * sentence changes, from a promise about a local Project — which does not exist here — to the one
 * every other refusal on this path makes. The same treatment the zip importer gave it, and the same
 * reason: a restored backup is a likely way a Project from a newer version reaches an older build.
 */
function readManifest(bytes: Bytes): void {
	try {
		parseProjectFile(bytes);
	} catch (cause) {
		if (cause instanceof ProjectFormatTooNewError) {
			throw new ProjectFormatTooNewError(
				cause.formatVersion,
				BALLASTELLA_CANONICAL_URL,
				'Nothing has been restored.'
			);
		}
		throw cause;
	}
}

/**
 * Write one restored file, sending an Alignment through the one writer (ticket 18, ADR-0023).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * **WHY THIS IS ROUTED RATHER THAN WRITTEN DIRECTLY, WHEN IT PROVABLY CANNOT COLLIDE**
 *
 * Ticket 18 made `alignment-file.ts` the only writer of `alignments/<image-id>.json`, behind two
 * layers: `alignmentPath` returns a branded `AlignmentPath` that `ProjectStore.write` refuses, and
 * `scripts/check-alignment-writers.mjs` covers the spellings a type cannot see.
 *
 * **Restore walks through both of them, and it is worth being exact about how**, because the first
 * draft of this module did walk through and nothing failed. The path here is `header.name` with a
 * prefix sliced off — a value the compiler only ever sees as `string` — so the brand never applies;
 * that is the limit 18 states about itself rather than claims away. And the script did not flag it
 * either: it looks for the `alignments/` spelling, and this code never spells it, because the path
 * arrives as data out of somebody's archive.
 *
 * **The collision this is guarding cannot happen here**, and that is not the reason to skip it. The
 * destination is a Workspace created moments ago by `restoreWorkspaceTar`; it is empty by
 * construction, so there is no Alignment to overwrite and no other Project drawn by one. Routing
 * through `writeAlignmentBytes` with `intent: 'create'` therefore always writes, and costs one
 * failed `read` per Alignment.
 *
 * It is routed anyway, for the reason 18's own remediation gives: the danger is not this call site
 * today, it is that "restore writes Alignments with the generic writer" is a *true statement about
 * the codebase* that the next person reads as permission. The zip importer had a third existence
 * check sitting unnoticed for exactly that reason. Cheap, and it keeps the sentence "every Alignment
 * write goes through `alignment-file.ts`" true without an asterisk.
 *
 * The bytes go through verbatim — `writeAlignmentBytes`, not `writeAlignmentFile` — because what is
 * being restored is a document some build wrote, and re-serialising it from this build's model is
 * the loss SPEC story 60 forbids.
 *
 * ⚠ **The outcome is returned, not swallowed, and swallowing it was a real defect.** `intent: 'create'`
 * means *write only if there is nothing there worth keeping*, so `writeAlignmentBytes` can answer
 * `'kept over the offer'` — the archive's Alignment is deliberately not written, which is the safe
 * direction ADR-0023 requires. The first cut of this function returned `void` and the caller counted
 * the file as restored anyway, so a restore could report delivering a file it had dropped. Nothing
 * today can reach it, because `restoreWorkspaceTar` always gets an empty destination; ticket 14's
 * Review Workspaces will. Reported rather than left for 14, because a transfer that quietly delivers
 * less than it was handed is precisely the failure this format change escaped.
 *
 * @returns `'written'`, or `'declined'` when the destination already had an Alignment for that map.
 */
async function writeRestored(
	store: ProjectStore,
	path: StorePath,
	bytes: Bytes
): Promise<'written' | 'declined'> {
	const imageId = alignmentImageId(path);
	if (imageId === null) {
		await store.write(path, bytes);
		return 'written';
	}
	const outcome = await writeAlignmentBytes(
		{
			read: (at) => store.read(at),
			commit: (at, content) => store.write(at, content)
		},
		{ imageId, bytes, write: { intent: 'create' } }
	);
	return outcome === 'written' ? 'written' : 'declined';
}

/** The image id of `alignments/<id>.json`, or `null` for anything else. */
function alignmentImageId(path: string): string | null {
	const segments = path.split('/');
	if (segments.length !== 2 || segments[0] !== ALIGNMENT_DIRECTORY) return null;
	const name = segments[1] ?? '';
	return name.endsWith('.json') && name.length > '.json'.length
		? name.slice(0, -'.json'.length)
		: null;
}

type TarEntry = {
	header: { name: string; type?: string; pax?: Record<string, string> };
	body: ReadableStream<Uint8Array>;
};

/**
 * Everything the tar parser can say, said as a refusal instead.
 *
 * **A parser's message is not a message for a scholar.** `modern-tar` raises `Tar archive is
 * truncated.` for an empty file, for a JPEG somebody picked by mistake, and for a backup whose
 * download stopped half way — three quite different situations, none of which the user can act on
 * from that sentence, and none of which ends with the promise every other refusal on this path makes.
 * The zip importer wrapped its parser's errors for exactly this reason; so does this.
 *
 * **The word "truncated" is deliberately kept** when the parser used it. Of the three situations it
 * covers, the one that matters most is the download that stopped, and that is the one where knowing
 * the file is *incomplete* rather than *wrong* tells the user what to do — ask for it again. It is
 * also the failure this whole format change is about: the zip reader read a 70,000-entry archive back as 4,464
 * files with no error at all, so a short archive announcing itself is the property being bought, and
 * burying the word would be throwing away what it bought.
 */
function asRefusal(cause: unknown): never {
	if (cause instanceof BackupRejectedError || cause instanceof ProjectFormatTooNewError)
		throw cause;
	const detail = cause instanceof Error ? cause.message.replace(/\.$/, '') : String(cause);
	throw new BackupRejectedError(
		'not-a-tar',
		`This file could not be read as a Ballastella backup: ${detail}. A backup is the ` +
			`“.tar” file the Back up button produces; if this is one, it may not have ` +
			`downloaded completely, in which case ask for it again.`
	);
}

/** `reader.read()`, with a parser failure turned into something a person can act on. */
async function readEntry(
	reader: ReadableStreamDefaultReader<TarEntry>
): Promise<ReadableStreamReadResult<TarEntry>> {
	try {
		return await reader.read();
	} catch (cause) {
		asRefusal(cause);
	}
}

/**
 * One entry's body, into one buffer.
 *
 * This is where "streaming" stops and it is worth being exact about why, because the acceptance
 * criterion is about the *archive* rather than about each file. `ProjectStore.write` is atomic by
 * ADR-0017 rule 4 — a temporary file and a rename — and takes the bytes it is to write; there is no
 * streaming write to hand a `ReadableStream` to. So peak memory during a restore is **one file**,
 * not one archive, which is the bound that makes a 400 MB backup restorable on an iPad and the one a
 * zip could not offer at any size. The alternative — a streaming store write — is a change to the
 * storage layer that ADR-0017 would have to speak to, and this ticket moves bytes.
 *
 * The declared size is not trusted as a buffer length. It is a number in a file somebody else made;
 * what is written is what actually arrived, and if the two disagree the archive was truncated, which
 * `modern-tar` raises rather than papering over — measured, in `tar-format.test.ts`, at every cut it
 * was tried at. That is the exact failure the zip path made silent.
 */
async function collect(body: ReadableStream<Uint8Array>): Promise<Bytes> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			length += value.length;
		}
	} catch (cause) {
		// An archive that ends in the middle of an entry fails here rather than at the header, so the
		// refusal has to be built on this path too — it is the likeliest place a half-finished
		// download actually stops.
		asRefusal(cause);
	}
	const out = new Uint8Array(new ArrayBuffer(length));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

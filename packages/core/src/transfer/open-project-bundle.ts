import { createTarDecoder } from 'modern-tar';

import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import { writeAlignmentBytes } from '../alignment/alignment-file.js';
import { IMAGE_DIRECTORY, imageDirectory } from '../project/image-files.js';
import type { Layer } from '../project/layer.js';
import {
	BALLASTELLA_CANONICAL_URL,
	PROJECT_FILE_NAME,
	ProjectFormatTooNewError,
	parseProjectFile,
	projectFilePath,
	type ProjectFile
} from '../project/project-file.js';
import {
	REVIEW_MARK_FORMAT_VERSION,
	REVIEW_MARK_PATH,
	serialiseReviewMark,
	type ReviewMark
} from '../project/review-workspace.js';
import { describeBytes } from '../project/workspace-size.js';
import { hoistedImageId, isReservedDirectoryName, toDirectoryName } from '../project/workspace.js';
import { REFERENCED_IMAGE_FILE } from '../remote-iiif/referenced-image.js';
import { REMOTE_BINDING_PATH } from '../remote/remote-binding.js';
import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';
import {
	BundleRejectedError,
	assertSafeBundlePath,
	bundleWorkspaceName
} from './project-bundle.js';
import type { EstimateStorage } from './restore-workspace-tar.js';
import type { TransferProgressListener } from './transfer.js';

/**
 * The Review Workspace a bundle is opened into, and the way to throw it away again.
 *
 * **A bundle takes the means of *making* a Workspace rather than a store, exactly as restore does,
 * and for a stronger reason.** Restore never overwrites because the user cannot know what a backup
 * predates until they have looked at both. A bundle never opens into an existing Workspace at all —
 * not into the user's own even behind a confirmation (ADR-0024) — because under ADR-0023 there is one
 * Alignment per Historical Map in a Workspace, so merging a colleague's bundle would either overwrite
 * an Alignment two of your own Projects are drawn by or be refused. There is no third answer, and the
 * type is where that is enforced: this function is handed no store it could write into.
 *
 * `discard` is what makes "nothing has been opened" true rather than aspirational, and it costs the
 * user nothing because the destination was made moments ago.
 */
export interface ReviewDestination {
	/** The name the Review Workspace really got. Ticket 12 suffixes rather than refusing. */
	readonly name: string;
	readonly store: ProjectStore;
	/** Throw the whole Review Workspace away, with everything opening it has written. */
	discard(): Promise<void>;
}

/** Make a Review Workspace for a bundle to be opened into, near the name the file suggests. */
export type OpenReviewDestination = (preferredName: string) => Promise<ReviewDestination>;

export interface OpenProjectBundleOptions {
	readonly onProgress?: TransferProgressListener;
	/**
	 * The name of the file the user picked, for naming the Review Workspace and the Project directory
	 * inside it before `project.json` has been read.
	 *
	 * The archive carries neither name, deliberately: a Project's identity is its directory name
	 * (ADR-0008) and a Project archive has never carried one, so the reader chooses. Untrusted, and
	 * normalised on both paths it reaches.
	 */
	readonly fileName?: string;
	/**
	 * How many bytes the archive is, known before it is opened.
	 *
	 * Required for the quota check and available for free: the user picked a `File`, and `File.size`
	 * is its length. An honest bound on what will be written, because nothing in a tar is compressed.
	 */
	readonly archiveBytes?: number;
	readonly estimateStorage?: EstimateStorage;
	/** The clock, injectable so the mark's `openedAt` is assertable. */
	readonly now?: () => Date;
	/** Bounds to apply instead of {@link BUNDLE_LIMITS}, so the refusals are provokable in a test. */
	readonly limits?: Partial<BundleLimits>;
}

/**
 * What a bundle is allowed to hold, for the two things that are buffered rather than streamed.
 *
 * Every other entry goes straight from the decoder to the store, so its cost is bounded by the quota
 * check and by tar's inability to claim more than it holds. These two are not: `project.json` is read
 * into memory so it can be parsed and written last, and the set of archive paths is kept so that
 * `assertReferencesPresent` has something to check against.
 *
 * Generous by a wide margin. SPEC's largest Project is a 2 GB pyramid, which is a few hundred
 * thousand files at most; a `project.json` of a megabyte is not a manifest.
 */
export interface BundleLimits {
	/** Bytes of `project.json`. */
	readonly manifestBytes: number;
	/** How many entries the archive may hold. */
	readonly entries: number;
}

export const BUNDLE_LIMITS: BundleLimits = {
	manifestBytes: 4 * 1024 * 1024,
	entries: 2_000_000
};

export interface OpenedBundle {
	/** The Review Workspace the bundle is now in, which the caller has to switch to. */
	readonly workspaceName: string;
	/** The Project's directory inside that Workspace, for the `?p=` the caller navigates to. */
	readonly directory: string;
	/** The manifest, parsed. What the banner names. */
	readonly project: ProjectFile;
	/** How many files were **written**. Never how many the archive held — see {@link declined}. */
	readonly totalFiles: number;
	readonly totalBytes: number;
	/**
	 * Archive paths that were deliberately **not** written, and are not counted above.
	 *
	 * Empty for every honest bundle: a tar has no index, but nothing an exporter writes names a path
	 * twice. A bundle that **does** name one twice — any path, not only an Alignment — has its second
	 * and later entries declined rather than being allowed to overwrite the first.
	 *
	 * Reported rather than swallowed. `restoreWorkspaceTar`'s first cut counted a declined file as
	 * restored, and a transfer that says it delivered more than it did is the zip writer claiming 4,464 of
	 * 70,000 with a different spelling — which is the failure this whole format change escaped.
	 */
	readonly declined: readonly string[];
	/** What the user has to be told, in the words they should see (workspace-and-layers SPEC story 111). */
	readonly notice: string;
}

/**
 * Read a handoff bundle into a **new Review Workspace**, streaming.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * **THE ORDER OF OPERATIONS IS THE DESIGN, BECAUSE A TAR CANNOT BE VALIDATED FIRST**
 *
 * The zip importer validated an entire archive before writing a byte, and it could, because a zip has
 * a central directory at its end listing everything in it. Reading that index is also exactly why a
 * zip cannot be streamed, and why a large bundle could not be opened on an iPad at all — half of what
 * tar was chosen for (ADR-0024).
 *
 * So there is no "validate everything, then write". What there is instead:
 *
 * 1. **Quota is checked before anything is created**, against the archive's own byte length, and
 *    refused legibly with the numbers rather than discovered at eighty per cent.
 * 2. **The Review Workspace is created, and marked, before a single Project byte lands.** The mark is
 *    what makes the banner appear, and the order matters: a mark written last would mean that an
 *    interrupted open — a closed laptop, a killed tab — left a Workspace full of somebody else's work
 *    that looks exactly like the user's own. Marked first, the same interruption leaves a visibly
 *    throwaway Workspace with a Discard button on it. The mark is rewritten at the end with the
 *    Project's real display name, which is not known until the manifest has been read.
 * 3. **Every entry is checked as it arrives** — a plain relative path, no traversal, no reserved name
 *    — and written straight through. This is the streaming part, and it is why peak memory is one
 *    file rather than one archive.
 * 4. **`project.json` is held back and written last**, per the discipline both other transfer paths
 *    keep. The Workspace's list of Projects *is* whichever directories hold a `project.json`
 *    (ADR-0008), so an interrupted open leaves a directory of orphaned files rather than a Project
 *    that lists on the hub and opens with half its Layers missing.
 * 5. **It is parsed as it is held back**, so ADR-0010's refusal of a `formatVersion` from the future
 *    happens while the only thing at stake is a Workspace nobody has seen yet.
 * 6. **The references are checked once the archive has been walked**, which is the one check that
 *    genuinely cannot happen early: `assertReferencesPresent` needs the whole path set, and a tar only
 *    yields one when it ends. It is therefore checked *after* writing rather than before — which is
 *    safe here and would not be anywhere else, because everything it wrote is inside a Workspace that
 *    is about to be discarded if the check fails.
 * 7. **Anything that fails at any point discards the whole Review Workspace.** That is what makes the
 *    refusals' closing sentence true, and it is available because the destination is new.
 *
 * ⚠ **What this does not do, stated rather than implied.** It does not merge, and there is no
 * affordance anywhere that promotes a reviewed Project into the user's own Workspace. That is not an
 * omission to be filled in later: ADR-0024 names it as the fence that makes the rest coherent, since
 * a promotion is the Alignment collision arriving by another route. A scholar who wants a colleague's
 * map in their own research adds the map themselves.
 *
 * @throws BundleRejectedError for anything wrong with the archive or with the room to hold it
 * @throws ProjectFormatTooNewError for a Project from a newer version of the app (ADR-0010)
 */
export async function openProjectBundle(
	archive: ReadableStream<Uint8Array>,
	open: OpenReviewDestination,
	options: OpenProjectBundleOptions = {}
): Promise<OpenedBundle> {
	const limits = { ...BUNDLE_LIMITS, ...options.limits };
	const now = options.now ?? (() => new Date());
	await assertRoomToOpen(options);

	const fileName = options.fileName ?? '';
	const preferredWorkspace = bundleWorkspaceName(fileName);
	const directory = reviewDirectoryName(fileName);

	const entries = archive.pipeThrough(createTarDecoder({ strict: true }));
	const reader = entries.getReader();

	let destination: ReviewDestination | null = null;
	try {
		destination = await open(preferredWorkspace);
		const store = destination.store;
		// The mark, before anything else. See step 2 above: this is what an interrupted open leaves
		// behind, and it has to be enough for the user to recognise and discard.
		await writeMark(store, {
			formatVersion: REVIEW_MARK_FORMAT_VERSION,
			project: preferredWorkspace,
			directory: '',
			openedAt: now().toISOString()
		});

		const outcome = await drainInto(store, reader, directory, limits, options);

		if (outcome.manifest === null) {
			throw new BundleRejectedError(
				'no-project-file',
				`This file has no ${PROJECT_FILE_NAME} at its root, so it is not a Ballastella Project ` +
					`bundle. A bundle holds one Project, with ${PROJECT_FILE_NAME} at the top; a whole ` +
					`Workspace backup is a different file and is opened from Workspace settings.`
			);
		}
		const project = outcome.manifest;

		// The one check that cannot happen before the writing, because a tar has no index to read it
		// from. Safe here for the reason nothing else about this ordering would be: the destination is
		// discarded on the way out of this `catch`, so a bundle that fails it leaves nothing at all.
		assertReferencesPresent(project, outcome.present);

		// Last, and only now. Everything it names is already on disk, so the moment the Project appears
		// on the hub is the moment it is whole.
		await store.write(projectFilePath(directory) as StorePath, outcome.manifestBytes as Bytes);

		// The mark again, now that the Project has a name and a directory. Two small writes rather than
		// one, because the alternative is not writing it until the end — which is the ordering step 2
		// rules out.
		await writeMark(store, {
			formatVersion: REVIEW_MARK_FORMAT_VERSION,
			project: project.name || preferredWorkspace,
			directory,
			openedAt: now().toISOString()
		});

		const files = outcome.files + 1;
		const bytes = outcome.bytes + outcome.manifestBytes.length;
		return {
			workspaceName: destination.name,
			directory,
			project,
			totalFiles: files,
			totalBytes: bytes,
			declined: outcome.declined,
			notice:
				`Opened “${project.name || directory}” into a review copy called ` +
				`“${destination.name}”. It is a throwaway Workspace: your own Workspaces have not been ` +
				`touched, nothing here can be copied into them, and discarding this one removes ` +
				`everything in it.` +
				(outcome.declined.length === 0
					? ''
					: ` ${outcome.declined.length} ${
							outcome.declined.length === 1 ? 'entry' : 'entries'
						} in the bundle ${outcome.declined.length === 1 ? 'was' : 'were'} not written, ` +
						`because the bundle names the same file more than once and the first copy of ` +
						`each is the one that was kept: ${outcome.declined.join(', ')}.`)
		};
	} catch (cause) {
		// The refusals' closing sentence is "Nothing has been opened", and this is what makes it true. A
		// discard that itself fails must not replace the reason the bundle was refused: the user needs
		// to know what was wrong with the file far more than they need to know that cleaning up after it
		// also went badly.
		if (destination) await destination.discard().catch(() => undefined);
		await reader.cancel().catch(() => undefined);
		throw cause;
	}
}

/** Write the Review Workspace's mark. The one place the marker file is produced. */
async function writeMark(store: ProjectStore, mark: ReviewMark): Promise<void> {
	await store.write(REVIEW_MARK_PATH, serialiseReviewMark(mark));
}

/**
 * The Project directory a bundle's contents go into, derived from the file the user picked.
 *
 * The archive does not carry one and must not: the reader chooses the name, which is what makes a
 * collision a question for the user rather than an accident (ADR-0008). Here there is nothing to
 * collide with — the Workspace was made moments ago and holds exactly this one Project — so the
 * choice is only about what the user sees in the URL and on the hub, and the file they picked is what
 * they recognise.
 *
 * **Refused onto a fallback when the slug is one the Workspace itself needs.** `images/`,
 * `alignments/` and `base-map/` are the shared pool (ADR-0023), and a bundle called `Images.tar`
 * would otherwise put `project.json` and `annotations/` inside it — where the hoisted material also
 * lands, and where deleting the Project would take the Historical Maps with it.
 */
function reviewDirectoryName(fileName: string): string {
	const stem = fileName.replace(/\.project\.tar$/i, '').replace(/\.tar$/i, '');
	const slug = toDirectoryName(stem);
	return isReservedDirectoryName(slug) ? `${slug}-project` : slug;
}

/**
 * Refuse a bundle there is no room for, **before the Review Workspace exists**.
 *
 * `navigator.storage.estimate()` reached through an injected function, so this is provokable in a
 * test rather than only in a browser with a full disk. Silent when the browser will not answer:
 * refusing because the quota API is unavailable would refuse on Safari, and an open that fails part
 * way is still better than one that cannot be attempted. The numbers are named because "not enough
 * space" without them is a message a user cannot act on.
 */
async function assertRoomToOpen(options: OpenProjectBundleOptions): Promise<void> {
	const { archiveBytes, estimateStorage } = options;
	if (archiveBytes === undefined || !estimateStorage) return;

	const estimate = await estimateStorage().catch(() => null);
	const quota = estimate?.quota;
	const usage = estimate?.usage;
	if (typeof quota !== 'number' || typeof usage !== 'number') return;

	const free = quota - usage;
	if (free >= archiveBytes) return;

	throw new BundleRejectedError(
		'insufficient-quota',
		`This bundle needs about ${describeBytes(archiveBytes)} and there is ${describeBytes(
			Math.max(0, free)
		)} free — ${describeBytes(usage)} of the ${describeBytes(quota)} this browser allows is ` +
			`already in use. Discard a review copy you have finished with, delete a Workspace you no ` +
			`longer need, or free space on this device, and try again.`
	);
}

interface BundleOutcome {
	readonly files: number;
	readonly bytes: number;
	readonly manifest: ProjectFile | null;
	readonly manifestBytes: Bytes;
	/** Every archive path the bundle carried, for {@link assertReferencesPresent}. */
	readonly present: ReadonlySet<string>;
	readonly declined: readonly string[];
}

/**
 * Write the archive's entries into the Review Workspace, the manifest held back.
 *
 * ⚠ **`files` and `bytes` count what was *written*, never what was *read*.** An Alignment goes
 * through ticket 18's one writer, which may decline it, and the first cut of the equivalent function
 * on the restore path incremented the counters regardless — so a transfer reported delivering a file
 * it had dropped. A declined entry is counted nowhere and named in {@link BundleOutcome.declined}.
 */
async function drainInto(
	store: ProjectStore,
	reader: ReadableStreamDefaultReader<TarEntry>,
	directory: string,
	limits: BundleLimits,
	options: OpenProjectBundleOptions
): Promise<BundleOutcome> {
	const present = new Set<string>();
	const declined: string[] = [];
	let manifest: ProjectFile | null = null;
	let manifestBytes = new Uint8Array(new ArrayBuffer(0)) as Bytes;
	let files = 0;
	let bytes = 0;
	let seen = 0;

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
		// directory holds no scholarship, so they are drained and dropped.
		if (header.type === 'directory' || header.name.endsWith('/')) {
			await body.cancel();
			continue;
		}

		seen += 1;
		if (seen > limits.entries) {
			throw new BundleRejectedError(
				'too-large',
				`This bundle holds more than ${limits.entries} files, which is more than one Project is. ` +
					`It has not been read further.`
			);
		}

		assertSafeBundlePath(header.name);

		// ⚠ **An opened bundle arrives unbound** (SPEC story 42, ADR-0032), and the drop is explicit
		// here as it is on the restore path rather than left to follow from where a bundle's entries
		// happen to land. Structurally a root `remote.json` would go inside the Project's own directory
		// and could never reach the Workspace root, so today this changes no behaviour — but "no route
		// exists" is a property of the hoisting rules rather than a rule anybody stated, and the two
		// arrival paths saying the same thing in the same words is what keeps it true. The root entry
		// only: `images/<id>/remote.json` is a referenced IIIF image's own document (ADR-0007) and is
		// exactly the file a Project with a referenced Historical Map needs to be readable at all.
		if (header.name === REMOTE_BINDING_PATH) {
			await body.cancel();
			continue;
		}

		const content = await collect(body);

		if (header.name === PROJECT_FILE_NAME) {
			if (manifest !== null) {
				throw new BundleRejectedError(
					'duplicate-manifest',
					`This bundle carries ${PROJECT_FILE_NAME} more than once, so which Project it holds ` +
						`cannot be decided. Everything else in it is checked against that document, so ` +
						`reading it further would be guessing.`
				);
			}
			if (content.length > limits.manifestBytes) {
				throw new BundleRejectedError(
					'too-large',
					`The ${PROJECT_FILE_NAME} in this bundle is ${describeBytes(content.length)}, and a ` +
						`${PROJECT_FILE_NAME} is a short manifest rather than a document of that size.`
				);
			}
			// Parsed *now*, while the only thing at stake is a Workspace nobody has seen. ADR-0010's
			// refusal has to land before the manifest is written, or a Project from a newer version of the
			// app would list on the hub of a Review Workspace this build then could not open.
			manifest = readManifest(content);
			manifestBytes = content;
			present.add(header.name);
			continue;
		}

		// ⚠ **An archive path named twice is declined, whatever it names, and the first one wins.**
		// A tar has no index and nothing stops a file from carrying the same entry more than once.
		// Ticket 18's writer already refused a second `alignments/<id>.json`, so that one path was
		// safe — but `images/…` and the Project's own files went straight through `store.write`,
		// which overwrites, **and were counted again**: a bundle with a repeated tile silently
		// delivered the later copy and reported more files than were on disk. A transfer that says it
		// delivered more than it did is the zip writer claiming 4,464 of 70,000 with a different
		// spelling, which is the failure this whole format change escaped.
		//
		// It also means the Alignment's own decline is no longer *reached from here* — this refuses
		// the duplicate a step earlier. The routing stays, because it is the rule about who may write
		// that file rather than a duplicate check, and because the decline is what would catch a
		// destination that was not empty.
		if (present.has(header.name)) {
			declined.push(header.name);
			report(header.name);
			continue;
		}
		present.add(header.name);
		const outcome = await writeBundled(store, directory, header.name, content);
		if (outcome === 'declined') {
			declined.push(header.name);
			report(header.name);
			continue;
		}
		files += 1;
		bytes += content.length;
		report(header.name);
	}

	report(null);
	return { files, bytes, manifest, manifestBytes, present, declined };
}

/**
 * Write one entry of a bundle, hoisting the shared material and routing an Alignment (ADR-0023).
 *
 * **The hoist is `hoistedImageId`, unchanged.** A bundle's paths are Project-relative, and
 * `images/<id>/…` and `alignments/<id>.json` name a Historical Map that belongs to the *Workspace*
 * rather than to the Project; everything else goes inside the Project's directory. Sharing the
 * function with the Workspace rather than restating the rule is the point — a second reading of which
 * archive paths are shared is a second answer to the question ADR-0023 settled.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * **WHY THE ALIGNMENT IS ROUTED RATHER THAN WRITTEN, WHEN IT ALMOST NEVER COLLIDES**
 *
 * Ticket 18 made `alignment-file.ts` the only writer of `alignments/<image-id>.json`, behind two
 * layers: `alignmentPath` returns a branded `AlignmentPath` that `ProjectStore.write` refuses, and
 * `scripts/check-alignment-writers.mjs` covers the spellings a type cannot see.
 *
 * **This code walks through both of them, and it is worth being exact about how**, because writing
 * the path directly here would have failed nothing. The path is an archive entry's own name with a
 * prefix computed at runtime — a value the compiler only ever sees as `string`, so the brand never
 * applies; and the fence looks for the `alignments/` spelling, which this module never writes,
 * because the path arrives as data out of somebody's file. That is the limit ticket 18 states about
 * itself rather than claims away, and `restore-workspace-tar.ts` says the same about the same gap.
 *
 * It is routed anyway, for the reason 18's own remediation gives: the danger is not this call site,
 * it is that "the bundle reader writes Alignments with the generic writer" is a *true statement about
 * the codebase* that the next person reads as permission.
 *
 * ⚠ **Its decline is not reached from this module, and that is a change worth stating.** It used to
 * be: an archive naming one Alignment twice got here twice, and `intent: 'create'` refused the
 * second. That left every *other* repeated path — a tile, an Annotation — silently overwriting and
 * double-counted, so {@link drainInto} now refuses a repeated entry before it arrives here, whatever
 * it names. The routing is kept as what it always was, ticket 18's rule about **who may write that
 * file**, not a duplicate check; its decline is the layer that would catch a destination which was
 * not empty, which a Review Workspace never is today.
 *
 * The bytes go through verbatim — `writeAlignmentBytes`, not `writeAlignmentFile` — because what is
 * being copied is a document another build wrote, and re-serialising it from this build's model is
 * the loss workspace-and-layers SPEC story 60 forbids.
 */
async function writeBundled(
	store: ProjectStore,
	directory: string,
	archivePath: string,
	bytes: Bytes
): Promise<'written' | 'declined'> {
	const shared = hoistedImageId(archivePath);
	if (shared === null) {
		await store.write(`${directory}/${archivePath}` as StorePath, bytes);
		return 'written';
	}
	if (!archivePath.startsWith(`${ALIGNMENT_DIRECTORY}/`)) {
		await store.write(archivePath as StorePath, bytes);
		return 'written';
	}
	const outcome = await writeAlignmentBytes(
		{
			read: (at) => store.read(at),
			commit: (at, content) => store.write(at, content)
		},
		{ imageId: shared, bytes, write: { intent: 'create' } }
	);
	return outcome === 'written' ? 'written' : 'declined';
}

/**
 * Parse a manifest, re-ending ADR-0010's refusal for this path.
 *
 * The same class and the same `formatVersion`, so everything catching it still does; only the closing
 * sentence changes, from a promise about a local Project — which does not exist here — to the one
 * every other refusal on this path makes.
 */
function readManifest(bytes: Bytes): ProjectFile {
	try {
		return parseProjectFile(bytes);
	} catch (cause) {
		if (cause instanceof ProjectFormatTooNewError) {
			throw new ProjectFormatTooNewError(
				cause.formatVersion,
				BALLASTELLA_CANONICAL_URL,
				'Nothing has been opened.'
			);
		}
		throw cause;
	}
}

/**
 * The files a Layer names, Project-relative, which a transfer therefore has to carry.
 *
 * A Layer references its content and never contains it (ADR-0002), so this is where the references
 * are collected — from the union rather than by reading key names off an untyped object, so a kind
 * added later has to say here what it points at.
 *
 * Exported for `review-from-remote.ts`, which asks the same question of a Remote's tree and reports
 * rather than refuses. Two answers to "what does this Layer point at" is how a bundle and a Review
 * of the same Project come to carry different files while both stay green.
 */
export function layerReferences(layer: Layer): readonly string[] {
	switch (layer.kind) {
		// ⚠ **A map Layer references no *file* that a bundle must carry, and requiring its Alignment
		// was a refusal of the ordinary case.** A Historical Map added to a Project is a Layer from
		// that moment, aligned or not — ADR-0023, and the Layer card says "Not aligned yet, so there
		// is nothing to draw" — so `alignments/<image-id>.json` need not exist at all. The exporter
		// already treats a missing one as ordinary (`export-project-bundle.ts`, "a Historical Map
		// nobody has placed yet has no Alignment"), so demanding it here meant a scholar could export
		// a Project and then be refused their own file on the way back in. The pyramid is a different
		// matter and is still required, below: a Layer pointing at an image directory the bundle does
		// not carry is what actually loses a reader's map.
		//
		// Nothing is opened to decide any of this (ADR-0023): both paths are computed from the one
		// `imageId`, which removes the class of archive naming an Alignment and an image that
		// disagreed. **No untrusted Annotation is parsed during validation**, which is the property
		// this whole path is built on: it interprets nothing but `project.json`.
		case 'map':
			return [];
		case 'annotation':
			return [layer.geojsonRef];
		// A kind this build has never heard of is still asked about `geojsonRef`, because a Layer
		// carrying one means by it what every other Layer means. It is **not** asked about `imageId`:
		// this build cannot know that a foreign kind's `imageId` names a Historical Map at all, and
		// refusing an archive over a guess is refusing it for a reason nobody can act on.
		case 'foreign':
			return ['geojsonRef']
				.map((key) => layer.unknownFields?.[key])
				.filter((reference): reference is string => typeof reference === 'string');
	}
}

/**
 * Refuse a bundle whose `project.json` points at files it does not carry.
 *
 * **What this establishes.** Every file a Layer names is in the archive — an Annotation Layer's
 * GeoJSON — and, for **every** map Layer, that its image directory is in the archive at all. That
 * second one is the case that actually loses a reader's map, and the structural check below cannot
 * see it because there is no directory there to check.
 *
 * ⚠ **An Alignment is deliberately not required**, though a map Layer's path to one is computable.
 * A Historical Map added to a Project is a Layer from that moment, aligned or not (ADR-0023), so a
 * Project in that ordinary state has no `alignments/<image-id>.json` to carry — and the exporter
 * already skips it silently. Requiring it here meant that Project exported to a bundle **its own
 * sender could not re-open**, which is the worst shape a transfer defect can take: it is discovered
 * by the recipient, about a file the sender can no longer change.
 *
 * **What it does not establish, deliberately.** Nothing here opens an Alignment or a
 * `FeatureCollection`. Both paths are derived from the Layer's `imageId`, and an Alignment's identity
 * is its path rather than its own `resource.id`, exactly as `parseAlignment` reads it. So this cannot
 * catch an Alignment whose contents name a different image service than its filename does — and it
 * should not try, because the filename is the authority in the reader too, and because parsing a
 * stranger's Annotation to decide whether to accept an archive would give up the one property this
 * path has: it interprets nothing but `project.json`. It also does not check that a pyramid is
 * *complete* — a missing tile is a blank square, not a lost map, and only the tiler knows which tiles
 * a level should have.
 */
export function assertReferencesPresent(project: ProjectFile, present: ReadonlySet<string>): void {
	const missing = (reference: string, why: string): never => {
		throw new BundleRejectedError(
			'missing-reference',
			`This bundle is missing “${reference}”, which ${why}.`
		);
	};

	const imageDirectories = new Set<string>();
	for (const path of present) {
		const segments = path.split('/');
		if (segments[0] === IMAGE_DIRECTORY && segments.length > 2) {
			imageDirectories.add(`${segments[0]}/${segments[1]}`);
		}
	}

	for (const layer of project.layers) {
		for (const reference of layerReferences(layer)) {
			if (reference === '') continue;
			if (!present.has(reference)) {
				missing(
					reference,
					`the Layer “${layer.name || layer.id}” in ${PROJECT_FILE_NAME} needs to be drawn`
				);
			}
		}

		// **And the bundle carries an image directory for every map Layer, with no way to be excused
		// from it.** There used to be one: `imageMode` said whether the Layer claimed a local pyramid, so
		// an archive with `project.json`, an Alignment, no `images/` directory whatsoever and one word
		// changed imported cleanly and then drew nothing — the renderer never consulted `imageMode` and
		// asked the ADR-0011 shim for every map Layer's tiles out of `images/<id>/` regardless. ADR-0023
		// removed the field, so the exemption is now unrepresentable rather than merely unhonoured.
		if (layer.kind !== 'map') continue;
		if (layer.imageId === '') continue;
		const directory = imageDirectory(layer.imageId);
		if (!imageDirectories.has(directory)) {
			missing(
				`${directory}/`,
				`the Layer “${layer.name || layer.id}” in ${PROJECT_FILE_NAME} needs to be drawn`
			);
		}
	}

	// An image directory that describes itself as neither is a heap of files no client can open
	// (ADR-0006's layout), so the image is missing whether or not any Layer has been wired to it yet.
	// This is the other half of the pair: the loop above catches an image a Layer names and the archive
	// does not carry, and this one catches an image the archive carries incompletely.
	//
	// **Two ways to be describable, because there are two kinds of image.** A local copy has the
	// `info.json` that makes its pyramid readable; a referenced image has `remote.json` instead,
	// because its tiles *and* its `info.json` are on somebody else's server. Requiring `info.json` of
	// both would mean a Project with a referenced Historical Map could be exported and then refused on
	// the way back in — a scholar unable to open their own export.
	for (const directory of [...imageDirectories].sort()) {
		const info = `${directory}/info.json`;
		if (present.has(info) || present.has(`${directory}/${REFERENCED_IMAGE_FILE}`)) continue;
		missing(
			info,
			`the image directory “${directory}” needs it, or ${REFERENCED_IMAGE_FILE} if its tiles are ` +
				`on another server, to be readable at all`
		);
	}
}

type TarEntry = {
	header: { name: string; type?: string; pax?: Record<string, string> };
	body: ReadableStream<Uint8Array>;
};

/**
 * Everything the tar parser can say, said as a refusal instead.
 *
 * **A parser's message is not a message for a scholar.** `modern-tar` raises `Tar archive is
 * truncated.` for an empty file, for a JPEG somebody picked by mistake, and for a bundle whose
 * download stopped half way — three quite different situations, none of which the user can act on
 * from that sentence.
 *
 * **The word "truncated" is deliberately kept** when the parser used it. A bundle is a file that has
 * *travelled*, so a download that stopped is its likeliest damage, and knowing the file is
 * *incomplete* rather than *wrong* tells the user what to do — ask for it again. It is also the
 * failure this whole format change is about: the zip reader read a 70,000-entry archive back as 4,464 files
 * with no error at all, so a short archive announcing itself is the property being bought.
 */
function asRefusal(cause: unknown): never {
	if (cause instanceof BundleRejectedError || cause instanceof ProjectFormatTooNewError)
		throw cause;
	const detail = cause instanceof Error ? cause.message.replace(/\.$/, '') : String(cause);
	throw new BundleRejectedError(
		'not-a-tar',
		`This file could not be read as a Ballastella Project bundle: ${detail}. A bundle is the ` +
			`“.project.tar” file the Export button produces; if this is one, it may not have downloaded ` +
			`completely, in which case ask for it again.`
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
 * This is where "streaming" stops and it is worth being exact about why, because the property being
 * bought is about the *archive* rather than about each file. `ProjectStore.write` is atomic by
 * ADR-0017 rule 4 — a temporary file and a rename — and takes the bytes it is to write; there is no
 * streaming write to hand a `ReadableStream` to. So peak memory while opening a bundle is **one
 * file**, not one archive, which is the bound that makes a large bundle openable on an iPad and the
 * one a zip could not offer at any size.
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
		// refusal has to be built on this path too — it is the likeliest place a half-finished download
		// actually stops.
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

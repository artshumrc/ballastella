import { unzip, type UnzipFileInfo, type Unzipped } from 'fflate';

import { mapLayerImageInfoPath, type Layer } from '../project/layer.js';
import {
	BALLASTELLA_CANONICAL_URL,
	PROJECT_FILE_NAME,
	ProjectFormatTooNewError,
	parseProjectFile,
	type ProjectFile
} from '../project/project-file.js';
import { isTempPath, type Bytes } from '../store/project-store.js';
import type { ProjectFileSource, TransferFile } from './transfer.js';

/** Why a zip cannot be imported. Each one is refused before a single byte is written. */
export type ProjectZipRejection =
	/** The bytes are not a zip archive, or the archive is damaged. */
	| 'not-a-zip'
	/** No `project.json` at the root of the archive, so this is not a Project zip. */
	| 'no-project-file'
	/** An entry would be written outside the Project directory. */
	| 'path-traversal'
	/** An entry uses a compression method this build cannot read. */
	| 'unsupported-compression'
	/** An entry's bytes do not match the CRC-32 the archive carries for it. */
	| 'damaged-entry'
	/** The archive declares more entries, or more bytes, than a Project is allowed to hold. */
	| 'too-large'
	/** `project.json` names a file, or an image directory needs one, that is not in the archive. */
	| 'missing-reference';

/**
 * A zip that will not be imported, with a message for the person who was handed it.
 *
 * Separate from {@link ProjectFileUnreadableError} and {@link ProjectFormatTooNewError}, which
 * `readProjectZip` lets through untouched: those two are about the `project.json` inside and their
 * messages are already the right ones to show — in particular ADR-0010's refusal, which names the
 * remedy and is the same sentence a user sees when the same Project sits in their Workspace.
 */
export class ProjectZipRejectedError extends Error {
	readonly reason: ProjectZipRejection;

	constructor(reason: ProjectZipRejection, message: string) {
		super(`${message} Nothing has been imported.`);
		this.name = 'ProjectZipRejectedError';
		this.reason = reason;
	}
}

/**
 * A validated Project zip, ready to be handed to `Workspace.importProject`.
 *
 * Holding this is the proof that validation passed. There is deliberately no way to write a zip's
 * contents without producing one first: a partially written import is worse than a rejected one,
 * because the user is left with a directory that is neither their colleague's Project nor absent.
 */
export interface ProjectZip extends ProjectFileSource {
	/** The manifest, parsed. Lets the caller name the Project before deciding where to put it. */
	readonly project: ProjectFile;
}

/**
 * How much is inflated at once, in uncompressed bytes and in entries.
 *
 * Import re-reads the archive once per batch, which is cheap — fflate reads the central directory
 * and skips whatever the filter declines, without inflating it — and it is what keeps a
 * hundred-megabyte pyramid from existing twice over in the heap, compressed and inflated, on a
 * machine whose browser is the only place that Project lives (ADR-0001).
 */
const BATCH_BYTES = 8 * 1024 * 1024;
const BATCH_ENTRIES = 128;

/**
 * What an archive is allowed to declare about itself.
 *
 * A zip is a file another person made, and every number in it is a claim rather than a fact. Two of
 * those claims are dangerous on their own, before a single byte has been inflated:
 *
 * - **Deflate reaches nearly 1000:1** on the runs of zeros a bomb is made of — a megabyte of them
 *   compresses to about a kilobyte, measured — so a ten-megabyte archive can honestly declare ten
 *   gigabytes and `importProject` would write every one of them. On OPFS the quota throws part way
 *   through; on ticket 12's File System Access backend **there is no quota at all**, and the folder
 *   was granted for one purpose.
 * - **The declared size of one entry becomes fflate's output buffer**, so a forty-kilobyte archive
 *   whose single entry claims four gigabytes asks the browser for four gigabytes. This is what makes
 *   "peak memory is the compressed archive plus one batch" true for a hostile archive as well as an
 *   honest one, which is the case a bound exists for.
 *
 * The numbers are generous rather than tight, because refusing a real Project is its own failure:
 * SPEC's largest is a 2 GB pyramid and ADR-0008's whole-workspace hosting budget is about 1 GB, so
 * four gigabytes leaves a Project twice the largest one contemplated. `entryBytes` is sized for
 * ticket 15's mirrored `full/max` image, which is the only single file in ADR-0006's layout that can
 * be large at all; everything else is a tile, a manifest, or JSON.
 */
export interface ProjectZipLimits {
	/** Total declared uncompressed bytes across every entry. */
	readonly totalBytes: number;
	/** Declared uncompressed bytes of any one entry. */
	readonly entryBytes: number;
	/** How many entries the archive may hold. */
	readonly entries: number;
}

export const PROJECT_ZIP_LIMITS: ProjectZipLimits = {
	totalBytes: 4 * 1024 * 1024 * 1024,
	entryBytes: 256 * 1024 * 1024,
	entries: 65535
};

export interface ReadProjectZipOptions {
	/**
	 * Bounds to apply instead of {@link PROJECT_ZIP_LIMITS}. Injectable for the same reason
	 * `exportProjectZip`'s `excluded` is: the refusals are then assertable without building a
	 * four-gigabyte archive to provoke one.
	 */
	readonly limits?: Partial<ProjectZipLimits>;
}

/** Bytes as a figure a person reads, for a refusal that has to name the number. */
function describeBytes(bytes: number): string {
	const gigabytes = bytes / (1024 * 1024 * 1024);
	if (gigabytes >= 1) return `${Number(gigabytes.toFixed(1))} GB`;
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Read and validate a Project zip. **Writes nothing, and reaches no store.**
 *
 * Every check in ticket 13's table happens here, before the caller has anything it could write:
 * `project.json` present and parseable, `formatVersion` not from the future, referenced files
 * present, and no entry that would escape the Project directory. That last one is not theory — a
 * zip is a file another person made, and on ticket 12's File System Access backend an entry named
 * `../../something` writes into a folder the user never chose.
 *
 * **One check deliberately does not finish here.** Whether each entry's bytes match the CRC-32 the
 * archive records for it cannot be known without inflating them, so it happens per batch as they are
 * written and the whole import is rolled back if one fails — see {@link assertUndamaged} for why the
 * alternatives are worse, and `Workspace.importProject` for the undo that makes it safe.
 *
 * @throws ProjectZipRejectedError for anything wrong with the archive
 * @throws ProjectFileUnreadableError when `project.json` is not readable JSON
 * @throws ProjectFormatTooNewError for a Project from a newer version of the app (ADR-0010)
 */
export async function readProjectZip(
	archive: Bytes,
	options: ReadProjectZipOptions = {}
): Promise<ProjectZip> {
	const limits = { ...PROJECT_ZIP_LIMITS, ...options.limits };
	// Read before anything is inflated, because an archive whose index cannot be walked is one whose
	// entries cannot be checked against it, and importing unverifiable bytes is the thing this
	// refuses to do.
	const checksums = readChecksums(archive);
	if (!checksums) {
		throw new ProjectZipRejectedError(
			'not-a-zip',
			'The index at the end of this zip could not be read, so what is inside it cannot be ' +
				'checked. If it came from a large archive — over four gigabytes, or more than 65,535 ' +
				'files — this copy of Ballastella cannot read it.'
		);
	}

	// Answered from the index rather than by enumerating, so an archive claiming millions of entries
	// costs one comparison rather than a million.
	if (checksums.size > limits.entries) {
		throw new ProjectZipRejectedError(
			'too-large',
			`This zip holds ${checksums.size} files. A Project may hold at most ${limits.entries}, ` +
				`so this is not one.`
		);
	}

	const entries: UnzipFileInfo[] = [];
	// Only `project.json` is inflated: it is the one file whose *contents* validation looks at, and
	// the filter is called for every entry regardless, so the archive is fully enumerated for the
	// price of one small inflate.
	const extracted = await inflate(archive, (entry) => {
		entries.push(entry);
		return entry.name === PROJECT_FILE_NAME;
	});

	const paths: string[] = [];
	let totalBytes = 0;
	for (const entry of entries) {
		assertSafeEntryName(entry.name);
		// A zip records directories as their own zero-length entries. Nothing needs them: the store
		// creates missing parents on write, and an empty directory holds no scholarship.
		if (entry.name.endsWith('/')) continue;
		if (entry.compression !== 0 && entry.compression !== 8) {
			throw new ProjectZipRejectedError(
				'unsupported-compression',
				`“${entry.name}” in this zip uses a compression method this copy of Ballastella cannot read.`
			);
		}
		if (!checksums.has(entry.name)) {
			throw new ProjectZipRejectedError(
				'not-a-zip',
				`“${entry.name}” appears in this zip's index twice, or under a name that could not be ` +
					`matched against it, so its contents cannot be checked.`
			);
		}
		if (entry.originalSize > limits.entryBytes) {
			throw new ProjectZipRejectedError(
				'too-large',
				`“${entry.name}” in this zip says it is ${describeBytes(entry.originalSize)} once ` +
					`unpacked. No file in a Project is larger than ${describeBytes(limits.entryBytes)}, ` +
					`so this archive is not one — or is not what it says it is.`
			);
		}
		paths.push(entry.name);
		totalBytes += entry.originalSize;
	}

	if (totalBytes > limits.totalBytes) {
		throw new ProjectZipRejectedError(
			'too-large',
			`This zip says it unpacks to ${describeBytes(totalBytes)}. Ballastella will not import a ` +
				`Project larger than ${describeBytes(limits.totalBytes)}, because a compressed archive ` +
				`can claim far more than it holds and there would be no way back once your disk was full.`
		);
	}

	const manifest = extracted[PROJECT_FILE_NAME];
	if (!manifest) {
		throw new ProjectZipRejectedError(
			'no-project-file',
			`This zip has no ${PROJECT_FILE_NAME} at its root, so it is not a Ballastella Project. ` +
				`A Project zip holds one Project, with ${PROJECT_FILE_NAME} at the top.`
		);
	}
	// Checked before it is parsed, because a damaged `project.json` parses into a *plausible*
	// document as readily as into a syntax error — a truncated one that happens to end after a
	// closing brace is valid JSON naming half the Layers.
	assertUndamaged(PROJECT_FILE_NAME, manifest, checksums);
	// Parsed, not merely present. The format refusal has to happen here rather than after the files
	// land: an imported zip is the likeliest way a Project from a newer version reaches an older build
	// at all. Its message is re-ended for this path, because "it has been left untouched" describes a
	// Project in the Workspace and there is none here — what the reader needs, and what every other
	// refusal on this path says, is that nothing arrived.
	const project = reendFormatRefusal(() => parseProjectFile(manifest));

	assertReferencesPresent(project, new Set(paths));

	const ordered = orderForWriting(paths);
	return {
		project,
		paths: ordered,
		totalBytes,
		files: () => inflateInBatches(archive, ordered, entries, checksums)
	};
}

/**
 * Run `read`, re-ending ADR-0010's refusal for the import path.
 *
 * The same class and the same `formatVersion`, so everything catching it still does; only the closing
 * sentence changes, from a promise about a local Project that does not exist to the one every other
 * refusal here makes.
 */
function reendFormatRefusal(read: () => ProjectFile): ProjectFile {
	try {
		return read();
	} catch (cause) {
		if (cause instanceof ProjectFormatTooNewError) {
			throw new ProjectFormatTooNewError(
				cause.formatVersion,
				BALLASTELLA_CANONICAL_URL,
				'Nothing has been imported.'
			);
		}
		throw cause;
	}
}

/**
 * `project.json` last.
 *
 * The Workspace's list of Projects *is* whichever directories hold a `project.json` (ADR-0008), so
 * an import interrupted half way — a closed laptop, a full disk — leaves a directory of orphaned
 * files rather than a Project that lists on the hub and opens with most of its Layers missing. The
 * first is litter; the second reads as the tool having eaten somebody's work.
 */
function orderForWriting(paths: readonly string[]): string[] {
	const rest = paths.filter((path) => path !== PROJECT_FILE_NAME).sort();
	return paths.includes(PROJECT_FILE_NAME) ? [...rest, PROJECT_FILE_NAME] : rest;
}

/**
 * Refuse an entry name that is not a plain relative path inside the Project.
 *
 * The store would refuse most of these too, but only at the moment of writing — by which point
 * earlier entries are already on disk. This is why the check lives in validation.
 */
function assertSafeEntryName(name: string): void {
	const reject = (why: string): never => {
		throw new ProjectZipRejectedError(
			'path-traversal',
			`This zip contains an entry that would not stay inside the Project: “${name}” ${why}.`
		);
	};

	if (name === '') reject('has no name');
	if (name.startsWith('/')) reject('is an absolute path');
	if (/^[A-Za-z]:/.test(name)) reject('is an absolute path with a drive letter');
	if (name.includes('\\')) reject('uses a backslash as a separator');
	// eslint-disable-next-line no-control-regex -- a control character in a filename is not a filename
	if (/[\u0000-\u001f\u007f]/.test(name)) reject('contains a control character');
	const segments = name.split('/');
	// A zip records a directory as an entry whose name ends in `/`, so its final empty segment is
	// legitimate. Any other empty segment is a `//` in the path.
	const named = segments.at(-1) === '' ? segments.slice(0, -1) : segments;
	for (const segment of named) {
		if (segment === '..') reject('climbs out of the Project directory');
		if (segment === '.') reject('contains a “.” segment');
		if (segment === '') reject('contains an empty path segment');
	}
	// The store's reserved suffix, checked here for the same reason as everything above it: the store
	// refuses it too, but only at the moment of writing — by which point the entries that sort before
	// it are on disk, `project.json` is not (it is written last), and the user has a directory they
	// cannot see on the hub, cannot delete, and cannot import over. The suffix marks a path `list`
	// hides, so an entry claiming one is asking to put a file in the Workspace that nothing there can
	// see — which is not something a Project zip has any reason to do.
	if (isTempPath(name)) reject(`uses the name Ballastella reserves for its own unfinished writes`);
}

/**
 * The files a Layer names, which the archive therefore has to carry.
 *
 * A Layer references its content and never contains it (ADR-0002), so this is where the references
 * are collected — from the union rather than by reading key names off an untyped object, so a kind
 * added later has to say here what it points at.
 *
 * A {@link ForeignLayer} — a kind this build has never heard of — is still asked about the two
 * reference names this application owns, because a Layer that carries an `alignmentRef` means by it
 * what every other Layer means. Nothing else about it is interpreted, which is the forward tolerance
 * ADR-0014 asks of the Layer list itself.
 */
function layerReferences(layer: Layer): readonly string[] {
	switch (layer.kind) {
		// **The Layer → Alignment → image link, followed without opening the Alignment.** An
		// Alignment's identity is its path, which is exactly why `parseAlignment` takes the image id
		// from the caller and never from the document's own `resource.id`; `mapLayerImageInfoPath`
		// reads it the same way. So the image a map Layer draws is named by `alignmentRef` itself, and
		// **no untrusted Annotation is parsed during validation** — which was the real reason ticket 13
		// deferred this, and the property `readProjectZip` is built on: it interprets nothing but
		// `project.json` before deciding to accept the archive.
		case 'map': {
			const info = mapLayerImageInfoPath(layer);
			return info === null ? [layer.alignmentRef] : [layer.alignmentRef, info];
		}
		case 'annotation':
			return [layer.geojsonRef];
		case 'foreign':
			return ['alignmentRef', 'geojsonRef']
				.map((key) => layer.unknownFields?.[key])
				.filter((reference): reference is string => typeof reference === 'string');
	}
}

/**
 * Refuse a zip whose `project.json` points at files it does not carry.
 *
 * **What this establishes.** Every file a Layer names is in the archive: its Alignment or its
 * GeoJSON, and — for a map Layer whose image is a local copy — the `info.json` that makes its
 * pyramid readable at all. That last one is the case that actually loses a reader's map: a Layer
 * pointing at an image directory the zip does not carry, which the structural check below cannot see
 * because there is no directory there to check.
 *
 * **What it does not establish, deliberately.** Nothing here opens an Alignment or a
 * `FeatureCollection`. The image is found through the Alignment's *path*, which is where its identity
 * lives; the document's own `resource.id` is not consulted, exactly as `parseAlignment` does not
 * consult it. So this cannot catch an Alignment whose contents name a different image service than
 * its filename does — and it should not try, because the filename is the authority in the reader too,
 * and because parsing a stranger's Annotation to decide whether to accept an archive would give up
 * the one property this whole path has: it interprets nothing but `project.json`. It also does not
 * check that a pyramid is *complete* — a tile that is missing is a blank square, not a lost map, and
 * only the tiler knows which tiles a level should have.
 *
 * A `'referenced'` image (ticket 14) claims no local pyramid at all, so none is looked for.
 */
function assertReferencesPresent(project: ProjectFile, present: ReadonlySet<string>): void {
	const missing = (reference: string, why: string): never => {
		throw new ProjectZipRejectedError(
			'missing-reference',
			`This zip is missing “${reference}”, which ${why}.`
		);
	};

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
	}

	// An image directory without its `info.json` is a heap of tiles no IIIF client can open
	// (ADR-0006's layout), so the pyramid is missing whether or not any Layer has been wired to it
	// yet. This is the other half of the pair: the loop above catches an image a Layer names and the
	// archive does not carry, and this one catches an image the archive carries incompletely.
	const imageDirectories = new Set<string>();
	for (const path of present) {
		const segments = path.split('/');
		if (segments[0] === 'images' && segments.length > 2) {
			imageDirectories.add(`${segments[0]}/${segments[1]}`);
		}
	}
	for (const directory of [...imageDirectories].sort()) {
		const info = `${directory}/info.json`;
		if (!present.has(info))
			missing(info, `the image directory “${directory}” needs to be readable`);
	}
}

/** Inflate the entries the filter accepts. Rejects rather than throwing synchronously. */
function inflate(archive: Bytes, filter: (entry: UnzipFileInfo) => boolean): Promise<Unzipped> {
	return new Promise((resolve, reject) => {
		try {
			unzip(archive, { filter }, (error, unzipped) => {
				if (!error) return resolve(unzipped);
				reject(
					error instanceof ProjectZipRejectedError
						? error
						: new ProjectZipRejectedError(
								'not-a-zip',
								`This file could not be read as a zip archive: ${error.message}.`
							)
				);
			});
		} catch (cause) {
			// fflate raises a malformed central directory synchronously.
			reject(
				cause instanceof ProjectZipRejectedError
					? cause
					: new ProjectZipRejectedError(
							'not-a-zip',
							`This file could not be read as a zip archive: ${
								cause instanceof Error ? cause.message : String(cause)
							}.`
						)
			);
		}
	});
}

/**
 * Refuse an entry whose bytes are not the bytes the archive says they are.
 *
 * **A length check cannot do this job.** fflate takes each entry's *declared* uncompressed size and
 * uses it as the output buffer; because the buffer is caller-supplied it is never grown, writes past
 * its end are a silent no-op on a typed array, and what comes back is clamped to exactly the length
 * that was declared. So an archive claiming a 5,000-byte file is 100 bytes long yields 100 bytes,
 * with no error, and a length check finds the length it expected. Only the CRC-32 the zip already
 * carries can see it, and neither fflate nor anything else here reads that field otherwise.
 *
 * It matters most for the part of a Project that is not deflated at all: tiles are JPEG, so export
 * stores them rather than compressing them, and a stored entry has no deflate stream whose
 * corruption could raise an error. For the bulk of a real Project, CRC-32 is the *only* integrity
 * check the zip format offers.
 */
function assertUndamaged(path: string, bytes: Bytes, checksums: ReadonlyMap<string, number>): void {
	const declared = checksums.get(path);
	if (declared !== undefined && crc32(bytes) === declared) return;
	throw new ProjectZipRejectedError(
		'damaged-entry',
		`“${path}” in this zip does not match the checksum the zip records for it, so this archive ` +
			`is damaged or was altered after it was made. Ask for it again.`
	);
}

/**
 * The Project's files, inflated a bounded batch at a time and in the order given.
 *
 * Each batch is checked against its checksums as it is inflated rather than the whole archive being
 * verified up front, which would mean inflating everything twice — once to check and once to write.
 * On a mirrored pyramid of several hundred megabytes that doubles the slowest part of the import for
 * a machine whose browser is the only place that Project lives (ADR-0001), and it would defeat the
 * "compressed archive plus one batch" memory bound this batching exists for.
 *
 * The cost of that choice is that a damaged entry is found *after* earlier ones have been written,
 * so this is only safe because `Workspace.importProject` rolls back what it wrote. The two decisions
 * are one decision: verify late, and undo.
 */
async function* inflateInBatches(
	archive: Bytes,
	paths: readonly string[],
	entries: readonly UnzipFileInfo[],
	checksums: ReadonlyMap<string, number>
): AsyncIterable<TransferFile> {
	const sizeOf = new Map(entries.map((entry) => [entry.name, entry.originalSize]));

	for (let from = 0; from < paths.length;) {
		let to = from;
		let bytes = 0;
		while (to < paths.length) {
			// At least one entry per batch, however large that one entry is on its own.
			if (to > from && (to - from >= BATCH_ENTRIES || bytes >= BATCH_BYTES)) break;
			const path = paths[to];
			if (path === undefined) break;
			bytes += sizeOf.get(path) ?? 0;
			to += 1;
		}

		const wanted = new Set(paths.slice(from, to));
		const batch = await inflate(archive, (entry) => wanted.has(entry.name));
		for (const path of paths.slice(from, to)) {
			const inflated = batch[path];
			if (!inflated) {
				throw new ProjectZipRejectedError(
					'not-a-zip',
					`“${path}” is listed in this zip but its contents could not be read.`
				);
			}
			assertUndamaged(path, inflated, checksums);
			yield { path, bytes: inflated };
		}
		from = to;
	}
}

// Reading the archive's own index, which fflate's `UnzipFileInfo` does not expose the checksum from
// and which fflate never verifies. Deliberately the smallest walk that answers one question — what
// CRC-32 does this archive claim for each entry? — rather than a second zip parser: every offset
// below is fixed by the format and none of them moves under zip64, whose only effect here is that
// the archive is refused for being one this reader will not vouch for.

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP64_LOCATOR = 0x07064b50;
/** The largest number of entries a zip's 16-bit count can express without zip64. */
const MAX_COUNTABLE_ENTRIES = 65535;
/** A zip's trailing comment is at most 64 KiB, so the end record is within this of the tail. */
const END_RECORD_SEARCH = 65558;

const u32 = (d: Uint8Array, at: number): number =>
	(((d[at] as number) |
		((d[at + 1] as number) << 8) |
		((d[at + 2] as number) << 16) |
		((d[at + 3] as number) << 24)) >>>
		0) as number;

const u16 = (d: Uint8Array, at: number): number =>
	((d[at] as number) | ((d[at + 1] as number) << 8)) as number;

/**
 * Every entry's declared CRC-32, keyed by name, or `null` for an archive this cannot vouch for.
 *
 * `null` rather than a throw so the caller owns the message. It happens for an archive with no
 * readable end record, for one using zip64 — which fflate's *writer* cannot produce, so no export of
 * ours is ever one — and for one whose index does not agree with itself.
 */
function readChecksums(archive: Bytes): Map<string, number> | null {
	if (archive.length < 22) return null;
	let end = archive.length - 22;
	const floor = Math.max(0, archive.length - END_RECORD_SEARCH);
	while (u32(archive, end) !== END_OF_CENTRAL_DIRECTORY) {
		end -= 1;
		if (end < floor) return null;
	}
	// A zip64 locator sits immediately before the end record, and its presence means the counts and
	// offsets in that record may be placeholders. Refused rather than followed: our own exports are
	// never zip64 (fflate writes 16-bit counts and 32-bit offsets and nothing else), so the only
	// archives this turns away are ones from another tool that are larger than this reader will
	// vouch for — which is a legible refusal rather than an unverified import.
	if (end >= 20 && u32(archive, end - 20) === ZIP64_LOCATOR) return null;

	const count = u16(archive, end + 10);
	if (count === MAX_COUNTABLE_ENTRIES) return null;
	let at = u32(archive, end + 16);

	const checksums = new Map<string, number>();
	for (let seen = 0; seen < count; seen += 1) {
		if (at + 46 > archive.length || u32(archive, at) !== CENTRAL_FILE_HEADER) return null;
		const nameLength = u16(archive, at + 28);
		const extraLength = u16(archive, at + 30);
		const commentLength = u16(archive, at + 32);
		const nameEnd = at + 46 + nameLength;
		if (nameEnd > archive.length) return null;
		const name = new TextDecoder('utf-8').decode(archive.subarray(at + 46, nameEnd));
		// Two records under one name would let the second's checksum vouch for the first's bytes.
		if (checksums.has(name)) return null;
		checksums.set(name, u32(archive, at + 16));
		at = nameEnd + extraLength + commentLength;
	}
	return checksums;
}

const CRC_TABLE = /* @__PURE__ */ (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

/** CRC-32 as the zip format defines it: the IEEE polynomial, reflected, pre- and post-inverted. */
function crc32(bytes: Uint8Array): number {
	let crc = -1;
	for (let at = 0; at < bytes.length; at += 1) {
		crc = (CRC_TABLE[(crc ^ (bytes[at] as number)) & 0xff] as number) ^ (crc >>> 8);
	}
	return (crc ^ -1) >>> 0;
}

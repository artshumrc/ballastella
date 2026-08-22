// A Project Bundle, offered as a read-only Import source (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO PASSES, BECAUSE A TAR HAS NO INDEX AND A CLOSURE MUST BE VALIDATED BEFORE IT IS INSTALLED
//
// `openProjectBundle` writes as it reads and validates the references afterwards, which is safe there
// for one reason only: the destination is a Review Workspace made moments earlier and thrown away if
// the check fails. An Import has no such destination — the Workspace it copies into is the user's own
// and full of their work — so ADR-0037 requires the closure to be validated *before* a destination
// path is allocated, and a tar cannot answer "what is in you" until it has ended.
//
// So this walks the archive twice:
//
//  1. **Headers only.** Every entry's name is checked, `project.json` is buffered and parsed, and the
//     declared sizes are collected. Bodies are cancelled rather than read, so a 2 GB bundle costs one
//     manifest in memory and a list of names.
//  2. **Bodies, for the closure.** Reopened from the caller's own factory and streamed, one file at a
//     time, so peak memory is one file rather than one archive — the bound tar was chosen for.
//
// ⚠ **Which is why the archive is taken as a factory rather than as a stream.** A `ReadableStream`
// can be read once. A `File` the user picked can be `stream()`ed as many times as it takes, and the
// caller is the only thing that knows how to produce another one.

import { createTarDecoder } from 'modern-tar';

import { PROJECT_FILE_NAME, type ProjectFile } from '../project/project-file.js';
import { describeBytes } from '../project/workspace-size.js';
import { REMOTE_BINDING_PATH } from '../remote/remote-binding.js';
import type { Bytes } from '../store/project-store.js';
import { BUNDLE_LIMITS, type BundleLimits } from './open-project-bundle.js';
import {
	ImportSourceRefusedError,
	createProjectImportSource,
	parseImportedProjectFile,
	type ClosureFile,
	type ClosurePath,
	type OfferedFile,
	type ProjectImportSource
} from './project-import-source.js';

/** How to read the bundle, and what the user called it. */
export interface ProjectBundleSourceOptions {
	/**
	 * The name of the file the user picked, for the provenance the Import engine records.
	 *
	 * Untrusted and never used as a path: the closure's paths all come out of the archive, and a
	 * Project's identity is the directory the *reader* chooses (ADR-0008).
	 */
	readonly fileName?: string;
	/** Bounds to apply instead of {@link BUNDLE_LIMITS}, so the refusals are provokable in a test. */
	readonly limits?: Partial<BundleLimits>;
}

/**
 * Read a Project Bundle as a validated Import source.
 *
 * @param openArchive produces a fresh stream over the same bundle each time it is called
 * @throws ImportSourceRefusedError for anything wrong with the archive or the Project in it
 * @throws ProjectFormatTooNewError for a Project from a newer version of the app (ADR-0010)
 */
export async function readProjectBundleSource(
	openArchive: () => ReadableStream<Uint8Array>,
	options: ProjectBundleSourceOptions = {}
): Promise<ProjectImportSource> {
	const limits = { ...BUNDLE_LIMITS, ...options.limits };
	const { offered, projectFileBytes } = await listArchive(openArchive(), limits);
	if (projectFileBytes === null) {
		throw new ImportSourceRefusedError(
			'no-project-file',
			`This file has no ${PROJECT_FILE_NAME} at its root, so it is not a Ballastella Project ` +
				`bundle. A bundle holds one Project, with ${PROJECT_FILE_NAME} at the top; a whole ` +
				`Workspace backup is a different file and is restored from Workspace settings.`
		);
	}
	const project: ProjectFile = parseImportedProjectFile(projectFileBytes);

	return createProjectImportSource({
		origin: {
			kind: 'project-bundle',
			fileName: options.fileName ?? '',
			projectName: project.name
		},
		project,
		projectFileBytes,
		offered,
		files: (paths) => drain(openArchive(), paths)
	});
}

interface ArchiveListing {
	readonly offered: readonly OfferedFile[];
	readonly projectFileBytes: Bytes | null;
}

/**
 * The archive's entries, by name and declared length, with `project.json` read.
 *
 * ⚠ **A repeated entry name and an unsafe one are refused by `createProjectImportSource` rather than
 * here.** They are properties of the path set, not of tar, and the Review path already spells them its
 * own way; a third spelling in this module is how a bundle and a published tree come to disagree about
 * the same file. What this pass owes them is an honest list — every name the archive held, once each —
 * which is why a second `project.json` is not allowed to replace the first on the way past.
 *
 * ⚠ **A root `remote.json` is dropped rather than offered.** An imported Project retains no Remote
 * relationship at all (ADR-0037), and a Workspace binding is not part of a Project's closure.
 * `images/<id>/remote.json` is a different document — a referenced IIIF image's own record
 * (ADR-0007) — and is exactly what a Project with a referenced Map Image needs to be readable.
 */
async function listArchive(
	archive: ReadableStream<Uint8Array>,
	limits: BundleLimits
): Promise<ArchiveListing> {
	const offered: OfferedFile[] = [];
	let projectFileBytes: Bytes | null = null;
	let entries = 0;

	for await (const entry of decode(archive)) {
		const { header, body } = entry;
		if (header.type === 'directory' || header.name.endsWith('/')) {
			await body.cancel();
			continue;
		}
		entries += 1;
		if (entries > limits.entries) {
			throw new ImportSourceRefusedError(
				'incomplete',
				`This bundle holds more than ${limits.entries} files, which is more than one Project is. ` +
					`It has not been read further.`
			);
		}
		if (header.name === REMOTE_BINDING_PATH) {
			await body.cancel();
			continue;
		}

		// The **first** `project.json`, and only the first. An archive carrying two is refused as a
		// repeated path like any other, by the one check that decides that — but the manifest has to be
		// parsed to gather a closure at all, so the second one must not silently replace it in the
		// meantime.
		if (header.name === PROJECT_FILE_NAME && projectFileBytes === null) {
			const content = await collect(body);
			if (content.length > limits.manifestBytes) {
				throw new ImportSourceRefusedError(
					'malformed-project-file',
					`The ${PROJECT_FILE_NAME} in this bundle is ${describeBytes(content.length)}, and a ` +
						`${PROJECT_FILE_NAME} is a short manifest rather than a document of that size.`
				);
			}
			projectFileBytes = content;
			offered.push({ path: header.name, bytes: content.length });
			continue;
		}

		// The header's own figure, and the body is cancelled rather than measured. It is what a quota
		// check needs — a tar compresses nothing, so a declared length is an honest bound — and reading
		// every body here would make this pass as expensive as the one that actually delivers the files.
		offered.push({ path: header.name, bytes: header.size ?? 0 });
		await body.cancel();
	}

	return { offered, projectFileBytes };
}

/** The closure's files, from a second pass over the archive. */
async function* drain(
	archive: ReadableStream<Uint8Array>,
	paths: readonly ClosurePath[]
): AsyncIterable<ClosureFile> {
	const wanted = new Set<ClosurePath>(paths);
	for await (const { header, body } of decode(archive)) {
		if (!wanted.delete(header.name)) {
			await body.cancel();
			continue;
		}
		yield { path: header.name, bytes: await collect(body) };
		if (wanted.size === 0) return;
	}
}

type TarEntry = {
	header: { name: string; type?: string; size?: number };
	body: ReadableStream<Uint8Array>;
};

/** The archive's entries, with the tar parser's own failures said as source refusals. */
async function* decode(archive: ReadableStream<Uint8Array>): AsyncIterable<TarEntry> {
	const reader = (
		archive.pipeThrough(createTarDecoder({ strict: true })) as ReadableStream<TarEntry>
	).getReader();
	try {
		for (;;) {
			let next: ReadableStreamReadResult<TarEntry>;
			try {
				next = await reader.read();
			} catch (cause) {
				asRefusal(cause);
			}
			if (next.done) return;
			yield next.value;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

/**
 * One entry's body, into one buffer.
 *
 * Where "streaming" stops, and the bound bought is about the *archive* rather than each file: peak
 * memory while reading a bundle is one file, which is what makes a large bundle readable on an iPad.
 * The declared size is not trusted as a length — what is collected is what arrived, and a disagreement
 * between the two is a truncated archive, which `modern-tar` raises rather than papering over.
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
		// An archive that ends in the middle of an entry fails here rather than at the header, and it is
		// the likeliest place a half-finished download actually stops.
		asRefusal(cause);
	}
	const out = new Uint8Array(new ArrayBuffer(length)) as Bytes;
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

/**
 * Everything the tar parser can say, said as a refusal instead.
 *
 * The word "truncated" is kept when the parser used it: a bundle is a file that has *travelled*, so a
 * download that stopped is its likeliest damage, and knowing the file is incomplete rather than wrong
 * tells the user to ask for it again.
 */
function asRefusal(cause: unknown): never {
	if (cause instanceof ImportSourceRefusedError) throw cause;
	const detail = cause instanceof Error ? cause.message.replace(/\.$/, '') : String(cause);
	throw new ImportSourceRefusedError(
		'incomplete',
		`This file could not be read as a Ballastella Project bundle: ${detail}. A bundle is the ` +
			`“.project.tar” file the Export button produces; if this is one, it may not have downloaded ` +
			`completely, in which case ask for it again.`
	);
}

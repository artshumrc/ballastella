// One real ingest, captured once and written straight into OPFS for every test that needs a
// Project with a Map Image already on disk.
//
// ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY: SIXTY-THREE TESTS EACH BUILT THE SAME PYRAMID, THROUGH THE INTERFACE, IN A BROWSER.     │
// └─────────────────────────────────────────────────────────────────────────────────────────────┘
//
// `alignment-workspace.ts`'s `start()` used to drive the whole thing per test: create a Project
// through the dialog, pick a 700 × 500 PNG through the real file input, wait while the browser
// decoded it and encoded nine JPEG tiles into OPFS, then wait again for every tile of the first
// view to decode — an allowance of thirty seconds, which is why fourteen tests in
// `editor-undo.e2e.ts` and ten in `editor-align-route.e2e.ts` carried hand-raised budgets of ninety
// to a hundred and eighty seconds. None of those tests is about ingesting an image. They are about
// undo, about routes, about Control Points; the pyramid is scenery, and every one of them paid to
// build it again.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY A CAPTURE RATHER THAN A HAND-WRITTEN FIXTURE
//
// The obvious alternative is to write the files out as literals, the way `reader-project.ts` does
// for the Reader suite. That works there because a Published Site's files are ours: `project.json`,
// GeoJSON, an `info.json` whose every field this repository decides.
//
// It does not reach here. A starter Alignment's bytes come out of `@allmaps/annotation`'s
// `generateAnnotation`, through `serialiseAlignment`'s plain-decimal mask rewrite and upstream's own
// validator. A literal of that is a guess about somebody else's output format, and the failure mode
// is the bad one: a fixture that parses but is not what the app writes, so every byte-identity
// assertion in `editor-undo.e2e.ts` compares the app's output against a fixture rather than against
// itself, and passes while agreeing about nothing.
//
// Building the fixture from `core`'s own functions has the mirror-image fault and is the reason
// `reader-project.ts` writes literals: a fixture and an application that share a code path agree
// however wrong both are.
//
// **So the fixture is a recording.** The first test through in a cold worker performs the real
// ingest, through the real interface, exactly as before; the files it produced are read back out of
// OPFS and kept. Every test after it — in that worker, and in every later run — gets those bytes.
// They are by construction what this build's ingest produces, so nothing a test asserts about them
// changes meaning, and they cannot drift: the recording is keyed to the build fingerprint and a
// changed build discards it.
//
// ⚠ **A test whose subject IS the ingest must not use this.** `editor-image-ingest.e2e.ts` and the
// ingest half of `editor-add-map-image.e2e.ts` drive `pickMapImageFile` directly and
// should go on doing so — they are the tests that keep the recording honest, and if they are ever
// deleted this module starts asserting that a pyramid captured in 2026 still loads rather than that
// this build can make one.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from './test.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Beside `scripts/e2e-build.mjs`'s own cache, and keyed to the same fingerprint it writes there.
 *
 * `node_modules/.cache/` because it is already ignored and already the place a derived artifact of
 * this suite lives, so a recording cannot be committed by accident and `pnpm install --force` clears
 * it along with everything else derived.
 */
const cacheDirectory = path.join(repoRoot, 'node_modules/.cache/ballastella-e2e');
const buildStampFile = path.join(cacheDirectory, 'build-stamp.json');

/** One captured Workspace: the ids the app minted, and every file it wrote. */
export type WorkspaceSnapshot = {
	/** The image id the ingest minted. An Alignment's file name. */
	readonly imageId: string;
	/** The id of the Layer the Map Image arrived with (ADR-0023). */
	readonly layerId: string;
	/** Workspace-relative path to base64 bytes, in the order they were walked. */
	readonly files: readonly (readonly [string, string])[];
};

/**
 * What the recording is keyed to: the build it was made against.
 *
 * `scripts/e2e-build.mjs` already computes a SHA-256 over every build input and leaves it in
 * `build-stamp.json`, so a change to the tiler, to `serialiseAlignment`, or to the Project screen
 * that leads to it all move this. Reused rather than recomputed — a second walk of the same inputs
 * is a second thing to keep in agreement, and this one has to be *exactly* as sensitive as the build
 * or a stale recording survives a rebuild.
 *
 * An absent stamp means the build was not made through that script, which is not a state this suite
 * runs in; `'unstamped'` keeps the recording usable within one process and stops it being trusted
 * across runs.
 */
const buildFingerprint = (): string => {
	try {
		const stamp: unknown = JSON.parse(readFileSync(buildStampFile, 'utf8'));
		const value = (stamp as { fingerprint?: unknown })?.fingerprint;
		return typeof value === 'string' ? value : 'unstamped';
	} catch {
		return 'unstamped';
	}
};

const cacheFile = (name: string): string =>
	path.join(
		cacheDirectory,
		`snapshot-${name}-${createHash('sha256').update(buildFingerprint()).digest('hex').slice(0, 16)}.json`
	);

/**
 * The recording for `name` made against this build, or `null`.
 *
 * Per worker process as well as per disk: a Playwright worker runs many tests in one process, and
 * re-reading and re-parsing a few hundred kilobytes of base64 for each of them is work this exists
 * to remove.
 */
const memo = new Map<string, WorkspaceSnapshot>();

const readSnapshot = (name: string): WorkspaceSnapshot | null => {
	const held = memo.get(name);
	if (held) return held;
	const file = cacheFile(name);
	if (!existsSync(file)) return null;
	try {
		const snapshot = JSON.parse(readFileSync(file, 'utf8')) as WorkspaceSnapshot;
		memo.set(name, snapshot);
		return snapshot;
	} catch {
		// A truncated recording is a recording to remake, not a run to fail. This is the one case
		// where silence is right: the caller's fallback is the real ingest, which is correct however
		// this file got damaged.
		return null;
	}
};

/**
 * Keep `snapshot` for later runs.
 *
 * Written to a unique temporary name and renamed into place, because four workers may finish their
 * first ingest at once and `rename` is the primitive that makes the loser's write invisible rather
 * than interleaved. The bytes are equivalent whoever wins — same build, same fixture image — so
 * there is nothing to arbitrate beyond not leaving a half-written file where a reader will find it.
 */
const writeSnapshot = (name: string, snapshot: WorkspaceSnapshot): void => {
	try {
		mkdirSync(cacheDirectory, { recursive: true });
		const file = cacheFile(name);
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(snapshot));
		renameSync(temporary, file);
		memo.set(name, snapshot);
	} catch {
		// A run that cannot write its cache is a slow run, not a failed one.
	}
};

/**
 * Every file in the open Workspace, as base64.
 *
 * The **open** Workspace rather than the OPFS root: the root holds Workspaces, and `workspaceRoot()`
 * is the suite's one answer to which of them the app is looking at.
 */
export async function captureWorkspace(page: Page): Promise<(readonly [string, string])[]> {
	return page.evaluate(async () => {
		const out: [string, string][] = [];
		const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			const entries: [string, FileSystemHandle][] = [];
			for await (const entry of directory.entries()) entries.push(entry);
			// Sorted, so a recording is stable across runs and a diff of two of them is readable.
			entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
			for (const [name, handle] of entries) {
				const at = prefix ? `${prefix}/${name}` : name;
				if (handle.kind === 'directory') {
					await walk(handle as FileSystemDirectoryHandle, at);
					continue;
				}
				const file = await (handle as FileSystemFileHandle).getFile();
				const bytes = new Uint8Array(await file.arrayBuffer());
				let binary = '';
				for (const byte of bytes) binary += String.fromCharCode(byte);
				out.push([at, btoa(binary)]);
			}
		};
		await walk(await workspaceRoot(), '');
		return out;
	});
}

/**
 * Write `files` into the open Workspace, creating every directory on the way.
 *
 * One `evaluate` for the whole set rather than one per file: the round trip is the cost here, not
 * the write, and a nine-tile pyramid seeded file-by-file would spend more time crossing the
 * protocol boundary than the ingest it replaces.
 */
export async function restoreWorkspace(
	page: Page,
	files: readonly (readonly [string, string])[]
): Promise<void> {
	await page.evaluate(async (entries: readonly (readonly [string, string])[]) => {
		const root = await workspaceRoot();
		for (const [at, base64] of entries) {
			const segments = at.split('/');
			let directory = root;
			for (const segment of segments.slice(0, -1)) {
				directory = await directory.getDirectoryHandle(segment, { create: true });
			}
			const handle = await directory.getFileHandle(segments.at(-1) as string, { create: true });
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
			const writable = await handle.createWritable();
			await writable.write(bytes);
			await writable.close();
		}
	}, files);
}

/**
 * The recording called `name`, making it with `capture` if this build has none.
 *
 * `capture` is handed the page it should build the Workspace in, and returns the two ids the app
 * minted while doing so. It runs at most once per worker process and, once the cache is warm, not
 * at all.
 */
export async function snapshotWorkspace(
	page: Page,
	name: string,
	capture: (page: Page) => Promise<{ imageId: string; layerId: string }>
): Promise<WorkspaceSnapshot> {
	const held = readSnapshot(name);
	if (held) return held;

	const { imageId, layerId } = await capture(page);
	const snapshot: WorkspaceSnapshot = { imageId, layerId, files: await captureWorkspace(page) };
	writeSnapshot(name, snapshot);
	return snapshot;
}

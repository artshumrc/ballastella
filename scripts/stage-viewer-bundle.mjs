#!/usr/bin/env node
// Put the built read-only viewer inside the editor, so that Publish has something to write.
//
// ADR-0006: publishing writes an `index.html` and the viewer's files into the user's Workspace.
// The editor therefore has to *hold* those bytes at runtime, and the only place a static app can
// hold bytes is among its own served assets. So this copies `apps/viewer/build` into
// `apps/editor/static/viewer-bundle/` before the editor is bundled, and writes an index beside it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY A COPY UNDER A DIRECTORY, AND NOT SOMETHING CLEVERER
//
// The viewer is a **separate, lean build** (ADR-0019), which rules out importing its modules into
// the editor's graph — that is exactly how every published site comes to ship `terra-draw`, the
// tiler, and five megabytes of `wasm-vips`. It cannot go at the editor's asset root either, because
// its `index.html` would collide with the editor's own page. And it must be *staged*, not merely
// present in `apps/viewer/build`, because Vite copies `static/` during the build and SvelteKit's
// `vite preview` serves what the build produced — a path outside the editor's assets is not served
// at all, which is a Publish button that fetches 404s.
//
// The index records, per file, where the editor serves it from and where publishing puts it. Those
// differ (`viewer-bundle/index.html` → `index.html`) and getting them the wrong way round writes the
// *authoring app* into the Workspace as the Published Site's front page, which is why the mapping is
// recorded rather than reconstructed at either end.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE BASE MAP FILES ARE LISTED, NOT COPIED
//
// A Published Site may carry the glyphs and sprites used by its Base Map styles (ADR-0020). The
// editor already serves those for its own panes, so
// they are listed with their byte lengths and left where they are: copying them would double them in
// every deployment of the editor to no purpose. Their `source` and their published `path` are the
// same, which is why the mapping above matters only for the viewer's own files.
//
// This script deliberately names no catalog entry id and no archive by name — it stages a directory
// — so `scripts/check-base-map-catalog.mjs` stays satisfied and a fork repointing its catalog does
// not have to edit this file (ADR-0020).

import { createHash } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const viewerBuild = path.join(repoRoot, 'apps/viewer/build');
const editorStatic = path.join(repoRoot, 'apps/editor/static');
/** Where the staged viewer lives among the editor's assets, and the `source` prefix it gets. */
const stagedDirectory = 'viewer-bundle';
/** The Base Map's deployment assets, whose published path is the same as their served path. */
const baseMapDirectory = 'base-map';
const indexName = 'bundle.json';

if (!existsSync(viewerBuild)) {
	console.error(
		`\nThere is no ${path.relative(repoRoot, viewerBuild)} to stage, so the editor would build ` +
			`with nothing for Publish to write (ADR-0006).\n\nRun: pnpm --filter @ballastella/viewer ` +
			`run build\n`
	);
	process.exit(1);
}

/** Every file under `directory`, as paths relative to it, sorted. */
function filesUnder(directory) {
	const found = [];
	const walk = (current, prefix) => {
		for (const entry of readdirSync(current).sort()) {
			const full = path.join(current, entry);
			const relative = prefix === '' ? entry : `${prefix}/${entry}`;
			if (statSync(full).isDirectory()) walk(full, relative);
			else found.push(relative);
		}
	};
	walk(directory, '');
	return found.sort();
}

const staged = path.join(editorStatic, stagedDirectory);
// Removed first, so a chunk that no longer exists in the viewer cannot survive as a stale file that
// the index does not name and publishing therefore never overwrites.
rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });
cpSync(viewerBuild, staged, { recursive: true });

const viewerFiles = filesUnder(staged).map((relative) => ({
	path: relative,
	source: `${stagedDirectory}/${relative}`,
	bytes: statSync(path.join(staged, relative)).size
}));

if (!viewerFiles.some((file) => file.path === 'index.html')) {
	console.error(
		`\n${path.relative(repoRoot, viewerBuild)} contains no index.html, so there is no Published ` +
			`Site to write. Has the viewer's adapter changed?\n`
	);
	process.exit(1);
}

const baseMapRoot = path.join(editorStatic, baseMapDirectory);
const baseMapFiles = existsSync(baseMapRoot)
	? filesUnder(baseMapRoot)
			// Provenance and licence prose belongs in the repository, not in every user's Workspace.
			.filter((relative) => !relative.endsWith('.md'))
			.map((relative) => ({
				path: `${baseMapDirectory}/${relative}`,
				source: `${baseMapDirectory}/${relative}`,
				bytes: statSync(path.join(baseMapRoot, relative)).size
			}))
	: [];

/**
 * The version stamp (ADR-0006): a hash over the viewer's own files and their contents.
 *
 * Content-addressed rather than a build timestamp, so that re-publishing an unchanged viewer leaves
 * the stamp alone and "is this Published Site's viewer out of date?" does not answer yes every time
 * anybody rebuilds. Over the viewer's files only — the Base Map is an optional extra rather than
 * part of the viewer's identity.
 */
const stamp = createHash('sha256');
for (const file of viewerFiles) {
	stamp.update(file.path);
	stamp.update('\0');
	stamp.update(
		createHash('sha256')
			.update(readFileSync(path.join(staged, file.path)))
			.digest()
	);
}

const bundle = {
	version: stamp.digest('hex').slice(0, 16),
	files: viewerFiles,
	baseMap: baseMapFiles
};

// Beside the staged files rather than inside the list, so the index is not itself published.
writeFileSync(path.join(staged, indexName), `${JSON.stringify(bundle, null, '\t')}\n`);

const total = [...viewerFiles, ...baseMapFiles].reduce((sum, file) => sum + file.bytes, 0);
console.log(
	`Staged the read-only viewer for publishing: ${viewerFiles.length} files, ` +
		`${baseMapFiles.length} Base Map files, ${(total / 1e6).toFixed(1)} MB, ` +
		`version ${bundle.version}.`
);

#!/usr/bin/env node

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
const stagedDirectory = 'viewer-bundle';
const baseMapDirectory = 'base-map';
const indexName = 'bundle.json';

if (!existsSync(viewerBuild)) {
	console.error(
		`\nThere is no ${path.relative(repoRoot, viewerBuild)} to stage, so the editor would build ` +
			`with nothing for Share Links to write (ADR-0045).\n\nRun: pnpm --filter @ballastella/viewer ` +
			`run build\n`
	);
	process.exit(1);
}

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
		`\n${path.relative(repoRoot, viewerBuild)} contains no index.html, so there is no site ` +
			`to write. Has the viewer's adapter changed?\n`
	);
	process.exit(1);
}

const baseMapRoot = path.join(editorStatic, baseMapDirectory);
const baseMapFiles = existsSync(baseMapRoot)
	? filesUnder(baseMapRoot)
			.filter((relative) => !relative.endsWith('.md'))
			.map((relative) => ({
				path: `${baseMapDirectory}/${relative}`,
				source: `${baseMapDirectory}/${relative}`,
				bytes: statSync(path.join(baseMapRoot, relative)).size
			}))
	: [];

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

writeFileSync(path.join(staged, indexName), `${JSON.stringify(bundle, null, '\t')}\n`);
const total = [...viewerFiles, ...baseMapFiles].reduce((sum, file) => sum + file.bytes, 0);
console.log(
	`Staged the read-only viewer for Share Links: ${viewerFiles.length} files, ` +
		`${baseMapFiles.length} Base Map files, ${(total / 1e6).toFixed(1)} MB, ` +
		`version ${bundle.version}.`
);

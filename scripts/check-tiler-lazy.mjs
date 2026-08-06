#!/usr/bin/env node
// ADR-0019, the half `check-viewer-deps.mjs` cannot see: `wasm-vips` must be reachable **only**
// through a dynamic import, and the tiler must not reach `apps/viewer` at all.
//
// This replaces an acceptance command that could not fail. Ticket 05 shipped
//
//   grep -rl "wasm-vips" apps/editor/build/_app/immutable/entry/ && echo "FAIL: eager" || echo "OK: lazy"
//
// which printed `OK: lazy` unconditionally: the string `wasm-vips` is a module specifier that
// bundling resolves away, so it appears nowhere in the build at all, and the command also looked
// only at `entry/` rather than at the chunks the entry statically imports. A fence that passes
// whatever the code does is worse than no fence, because it is read as evidence.
//
// Two layers, because neither is sufficient:
//
// **Source.** A static `import Vips from 'wasm-vips'` anywhere in `apps/editor/src` defeats the
// laziness before a bundler is involved, and `packages/core/src` must not name the package at all
// — the streaming tiler takes its module through an injected loader precisely so that
// `apps/viewer`, which depends on `@ballastella/core`, cannot acquire it. Checked without a build,
// so it runs in `pnpm lint`.
//
// **Built output.** The bundler is what decides whether a lazy import stays in its own chunk, and
// ADR-0019 exists to say that tree-shaking is not a boundary. So the built editor's chunk graph is
// checked too: no chunk may *statically* import a `wasm-vips` chunk, and at least one must import
// it dynamically. And the built viewer is checked for the tiler's own string literals, so the
// claim "the viewer carries no tiler" stops resting on the bundler's goodwill.
//
// The built layer runs only when the build output is present, and `--require-build` makes its
// absence fatal — which is what CI passes, after `pnpm -r build`. `pnpm lint` does not build, and a
// check that quietly skips when its input is missing is the defect above.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireBuild = process.argv.includes('--require-build');

const problems = [];
const fail = (message) => problems.push(message);

/** Every file under `directory` matching `test`, recursively. */
function filesUnder(directory, test) {
	if (!existsSync(directory)) return [];
	const found = [];
	const walk = (current) => {
		for (const entry of readdirSync(current)) {
			const full = path.join(current, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (test(full)) found.push(full);
		}
	};
	walk(directory);
	return found;
}

const relative = (file) => path.relative(repoRoot, file);

/**
 * The module specifiers `source` imports **statically**, and those it imports **dynamically**.
 *
 * Regexes rather than a parser, and they can afford to be: both inputs are either this
 * repository's own TypeScript, where the import forms are conventional, or Rollup output, where
 * every static import is a statement at the top of the file. The clause pattern is deliberately
 * narrow — only the characters an import clause may contain — so that prose inside a template
 * literal cannot be mistaken for an import.
 *
 * Backticks count as quotes: Rollup emits `import(`./chunk.js`)` for a dynamic import, and a
 * pattern that only knew about `'` and `"` found no lazy import anywhere in the build.
 */
function importsIn(source) {
	const statik = [];
	const dynamic = [];

	const clause = /(?:^|[;}\n])\s*(?:import|export)[\w$*,{}\s]*from\s*["'`]([^"'`]+)["'`]/g;
	const bare = /(?:^|[;}\n])\s*import\s*["'`]([^"'`]+)["'`]/g;
	const lazy = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

	for (const [pattern, into] of [
		[clause, statik],
		[bare, statik],
		[lazy, dynamic]
	]) {
		for (const match of source.matchAll(pattern)) into.push(match[1]);
	}

	return { statik, dynamic };
}

// ── Source: who is allowed to name `wasm-vips` ────────────────────────────────────────────────

const isTest = (file) => /\.test\.ts$/.test(file);
const sourceFiles = (directory) =>
	filesUnder(path.join(repoRoot, directory), (file) => /\.(ts|svelte|js)$/.test(file));

let dynamicVipsImports = 0;

for (const file of sourceFiles('packages/core/src')) {
	if (isTest(file)) continue;
	const source = readFileSync(file, 'utf8');
	const { statik, dynamic } = importsIn(source);
	for (const specifier of [...statik, ...dynamic]) {
		if (/^wasm-vips(\/|$)/.test(specifier)) {
			fail(
				`${relative(file)} imports ${specifier}. Nothing under packages/core/src may, not even ` +
					`for its types: apps/viewer depends on @ballastella/core, and the streaming tiler takes ` +
					`its module through an injected loader so that it cannot follow (ADR-0019).`
			);
		}
	}
}

for (const file of sourceFiles('apps/editor/src')) {
	if (isTest(file)) continue;
	const { statik, dynamic } = importsIn(readFileSync(file, 'utf8'));
	for (const specifier of statik) {
		if (/^wasm-vips(\/|$)/.test(specifier)) {
			fail(
				`${relative(file)} imports ${specifier} statically. It must be reached only by ` +
					`await import('wasm-vips'), or the 5 MB module lands in the initial bundle of every ` +
					`page load (ADR-0003, ADR-0019).`
			);
		}
	}
	dynamicVipsImports += dynamic.filter((specifier) => /^wasm-vips(\/|$)/.test(specifier)).length;
}

if (dynamicVipsImports === 0) {
	fail(
		`No dynamic import('wasm-vips') exists in apps/editor/src, so this check is guarding ` +
			`nothing. If the streaming tiler has deliberately been dropped (ticket 05's option 3), ` +
			`delete this fence in the same change rather than leaving it passing vacuously.`
	);
}

// ── Built output: the editor's chunk graph, and the viewer's bytes ─────────────────────────────

const editorBuild = path.join(repoRoot, 'apps/editor/build');
const viewerBuild = path.join(repoRoot, 'apps/viewer/build');
const builtEditor = existsSync(editorBuild);
const builtViewer = existsSync(viewerBuild);

if (requireBuild && !(builtEditor && builtViewer)) {
	fail(
		`apps/editor/build and apps/viewer/build must both exist for the built-output fences. Run ` +
			`pnpm -r build first.`
	);
}

if (builtEditor) {
	const chunks = filesUnder(editorBuild, (file) => file.endsWith('.js'));

	/**
	 * A chunk is part of the `wasm-vips` artefact if it names one of the module's own WebAssembly
	 * files. Identified by content rather than by the chunk's name, which Rollup hashes.
	 */
	const isVipsChunk = (file) => {
		const source = readFileSync(file, 'utf8');
		return /vips[-._][A-Za-z0-9_]*\.wasm|\bvips\.wasm\b/.test(source);
	};

	const vipsChunks = new Set(chunks.filter(isVipsChunk));

	if (vipsChunks.size === 0) {
		fail(
			`No chunk of the editor build names a vips WebAssembly file, so there is nothing here to ` +
				`fence. Either the build is stale, or the streaming tiler is gone and this check should ` +
				`go with it.`
		);
	}

	let reachedLazily = 0;

	for (const file of chunks) {
		const { statik, dynamic } = importsIn(readFileSync(file, 'utf8'));
		const resolve = (specifier) =>
			specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : undefined;

		for (const specifier of statik) {
			const target = resolve(specifier);
			if (target && vipsChunks.has(target) && !vipsChunks.has(file)) {
				fail(
					`${relative(file)} statically imports ${relative(target)}, which is part of ` +
						`wasm-vips. Whatever pulls that chunk then pulls 5 MB of WebAssembly glue with it, ` +
						`on a page load that may never ingest anything (ADR-0019).`
				);
			}
		}

		for (const specifier of dynamic) {
			const target = resolve(specifier);
			if (target && vipsChunks.has(target) && !vipsChunks.has(file)) reachedLazily += 1;
		}
	}

	if (vipsChunks.size > 0 && reachedLazily === 0) {
		fail(
			`No chunk of the editor build reaches wasm-vips through a dynamic import. Either the ` +
				`bundler inlined it — which is the failure this checks for — or the chunk is dead code ` +
				`and the streaming tiler is no longer wired up.`
		);
	}
}

if (builtViewer) {
	// String literals rather than identifiers, because identifiers are minified away. Each one is
	// present in the built *editor*, which is what makes them known-good positives.
	const markers = [
		['libvips resized a', 'the streaming tiler'],
		['megapixel limit of the built-in tiler', 'the ingest job'],
		['cannot encode a tile', 'the decode-and-crop tiler'],
		['vips-es6-', 'the wasm-vips worker'],
		['vips.wasm', 'the libvips WebAssembly module']
	];

	for (const file of filesUnder(viewerBuild, (file) => /\.(js|wasm)$/.test(file))) {
		const source = readFileSync(file, 'latin1');
		for (const [marker, what] of markers) {
			if (source.includes(marker)) {
				fail(
					`${relative(file)} contains "${marker}" — ${what} reached the built viewer. Every ` +
						`published site ships this bundle and a Reader never tiles anything (ADR-0019). It ` +
						`is here because something the viewer imports reaches the tiler, not because a ` +
						`dependency was added, so check the import graph rather than the manifest.`
				);
			}
		}
	}
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────

if (problems.length > 0) {
	console.error('\nwasm-vips and the tiler have escaped their boundary (ADR-0019).\n');
	for (const problem of problems) console.error(`  ${problem}\n`);
	process.exit(1);
}

const scope = [
	'source',
	builtEditor ? 'editor build' : undefined,
	builtViewer ? 'viewer build' : undefined
].filter(Boolean);

console.log(
	`wasm-vips is reachable only by dynamic import; the viewer has no tiler (${scope.join(', ')}).`
);

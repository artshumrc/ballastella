import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { repoRoot } from './fence.mjs';

const fail = (message) => {
	console.error(`check-allmaps-patch: ${message}`);
	process.exit(1);
};
const read = (file, what = `could not read ${file}`) => {
	try {
		return readFileSync(file, 'utf8');
	} catch (cause) {
		fail(`${what}: ${cause.message}`);
	}
};

const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
const declared = workspace.match(/'@allmaps\/render@([^']+)':\s*(\S+)/);
if (!declared) {
	fail(
		'no patchedDependencies entry for @allmaps/render in pnpm-workspace.yaml. If upstream has ' +
			'fixed the unproxied fetchFn, delete this script and the patch together.'
	);
}
const [, patchedVersion] = declared;

let renderDir;
try {
	const maplibre = realpathSync(
		join(repoRoot, 'apps', 'editor', 'node_modules', '@allmaps', 'maplibre')
	);
	renderDir = join(dirname(maplibre), 'render');
} catch (cause) {
	fail(`could not locate @allmaps/maplibre — has \`pnpm install\` run? (${cause.message})`);
}

const resolvedVersion = JSON.parse(
	read(
		join(renderDir, 'package.json'),
		"could not read @allmaps/render's manifest beside @allmaps/maplibre"
	)
).version;
if (resolvedVersion !== patchedVersion) {
	fail(
		`the patch names @allmaps/render ${patchedVersion} but ${resolvedVersion} is installed — ` +
			'almost certainly because @allmaps/maplibre was bumped, which moves render underneath it. ' +
			'Re-verify the patch against the new version (or drop it if upstream has fixed the ' +
			'unproxied fetchFn), then update pnpm-workspace.yaml.'
	);
}

const source = read(join(renderDir, 'dist/tilecache/CacheableWorkerImageDataTile.js'));

if (!source.includes('BALLASTELLA PATCH')) {
	fail(
		`@allmaps/render ${resolvedVersion} is installed WITHOUT the patch. Warped rendering will be ` +
			'blank and nothing will say so. Run `pnpm install` and check for a patch-apply failure.'
	);
}

if (!source.includes('this.fetchFn')) {
	fail(
		`the patch marker is present in @allmaps/render ${resolvedVersion} but the code no longer ` +
			'reads `this.fetchFn`. The patch is stale — re-read it against upstream.'
	);
}

const renderer = read(join(renderDir, 'dist/renderers/WebGL2Renderer.js'));

if (!renderer.includes('BALLASTELLA PATCH')) {
	fail(
		`@allmaps/render ${resolvedVersion}'s WebGL2Renderer is installed WITHOUT the second hunk. A ` +
			'Map Image whose tiles are refused will throw an uncaught page error again, with ' +
			'nothing on screen changing. Run `pnpm install` and check for a patch-apply failure. If ' +
			'upstream has fixed it — the other three renderers already had — drop this check with the hunk.'
	);
}

if (!renderer.includes('loadMissingImagesInViewport')) {
	fail(
		`the patch marker is present in @allmaps/render ${resolvedVersion}'s WebGL2Renderer but the ` +
			'code no longer mentions `loadMissingImagesInViewport`. The hunk is stale — re-read it ' +
			'against upstream.'
	);
}

console.log(
	`@allmaps/render ${resolvedVersion}: patched for the unproxied fetchFn (warped rendering) ` +
		'and for the dropped loadMissingImagesInViewport promises.'
);

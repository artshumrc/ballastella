// The flags that get Chromium onto ANGLE's Vulkan backend, in one place because two things need
// them: the Playwright config that launches every worker, and the check that proves they worked.

import process from 'node:process';

/** @type {readonly string[]} */
export const GPU_LAUNCH_ARGS = [
	'--use-angle=vulkan',
	'--enable-features=Vulkan',
	'--ignore-gpu-blocklist'
];

/**
 * Whether a WebGL `UNMASKED_RENDERER_WEBGL` string names a software rasteriser.
 *
 * Matched on the driver's own name rather than on the absence of a vendor, because ANGLE reports
 * every backend in the same shape: SwiftShader answers `ANGLE (Google, Vulkan 1.3.0 (SwiftShader
 * Device …), SwiftShader driver)` where the real device answers `ANGLE (Intel, Vulkan 1.4.318
 * (Intel(R) Graphics …), Intel open-source Mesa driver)`. `llvmpipe` and `lavapipe` are Mesa's two
 * software paths and reach here by the same route.
 *
 * A pure function of one string so the decision can be read, and tested, without a browser.
 *
 * @param {string} renderer
 * @returns {boolean}
 */
export const isSoftwareRenderer = (renderer) =>
	/swiftshader|llvmpipe|lavapipe|software/i.test(renderer);

/**
 * The flags that bound Chromium's CPU appetite when it is rasterising in software.
 *
 * SwiftShader raster threads are per *browser*, not per worker, so the worker cap is not a CPU cap:
 * four workers on this 20-core box have been measured pinning all twenty. One raster thread each
 * keeps a deliberate software run to roughly its worker count.
 *
 * @type {readonly string[]}
 */
export const SOFTWARE_LAUNCH_ARGS = ['--num-raster-threads=1'];

/**
 * Whether this process is the GitHub Actions runner, which is the only environment allowed to take
 * the software rasteriser without declaring it.
 *
 * ⚠ **This deliberately does not read `CI`.** `CI=1` is set by every agent harness, editor task
 * runner and wrapper script that wants non-interactive output — `CI=1 pnpm test:e2e` is a thing
 * people and agents type by hand — and while the exemption hung off `CI` it silently disabled both
 * GPU guards on a workstation. The symptom was exactly what the guards exist to prevent: twenty
 * cores at 100% and a run that looked merely slow. `GITHUB_ACTIONS` is set by the runner and by
 * nothing else.
 *
 * @returns {boolean}
 */
export const onGithubActions = () => process.env.GITHUB_ACTIONS === 'true';

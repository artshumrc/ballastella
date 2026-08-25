// The flags that get Chromium onto ANGLE's Vulkan backend, and the decision about whether to ask for
// them, in one place because everything that starts a Chromium here needs the same answer: the
// Playwright config that launches every e2e worker, `packages/core`'s Vitest browser project, and the
// check that proves the flags worked.

import { existsSync, readdirSync } from 'node:fs';
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

/**
 * Whether this machine can actually serve ANGLE's Vulkan backend.
 *
 * Both halves are needed and the second is the one that bites. A render node is the device; an
 * **installed ICD** is the driver that talks to it, and Chromium asked for Vulkan without one is the
 * case that fails tests rather than falling back. `lvp_icd.json` (lavapipe) counts — it is software
 * Vulkan, so it is merely slow rather than broken, which is the right side of the line.
 *
 * @returns {boolean}
 */
export const canUseVulkan = () => {
	if (process.platform !== 'linux') return false;
	const populated = (/** @type {string} */ directory) => {
		try {
			return readdirSync(directory).length > 0;
		} catch {
			return false;
		}
	};
	let renderNode;
	try {
		renderNode = readdirSync('/dev/dri').some((node) => node.startsWith('renderD'));
	} catch {
		renderNode = false;
	}
	// A named driver file wins, but only if it is really there: pointing `VK_DRIVER_FILES` at nothing
	// is how the failing case was reproduced, and it has to read as "no Vulkan" rather than as "yes".
	const named = process.env.VK_DRIVER_FILES ?? process.env.VK_ICD_FILENAMES;
	const driver = named
		? named.split(':').some((file) => existsSync(file))
		: populated('/usr/share/vulkan/icd.d') || populated('/etc/vulkan/icd.d');
	return renderNode && driver;
};

/**
 * Whether this run should ask for the GPU. `BALLASTELLA_E2E_GPU` overrides the detection either way.
 *
 * @returns {boolean}
 */
export const useGpu = () => {
	const wants = process.env.BALLASTELLA_E2E_GPU;
	return wants === '0' ? false : wants === '1' || canUseVulkan();
};

/**
 * The flags a Chromium started by this repository should carry, or `null` for Chromium's own
 * defaults.
 *
 * ⚠ **Throws rather than falling through.** A workstation that reaches the software rasteriser by
 * accident holds one core per browser and says nothing about it: the only symptom is a hot machine
 * and a suite that feels slow, which is indistinguishable from contention nobody can act on. Every
 * caller that starts a Chromium asks this, so neither path can acquire a silent software fallback of
 * its own — which is exactly what `packages/core`'s Vitest browser project had, launching two engines
 * through the Playwright provider with no launch options at all.
 *
 * The GitHub Actions runner is the one exemption: it has no render node and the software path is the
 * only one it has. It keeps Chromium's own defaults so CI timings stay comparable.
 *
 * @returns {readonly string[] | null}
 */
export function chromiumLaunchArgs() {
	const wants = process.env.BALLASTELLA_E2E_GPU;
	if (useGpu()) return GPU_LAUNCH_ARGS;
	if (onGithubActions()) return null;
	if (wants === '0') return SOFTWARE_LAUNCH_ARGS;
	throw new Error(
		'No Vulkan GPU was detected, and this is not CI, so the run would rasterise WebGL on the CPU ' +
			'and hold one core per browser.\n\n' +
			'  BALLASTELLA_E2E_GPU=1   insist, when the detection is wrong\n' +
			'  BALLASTELLA_E2E_GPU=0   accept the software rasteriser deliberately\n\n' +
			'The detection wants a render node in /dev/dri and an installed Vulkan ICD ' +
			'(/usr/share/vulkan/icd.d or /etc/vulkan/icd.d, or a file named by VK_DRIVER_FILES).'
	);
}

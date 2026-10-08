import { existsSync, readdirSync } from 'node:fs';
import process from 'node:process';

/** @type {readonly string[]} */
export const GPU_LAUNCH_ARGS = [
	'--use-angle=vulkan',
	'--enable-features=Vulkan',
	'--ignore-gpu-blocklist'
];

/** @param {string} renderer */
export const isSoftwareRenderer = (renderer) =>
	/swiftshader|llvmpipe|lavapipe|software/i.test(renderer);

// Not CI: agents and wrapper scripts set CI=1 on workstations.
export const onGithubActions = () => process.env.GITHUB_ACTIONS === 'true';

const canUseVulkan = () => {
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
	const named = process.env.VK_DRIVER_FILES ?? process.env.VK_ICD_FILENAMES;
	const driver = named
		? named.split(':').some((file) => existsSync(file))
		: populated('/usr/share/vulkan/icd.d') || populated('/etc/vulkan/icd.d');
	return renderNode && driver;
};

/**
 * GPU flags, or `null` (Chromium defaults) on GitHub Actions, which has no GPU. A workstation never
 * rasterises in software: without Vulkan this throws.
 *
 * @returns {readonly string[] | null}
 */
export function chromiumLaunchArgs() {
	if (onGithubActions()) return null;
	if (process.env.BALLASTELLA_E2E_GPU === '1' || canUseVulkan()) return GPU_LAUNCH_ARGS;
	throw new Error(
		'No Vulkan GPU was detected. Browser tests run on the GPU only, never a software rasteriser.\n\n' +
			'  BALLASTELLA_E2E_GPU=1   insist, when the detection is wrong\n\n' +
			'The detection wants a render node in /dev/dri and an installed Vulkan ICD ' +
			'(/usr/share/vulkan/icd.d or /etc/vulkan/icd.d, or a file named by VK_DRIVER_FILES).'
	);
}

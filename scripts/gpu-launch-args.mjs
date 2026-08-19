// The flags that get Chromium onto ANGLE's Vulkan backend, in one place because two things need
// them: the Playwright config that launches every worker, and the check that proves they worked.

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

import { chromium } from '@playwright/test';

import { GPU_LAUNCH_ARGS, isSoftwareRenderer, onGithubActions } from './gpu-launch-args.mjs';

const NO_WEBGL = 'no WebGL context at all';

const rendererInUse = async () => {
	const browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS] });
	try {
		const page = await browser.newPage();
		return await page.evaluate(() => {
			const gl = document.createElement('canvas').getContext('webgl2');
			if (!gl) return 'no WebGL context at all';
			const unmasked = gl.getExtension('WEBGL_debug_renderer_info');
			return String(gl.getParameter(unmasked ? unmasked.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
		});
	} finally {
		await browser.close();
	}
};

export default async () => {
	if (onGithubActions()) return;
	const renderer = await rendererInUse();
	if (renderer !== NO_WEBGL && !isSoftwareRenderer(renderer)) return;

	throw new Error(
		`Chromium took the GPU flags and did not reach the GPU.\n\n  ${renderer}\n\n` +
			'Every worker would rasterise WebGL on the CPU, or draw no map at all. The flags are ' +
			'right, so the fault is ' +
			'below them — a Vulkan ICD that no longer loads, a kernel or Mesa upgrade that left ' +
			'/dev/dri without a working driver, or a container that hid the render node.'
	);
};

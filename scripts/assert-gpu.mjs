// Refuse a run that would rasterise WebGL on the CPU without saying so.
//
// The config's own detection reads two directories and decides; this reads what Chromium actually
// gave us. The two disagree exactly where it matters — flags accepted, Vulkan unavailable at
// runtime, ANGLE silently falling back to SwiftShader — and that case costs one core per worker for
// the whole run while looking only like a slow afternoon.
//
// About a second, once per run, before any worker starts.

import process from 'node:process';

import { chromium } from '@playwright/test';

import { GPU_LAUNCH_ARGS, isSoftwareRenderer, onGithubActions } from './gpu-launch-args.mjs';

/** What {@link rendererInUse} answers when the browser has no WebGL to report on. */
const NO_WEBGL = 'no WebGL context at all';

/** What WebGL says it is drawing with, through the same flags the workers get. */
const rendererInUse = async () => {
	const browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS] });
	try {
		const page = await browser.newPage();
		return await page.evaluate(() => {
			const gl = document.createElement('canvas').getContext('webgl2');
			// No context at all is its own failure — every map in this suite needs one — and it is
			// what a broken ICD produces, so it is refused here rather than met as a blank map.
			if (!gl) return 'no WebGL context at all';
			const unmasked = gl.getExtension('WEBGL_debug_renderer_info');
			return String(gl.getParameter(unmasked ? unmasked.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
		});
	} finally {
		await browser.close();
	}
};

export default async () => {
	// `BALLASTELLA_E2E_GPU=0` is a deliberate choice of the software path, and CI has no other, so
	// neither is a failure. The config refuses the *undeclared* software run before reaching here.
	if (process.env.BALLASTELLA_E2E_GPU === '0' || onGithubActions()) return;

	const renderer = await rendererInUse();
	if (renderer !== NO_WEBGL && !isSoftwareRenderer(renderer)) return;

	throw new Error(
		`Chromium took the GPU flags and did not reach the GPU.\n\n  ${renderer}\n\n` +
			'Every worker would rasterise WebGL on the CPU, or draw no map at all. The flags are ' +
			'right, so the fault is ' +
			'below them — a Vulkan ICD that no longer loads, a kernel or Mesa upgrade that left ' +
			'/dev/dri without a working driver, or a container that hid the render node.\n\n' +
			'  BALLASTELLA_E2E_GPU=0 pnpm test:e2e   accept the software rasteriser deliberately'
	);
};

import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		typescript: {
			// ⚠ **The test harness is checked too, or it is not checked at all.**
			//
			// `pnpm check` runs `svelte-check` against `tsconfig.json`, which extends the config
			// SvelteKit generates — and that generated `include` lists `../src/**`, `../vite.config.ts`,
			// `../test/**` and `../tests/**` and nothing else. So `vitest.config.ts` and everything in
			// `vitest-setup/` sat outside the type seam entirely: a broken `defineConfig`, a setup file
			// importing a name that no longer exists, or a fence whose types drifted from
			// `@ballastella/core/test-fence` would all have been found by a red test run at best and by
			// nobody at worst. `packages/core/tsconfig.json` has had `vitest.config.ts` and
			// `vitest-setup/**/*.ts` in its `include` from the start; this is the same thing said in the
			// one place SvelteKit leaves for it.
			//
			// Through this hook rather than by writing `include` into `tsconfig.json`: an `include` in
			// the extending config *replaces* the base's outright, so that route means keeping a copy of
			// SvelteKit's generated list in step with SvelteKit for ever.
			config(config) {
				config.include.push('../vitest.config.ts', '../vitest-setup/**/*.ts');
				return config;
			}
		},
		// ADR-0012: the service worker exists, and its registration is the app's own.
		//
		// `register: false` because SvelteKit's built-in registration is an inline
		// `navigator.serviceWorker.register(...)` that hands nothing back, so there is nowhere to
		// attach the `updatefound` listener the explicit update prompt is made of — and recovering the
		// registration afterwards with `getRegistration()` races the update it exists to observe.
		// `$lib/pwa/installed-app.svelte.ts` registers instead, resolving the script URL relatively so
		// that the scope the browser derives is the deployment's own directory (ADR-0006).
		serviceWorker: { register: false },
		// ADR-0006: mandatory, and mandatory now rather than later. The publish target —
		// a domain root or a project subdirectory — is unknown at build time, and `paths.base`
		// is baked in at build time. Relative asset paths are the only way one build serves
		// both, and retrofitting this means auditing every asset reference in the app.
		paths: { relative: true }
	}
};

export default config;

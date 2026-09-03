import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		// ADR-0045: mandatory, and mandatory now rather than later. The publish target —
		// a domain root or a project subdirectory — is unknown at build time, and `paths.base`
		// is baked in at build time. Relative asset paths are the only way one build serves
		// both, and retrofitting this means auditing every asset reference in the app.
		paths: { relative: true }
	}
};

export default config;

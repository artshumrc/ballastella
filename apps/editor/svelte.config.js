import adapter from '@sveltejs/adapter-static';

const deploying = process.env.BALLASTELLA_DEPLOY === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		typescript: {
			config(config) {
				config.include.push('../vitest.config.ts', '../vitest-setup/**/*.ts');
				return config;
			}
		},
		serviceWorker: { register: false },
		paths: { relative: true },
		...(deploying ? { files: { routes: '.deploy/routes', assets: '.deploy/static' } } : undefined)
	}
};

export default config;

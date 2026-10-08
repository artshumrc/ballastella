import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },

	ssr: { noExternal: ['maplibre-gl', '@ballastella/core', '@ballastella/ui'] }
});

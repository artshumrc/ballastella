import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Adapter, `paths.relative`, and compiler options live in svelte.config.js.
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()]
});

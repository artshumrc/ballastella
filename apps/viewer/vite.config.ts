import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Adapter, `paths.relative`, and compiler options live in svelte.config.js.
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],

	// Vite 8 no longer widens the dev server's allow list to the pnpm workspace root, so the default
	// is this app's own directory. `@ballastella/ui`'s `layout.css` is consumed as source and its
	// `@font-face` rules point at `packages/ui/src/fonts/*.woff2`, which is outside that default: the
	// stylesheet loads, the font requests 403 with "outside of Vite serving allow list", and the app
	// silently falls back to system fonts in development only. The repo root is the narrowest scope
	// that covers every workspace package served as source.
	server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },

	// The same `maplibre-gl` server-side interop the editor needs, and for the same reason — see
	// `apps/editor/vite.config.ts`, where it is written out in full. `ReaderMapPane` imports `Map` and
	// `NavigationControl` by name and reaches `Popup` through `@ballastella/core/render`, so without
	// this the viewer's own `pnpm dev` is a 500 on the hub exactly as the editor's was.
	//
	// The workspace packages are listed for a different reason, spelled out in
	// `apps/editor/vite.config.ts`: their `exports` point at raw `.ts`, so Node can never load them.
	ssr: { noExternal: ['maplibre-gl', '@ballastella/core', '@ballastella/ui'] }
});

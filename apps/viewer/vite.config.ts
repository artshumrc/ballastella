import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Adapter, `paths.relative`, and compiler options live in svelte.config.js.
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],

	// The same `maplibre-gl` server-side interop the editor needs, and for the same reason — see
	// `apps/editor/vite.config.ts`, where it is written out in full. `ReaderMapPane` imports `Map` and
	// `NavigationControl` by name and reaches `Popup` through `@ballastella/core/render`, so without
	// this the viewer's own `pnpm dev` is a 500 on the hub exactly as the editor's was.
	//
	// The workspace packages are listed for a different reason, spelled out in
	// `apps/editor/vite.config.ts`: their `exports` point at raw `.ts`, so Node can never load them.
	ssr: { noExternal: ['maplibre-gl', '@ballastella/core', '@ballastella/ui'] }
});

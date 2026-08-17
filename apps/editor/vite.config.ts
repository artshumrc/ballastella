import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Adapter, `paths.relative`, and compiler options live in svelte.config.js.
export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],

	// **`maplibre-gl` must go through Vite's own pipeline on the server side, or `pnpm dev` is a 500
	// on every route.** The package ships an ESM build and a CommonJS one. Bundling picks the ESM
	// build, so `import { Map, NavigationControl, Popup, addProtocol }` resolves and every built app
	// works. Left external, Node loads the CommonJS build instead, whose named exports do not exist as
	// ES bindings — and because the panes reach it through `@ballastella/core/render`, the SSR pass of
	// the root route died with "Named export 'Popup' not found" before rendering a byte.
	//
	// It went unnoticed because **nothing tests development mode**: the browser suite runs against
	// `apps/*/build`, and the shipped site is prerendered static files (ADR-0006) with no SSR server at
	// all, so production was genuinely fine while the developer loop was completely broken.
	//
	// Do not "fix" this at the import sites with `import maplibregl from 'maplibre-gl'` and a
	// destructure. That is what the Vite error message suggests, and it fails the other way round:
	// once this line is here the ESM build is what loads, and it has no default export.
	//
	// **The workspace packages must be here too, and for an unrelated reason.** `@ballastella/core`
	// and `@ballastella/ui` set `exports` to their raw `./src/*.ts` entry points — they are consumed
	// as source, never built. Left external, Node loads `packages/core/src/index.ts` itself and strips
	// the types (it can, on Node 22.6+), then fails on the very first re-export: Node's ESM resolver
	// takes specifiers literally, so `./autosave/autosave.js` does not find `autosave.ts`. Only Vite's
	// pipeline performs that extensionless/`.js`→`.ts` mapping, so a package that ships TypeScript can
	// never be externalized. The symptom is `ERR_MODULE_NOT_FOUND` for a file that plainly exists.
	ssr: { noExternal: ['maplibre-gl', '@ballastella/core', '@ballastella/ui'] }
});

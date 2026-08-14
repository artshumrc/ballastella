// This package is not a SvelteKit app and does not compile itself: it publishes `.svelte` source and
// each consuming app's own config decides how that source is compiled (ADR-0034).
//
// The file exists because two tools look for one and behave differently when they find none —
// `@sveltejs/vite-plugin-svelte` in this package's vitest project, and `eslint-plugin-svelte`'s
// parser, which is handed this object explicitly by the workspace `eslint.config.js`. There is
// nothing to configure: no preprocessor (Svelte 5 reads `lang="ts"` itself), no adapter, no aliases.
// ⚠ An alias here would be the beginning of the thing `scripts/check-ui-package-imports.mjs`
// refuses — a module in this package whose meaning depends on who compiled it.

/** @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig} */
export default {};

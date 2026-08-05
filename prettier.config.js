/** @type {import("prettier").Config} */
const config = {
	useTabs: true,
	singleQuote: true,
	trailingComma: 'none',
	printWidth: 100,
	plugins: ['prettier-plugin-svelte', 'prettier-plugin-tailwindcss'],
	overrides: [{ files: '*.svelte', options: { parser: 'svelte' } }],
	// prettier-plugin-tailwindcss wants a single Tailwind entry point to read the
	// theme from. Both apps import the same directives, so the editor's stylesheet
	// stands for both; class sorting is cosmetic and nothing depends on it.
	tailwindStylesheet: './apps/editor/src/routes/layout.css'
};

export default config;

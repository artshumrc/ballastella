import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import path from 'node:path';
import ts from 'typescript-eslint';

import uiSvelteConfig from './packages/ui/svelte.config.js';

import editorSvelteConfig from './apps/editor/svelte.config.js';
import viewerSvelteConfig from './apps/viewer/svelte.config.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

/**
 * Each app and the shared component package carry their own svelte.config.js, so the parser has to
 * be told which one applies to which files — there is no single config at the workspace root to
 * infer.
 *
 * @param {string} directory
 * @param {import('@sveltejs/kit').Config} svelteConfig
 */
const svelteFiles = (directory, svelteConfig) => ({
	files: [`${directory}/**/*.svelte`, `${directory}/**/*.svelte.ts`, `${directory}/**/*.svelte.js`],
	languageOptions: {
		parserOptions: {
			projectService: true,
			extraFileExtensions: ['.svelte'],
			parser: ts.parser,
			svelteConfig
		}
	}
});

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on
			// TypeScript projects. See:
			// https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	svelteFiles('apps/editor', editorSvelteConfig),
	svelteFiles('apps/viewer', viewerSvelteConfig),
	svelteFiles('packages/ui', uiSvelteConfig)
);

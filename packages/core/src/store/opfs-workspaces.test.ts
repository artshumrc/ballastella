import { describe, expect, it } from 'vitest';

import {
	DEFAULT_WORKSPACE_NAME,
	MAX_WORKSPACE_NAME_LENGTH,
	toWorkspaceName
} from './opfs-workspaces';

// The half of `opfs-workspaces.ts` that does not need OPFS: turning a typed name into a directory
// name. Everything that touches the root is in `opfs-workspaces.browser.test.ts`, where there is a
// real one, and the origin's persistence is in `persistent-storage.test.ts` beside its own module.

describe('toWorkspaceName', () => {
	it('keeps a name a person would type, rather than slugging it', () => {
		// The bar names the Workspace on every screen. A user who typed "Marking 2026"
		// and is shown "marking-2026" has had their work renamed without being asked — and a folder
		// Workspace's name is its folder's name, unaltered, so this is the same rule for both backings.
		expect(toWorkspaceName('Marking 2026')).toBe('Marking 2026');
		expect(toWorkspaceName('  Amsterdam   thesis  ')).toBe('Amsterdam thesis');
		expect(toWorkspaceName('Ünïcode Wörk')).toBe('Ünïcode Wörk');
		expect(toWorkspaceName('Marking 2026 (2)')).toBe('Marking 2026 (2)');
	});

	it('cannot produce a path, an escape, or a name a filesystem refuses', () => {
		// It becomes a directory name in OPFS, so this is the boundary: a `/` or a `..` here is a store
		// rooted somewhere nobody asked for, and the characters Windows refuses are a Workspace that
		// cannot be created at all on the platform where nothing else would have failed.
		for (const typed of ['../escape', 'a/b', 'a\\b', '..', '.', 'x:*?"<>|y', ' trailing ']) {
			const name = toWorkspaceName(typed);
			expect(name, typed).not.toMatch(/[/\\:*?"<>|]/);
			expect(name, typed).not.toBe('.');
			expect(name, typed).not.toBe('..');
			expect(name.trim(), typed).toBe(name);
			expect(name.length, typed).toBeGreaterThan(0);
		}
	});

	it('is idempotent, so the name checked for collisions is the name created', () => {
		// `createOpfsWorkspace` suffixes with ` (2)` and then normalises again. A normaliser that
		// rewrote its own output would answer "free" about one string and create another.
		//
		// ⚠ The last two specimens are the ones that actually broke it. `slice(0, 64)` counts UTF-16
		// **code units**, so a name whose 64th position falls inside an astral character was cut
		// through the middle of it — leaving a lone surrogate that a second pass then stripped. The
		// two passes disagreed, which is exactly what the caller cannot survive.
		for (const typed of [
			'Marking 2026',
			'Marking 2026 (2)',
			'../escape',
			'Ünïcode Wörk',
			'',
			'A'.repeat(MAX_WORKSPACE_NAME_LENGTH),
			`${'A'.repeat(MAX_WORKSPACE_NAME_LENGTH - 1)}𝐀𝐁`,
			`${'क्ष'.repeat(30)}𝐀`
		]) {
			expect(toWorkspaceName(toWorkspaceName(typed)), typed).toBe(toWorkspaceName(typed));
		}
	});

	it('never cuts a character in half, whatever the length cap lands on', () => {
		// A lone surrogate is not a character. It is a name OPFS may refuse, and it is invisible in
		// every log and every test name that prints it.
		const name = toWorkspaceName(`${'A'.repeat(MAX_WORKSPACE_NAME_LENGTH - 1)}𝐀𝐁`);

		expect(name).not.toMatch(/[\uD800-\uDFFF]/u);
		expect([...name].length).toBeLessThanOrEqual(MAX_WORKSPACE_NAME_LENGTH);
	});

	it('keeps the marks of a script whose letters carry them', () => {
		// Dropping `\p{M}` is not a safety property, it is mangling somebody's language: NFC composes
		// what it can, and Devanagari, Thai and Arabic marks have no composed form to compose into.
		expect(toWorkspaceName('क्षेत्र 2026')).toBe('क्षेत्र 2026');
	});

	it('gives a name that reduces to nothing the default, rather than refusing to make one', () => {
		expect(toWorkspaceName('')).toBe(DEFAULT_WORKSPACE_NAME);
		expect(toWorkspaceName('///')).toBe(DEFAULT_WORKSPACE_NAME);
	});
});

import { describe, expect, it } from 'vitest';

import {
	DEFAULT_WORKSPACE_NAME,
	MAX_WORKSPACE_NAME_LENGTH,
	toWorkspaceName
} from './opfs-workspaces';

describe('toWorkspaceName', () => {
	it('keeps a name a person would type, rather than slugging it', () => {
		expect(toWorkspaceName('Marking 2026')).toBe('Marking 2026');
		expect(toWorkspaceName('  Amsterdam   thesis  ')).toBe('Amsterdam thesis');
		expect(toWorkspaceName('Ünïcode Wörk')).toBe('Ünïcode Wörk');
		expect(toWorkspaceName('Marking 2026 (2)')).toBe('Marking 2026 (2)');
	});

	it('cannot produce a path, an escape, or a name a filesystem refuses', () => {
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
		const name = toWorkspaceName(`${'A'.repeat(MAX_WORKSPACE_NAME_LENGTH - 1)}𝐀𝐁`);
		expect(name).not.toMatch(/[\uD800-\uDFFF]/u);
		expect([...name].length).toBeLessThanOrEqual(MAX_WORKSPACE_NAME_LENGTH);
	});

	it('keeps the marks of a script whose letters carry them', () => {
		expect(toWorkspaceName('क्षेत्र 2026')).toBe('क्षेत्र 2026');
	});

	it('gives a name that reduces to nothing the default, rather than refusing to make one', () => {
		expect(toWorkspaceName('')).toBe(DEFAULT_WORKSPACE_NAME);
		expect(toWorkspaceName('///')).toBe(DEFAULT_WORKSPACE_NAME);
	});
});

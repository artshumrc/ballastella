import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from './test.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cacheDirectory = path.join(repoRoot, 'node_modules/.cache/ballastella-e2e');
const buildStampFile = path.join(cacheDirectory, 'build-stamp.json');

type WorkspaceSnapshot = {
	readonly imageId: string;
	readonly layerId: string;
	readonly files: readonly (readonly [string, string])[];
};

const buildFingerprint = (): string => {
	try {
		const stamp: unknown = JSON.parse(readFileSync(buildStampFile, 'utf8'));
		const value = (stamp as { fingerprint?: unknown })?.fingerprint;
		return typeof value === 'string' ? value : 'unstamped';
	} catch {
		return 'unstamped';
	}
};

const cacheFile = (name: string): string =>
	path.join(
		cacheDirectory,
		`snapshot-${name}-${createHash('sha256').update(buildFingerprint()).digest('hex').slice(0, 16)}.json`
	);

const memo = new Map<string, WorkspaceSnapshot>();

const readSnapshot = (name: string): WorkspaceSnapshot | null => {
	const held = memo.get(name);
	if (held) return held;
	const file = cacheFile(name);
	if (!existsSync(file)) return null;
	try {
		const snapshot = JSON.parse(readFileSync(file, 'utf8')) as WorkspaceSnapshot;
		memo.set(name, snapshot);
		return snapshot;
	} catch {
		return null;
	}
};

const writeSnapshot = (name: string, snapshot: WorkspaceSnapshot): void => {
	try {
		mkdirSync(cacheDirectory, { recursive: true });
		const file = cacheFile(name);
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(snapshot));
		renameSync(temporary, file);
		memo.set(name, snapshot);
	} catch {}
};

async function captureWorkspace(page: Page): Promise<(readonly [string, string])[]> {
	return page.evaluate(async () => {
		const out: [string, string][] = [];
		const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			const entries: [string, FileSystemHandle][] = [];
			for await (const entry of directory.entries()) entries.push(entry);
			entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
			for (const [name, handle] of entries) {
				const at = prefix ? `${prefix}/${name}` : name;
				if (handle.kind === 'directory') {
					await walk(handle as FileSystemDirectoryHandle, at);
					continue;
				}
				const file = await (handle as FileSystemFileHandle).getFile();
				const bytes = new Uint8Array(await file.arrayBuffer());
				let binary = '';
				for (const byte of bytes) binary += String.fromCharCode(byte);
				out.push([at, btoa(binary)]);
			}
		};
		await walk(await workspaceRoot(), '');
		return out;
	});
}

export async function restoreWorkspace(
	page: Page,
	files: readonly (readonly [string, string])[]
): Promise<void> {
	await page.evaluate(async (entries: readonly (readonly [string, string])[]) => {
		const root = await workspaceRoot();
		for (const [at, base64] of entries) {
			const segments = at.split('/');
			let directory = root;
			for (const segment of segments.slice(0, -1)) {
				directory = await directory.getDirectoryHandle(segment, { create: true });
			}
			const handle = await directory.getFileHandle(segments.at(-1) as string, { create: true });
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
			const writable = await handle.createWritable();
			await writable.write(bytes);
			await writable.close();
		}
	}, files);
}

export async function snapshotWorkspace(
	page: Page,
	name: string,
	capture: (page: Page) => Promise<{ imageId: string; layerId: string }>
): Promise<WorkspaceSnapshot> {
	const held = readSnapshot(name);
	if (held) return held;

	const { imageId, layerId } = await capture(page);
	const snapshot: WorkspaceSnapshot = { imageId, layerId, files: await captureWorkspace(page) };
	writeSnapshot(name, snapshot);
	return snapshot;
}

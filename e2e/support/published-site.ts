import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveDirectory, type StaticSite } from './static-site.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viewerBuild = path.join(repoRoot, 'apps/viewer/build');
const baseMapAssets = path.join(repoRoot, 'apps/editor/static/base-map');
const SITE_PREFIXES = ['', '/student/atlas-2026'] as const;

export type SiteFiles = Record<string, string | Uint8Array>;

export async function assemblePublishedSite(
	files: SiteFiles,
	options: { withoutBaseMap?: boolean } = {}
): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'ballastella-site-'));
	await cp(viewerBuild, directory, { recursive: true });
	if (!options.withoutBaseMap) {
		await cp(baseMapAssets, path.join(directory, 'base-map'), { recursive: true });
	}
	for (const [relative, contents] of Object.entries(files)) {
		await writeSiteFile(directory, relative, contents);
	}
	return directory;
}

export function siteRecord(
	projects: readonly { directory: string; name: string; onFrontPage?: boolean }[],
	overrides: Record<string, unknown> = {}
): string {
	return asJson({
		formatVersion: 1,
		viewerVersion: 'test-viewer',
		publishedAt: '2026-08-06T00:00:00.000Z',
		projects: [...projects],
		baseMapBundled: false,
		baseMapAssetsBundled: true,
		baseMapCaches: [],
		...overrides
	});
}

export const asJson = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`;

export async function servePublishedSite(
	files: SiteFiles,
	options: { withoutBaseMap?: boolean } = {}
): Promise<{
	directory: string;
	sites: StaticSite[];
	close(): Promise<void>;
}> {
	const directory = await assemblePublishedSite(files, options);
	const sites = await Promise.all(SITE_PREFIXES.map((prefix) => serveDirectory(directory, prefix)));
	return {
		directory,
		sites,
		close: async () => {
			await Promise.all(sites.map((site) => site.close()));
			await rm(directory, { recursive: true, force: true });
		}
	};
}

const TILE_JPEG = Buffer.from(
	'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APf6KKKK/9k=',
	'base64'
);

export const tileJpeg = (): Uint8Array => new Uint8Array(TILE_JPEG);

export async function writeSiteFile(
	directory: string,
	relative: string,
	contents: string | Uint8Array
): Promise<void> {
	const file = path.join(directory, relative);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, contents);
}

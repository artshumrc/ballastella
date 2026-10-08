import type { Page } from './test.js';

const READ_ATTEMPTS = 20;
const READ_RETRY_MS = 25;

const attemptRead = (
	page: Page,
	path: string
): Promise<{ text: string; failure: null } | { text: null; failure: string }> =>
	page.evaluate(
		async ([path, attempts, retryMs]) => {
			let failure = 'it was never attempted';
			for (let attempt = 0; attempt < (attempts as number); attempt += 1) {
				try {
					let handle = await workspaceRoot();
					const segments = (path as string).split('/').filter((segment) => segment !== '');
					for (const segment of segments.slice(0, -1)) {
						handle = await handle.getDirectoryHandle(segment);
					}
					const file = await handle.getFileHandle(segments.at(-1) as string);
					return { text: await (await file.getFile()).text(), failure: null } as const;
				} catch (cause) {
					failure = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
					await new Promise((resolve) => setTimeout(resolve, retryMs as number));
				}
			}
			return { text: null, failure } as const;
		},
		[path, READ_ATTEMPTS, READ_RETRY_MS] as const
	);

export const readStoredFileOrNull = async (page: Page, path: string): Promise<string | null> =>
	(await attemptRead(page, path)).text;

export const readStoredFile = async (page: Page, path: string): Promise<string> => {
	const { text, failure } = await attemptRead(page, path);
	if (text === null) {
		throw new Error(
			`${path} could not be read in ${READ_ATTEMPTS} attempts over ` +
				`${READ_ATTEMPTS * READ_RETRY_MS}ms — the last failure was ${failure}. ` +
				'A transient failure here is the atomic-replace window; a persistent one is not.'
		);
	}
	return text;
};

export const readStoredJsonOrNull = async <T>(page: Page, path: string): Promise<T | null> => {
	const text = await readStoredFileOrNull(page, path);
	if (text === null) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
};

export async function seedFile(page: Page, path: string, contents: string): Promise<void> {
	await page.evaluate(
		async ([path, contents]) => {
			const segments = path.split('/');
			let directory = await workspaceRoot();
			for (const segment of segments.slice(0, -1)) {
				directory = await directory.getDirectoryHandle(segment, { create: true });
			}
			const name = segments[segments.length - 1] as string;
			const temporary = await directory.getFileHandle(`.${name}.seeding`, { create: true });
			const writable = await temporary.createWritable();
			await writable.write(contents);
			await writable.close();
			await (
				temporary as FileSystemFileHandle & { move(to: unknown, as: string): Promise<void> }
			).move(directory, name);
		},
		[path, contents] as const
	);
}

export async function delayReadsOf(page: Page, name: string, ms: number): Promise<void> {
	await page.evaluate(
		async ([match, delay]) => {
			const proto = FileSystemFileHandle.prototype;
			const original = proto.getFile;
			proto.getFile = async function (this: FileSystemFileHandle) {
				if (this.name === match) {
					await new Promise((resolve) => setTimeout(resolve, delay as number));
				}
				return original.call(this);
			};
		},
		[name, ms] as const
	);
}

export const readJson = async (page: Page, directory: string, path: string): Promise<unknown> =>
	JSON.parse(await readStoredFile(page, directory === '' ? path : `${directory}/${path}`));

export const writeStoredFiles = (
	page: Page,
	files: Record<string, string>,
	workspace?: string
): Promise<void> =>
	page.evaluate(
		async ([files, workspace]) => {
			const root =
				workspace === undefined
					? await workspaceRoot()
					: await (
							await navigator.storage.getDirectory()
						).getDirectoryHandle(workspace, {
							create: true
						});
			for (const [path, text] of Object.entries(files)) {
				const segments = path.split('/');
				let handle = root;
				for (const segment of segments.slice(0, -1)) {
					handle = await handle.getDirectoryHandle(segment, { create: true });
				}
				const file = await handle.getFileHandle(segments.at(-1)!, { create: true });
				const writable = await file.createWritable();
				await writable.write(text);
				await writable.close();
			}
		},
		[files, workspace] as const
	);

export type StorePath = string;

declare const alignmentPathBrand: unique symbol;

export type AlignmentPath = StorePath & {
	readonly [alignmentPathBrand]: 'alignments/<image-id>.json';
};

// Optional brand: any plain string is writable, an AlignmentPath is not.
export type WritablePath = StorePath & { readonly [alignmentPathBrand]?: undefined };

export type Bytes = Uint8Array<ArrayBuffer>;

export interface ProjectStore {
	read(path: StorePath): Promise<Bytes>;
	write(path: WritablePath, bytes: Bytes): Promise<void>;
	list(prefix: string): Promise<StorePath[]>;
	delete(path: StorePath): Promise<void>;
	size(path: StorePath): Promise<number>;
	modifiedAt?(path: StorePath): Promise<number | null>;
	reclaimAbandonedWrites(prefix: string): Promise<void>;
}

export type ReadOnlyProjectStore = Pick<ProjectStore, 'read'>;

export type EnumerableReadOnlyProjectStore = ReadOnlyProjectStore &
	Pick<ProjectStore, 'list' | 'size'>;

export class PathNotFoundError extends Error {
	override readonly name = 'PathNotFoundError';
	constructor(readonly path: StorePath) {
		super(`Nothing is stored at ${path}`);
	}
}

export class InvalidPathError extends Error {
	override readonly name = 'InvalidPathError';
	constructor(
		readonly path: string,
		reason: string
	) {
		super(`Invalid store path ${JSON.stringify(path)}: ${reason}`);
	}
}

export const TEMP_PATH_SUFFIX = '.ballastella-tmp';
const TEMP_PATH_PATTERN = new RegExp(`${TEMP_PATH_SUFFIX.replace('.', '\\.')}(\\.[^./]+)?$`);
export const isTempPath = (path: string): boolean => TEMP_PATH_PATTERN.test(path);

export function assertStorePath(path: string): StorePath {
	if (typeof path !== 'string' || path.length === 0) {
		throw new InvalidPathError(path, 'must be a non-empty string');
	}
	if (path.startsWith('/') || path.endsWith('/')) {
		throw new InvalidPathError(path, 'must not start or end with "/"');
	}
	if (path.includes('\\')) {
		throw new InvalidPathError(path, 'must use "/" as its separator');
	}
	if (isTempPath(path)) {
		throw new InvalidPathError(
			path,
			`must not end with the reserved ${TEMP_PATH_SUFFIX}, with or without a further extension`
		);
	}
	for (const segment of path.split('/')) {
		if (segment === '') throw new InvalidPathError(path, 'must not contain an empty segment');
		if (segment === '.' || segment === '..') {
			throw new InvalidPathError(path, 'must not contain "." or ".." segments');
		}
	}
	return path;
}

export const pathSegments = (path: string): string[] => path.split('/').filter(Boolean);

export function topLevelSegment(path: string): string {
	const cut = path.indexOf('/');
	return cut === -1 ? path : path.slice(0, cut);
}

export async function readIfPresent(
	store: ReadOnlyProjectStore,
	path: StorePath
): Promise<Bytes | null> {
	try {
		return await store.read(path);
	} catch (cause) {
		if (cause instanceof PathNotFoundError) return null;
		throw cause;
	}
}

export const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export const serialiseJson = (value: unknown): Bytes =>
	new TextEncoder().encode(`${JSON.stringify(value, null, '\t')}\n`) as Bytes;

export const parseJsonBytes = (bytes: Uint8Array): unknown =>
	JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const textField = (value: unknown): string => (typeof value === 'string' ? value : '');

export const asRecord = (value: unknown): Record<string, unknown> | null =>
	isRecord(value) ? value : null;

export function parseJsonObject(
	bytes: Uint8Array,
	refuse: (reason: string) => Error
): Record<string, unknown> {
	let raw: unknown;
	try {
		raw = parseJsonBytes(bytes);
	} catch (cause) {
		throw refuse(messageOf(cause));
	}
	if (!isRecord(raw)) throw refuse('the file does not contain a JSON object');
	return raw;
}

export function jsonObjectOrNull(bytes: Uint8Array): Record<string, unknown> | null {
	try {
		return asRecord(parseJsonBytes(bytes));
	} catch {
		return null;
	}
}

export function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(binary);
}

export const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
	left.length === right.length && left.every((byte, index) => byte === right[index]);

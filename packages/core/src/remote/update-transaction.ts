import { writeArrivedFile } from '../alignment/alignment-file.js';
import {
	messageOf,
	readIfPresent,
	serialiseJson,
	textField,
	type Bytes,
	type ProjectStore,
	type StorePath
} from '../store/project-store.js';
import { byPath } from './synchronization-paths.js';
import {
	isStorePath,
	readTransactionMark,
	type TransactionHeader
} from '../store/transaction-mark.js';

export const UPDATE_TRANSACTION_PATH: StorePath = 'update.json';
export const UPDATE_BEFORE_DIRECTORY = 'update.before/';
export const UPDATE_TRANSACTION_FORMAT_VERSION = 2;

interface UpdateBeforeImage {
	readonly path: StorePath;
	readonly image: StorePath;
}

interface UpdateTransaction extends TransactionHeader {
	readonly workspace: string;
	readonly commit: string;
	readonly added: readonly StorePath[];
	readonly replaced: readonly UpdateBeforeImage[];
	readonly deleted: readonly UpdateBeforeImage[];
}

export const serialiseUpdateTransaction = (transaction: UpdateTransaction): Bytes =>
	serialiseJson(transaction);

function parseUpdateTransaction(
	raw: Record<string, unknown>,
	header: TransactionHeader
): UpdateTransaction | null {
	const { added, replaced, deleted = [] } = raw;
	if (!Array.isArray(added) || !added.every(isStorePath)) return null;
	const replacedImages = beforeImages(replaced);
	const deletedImages = beforeImages(deleted);
	if (replacedImages === null || deletedImages === null) return null;
	return {
		...header,
		workspace: textField(raw.workspace),
		commit: textField(raw.commit),
		added,
		replaced: replacedImages,
		deleted: deletedImages
	};
}

function beforeImages(raw: unknown): UpdateBeforeImage[] | null {
	if (!Array.isArray(raw)) return null;
	const images = raw.map((entry) => {
		const { path, image } = (entry ?? {}) as Record<string, unknown>;
		return isStorePath(path) && isStorePath(image) ? { path, image } : null;
	});
	return images.every((image) => image !== null) ? images : null;
}

export const readUpdateTransaction = (store: ProjectStore) =>
	readTransactionMark(store, UPDATE_TRANSACTION_PATH, parseUpdateTransaction);

type UpdateRefusal =
	| 'no-repository'
	| 'empty'
	| 'rate-limited'
	| 'truncated'
	| 'refused'
	| 'incomplete'
	| 'invalid'
	| 'unsupported'
	| 'insufficient-quota'
	| 'unreadable'
	| 'write-failed'
	// The one refusal that leaves the Workspace changed; the marker stays for the next attempt.
	| 'unresolved-residue'
	| 'unresolved-transaction';

export class UpdateRefusedError extends Error {
	override readonly name = 'UpdateRefusedError';
	readonly paths: readonly string[];

	constructor(
		readonly refusal: UpdateRefusal,
		message: string,
		options: { readonly paths?: readonly string[]; readonly cause?: unknown } = {}
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.paths = options.paths ?? [];
	}
}

export async function recoverWorkspaceUpdate(
	store: ProjectStore
): Promise<
	| { readonly outcome: 'nothing' }
	| { readonly outcome: 'rolled-back' | 'completed'; readonly transaction: string }
> {
	const mark = await readUpdateTransaction(store);
	if (mark === null) return { outcome: 'nothing' };
	if (mark.state === 'unreadable') {
		throw new UpdateRefusedError(
			'unresolved-transaction',
			'This Workspace has a record of a get from GitHub that cannot be read, so Ballastella ' +
				'cannot tell which files it had changed and will not start another until it can. Reload ' +
				'this page to try again. Nothing has been lost.'
		);
	}
	try {
		if (mark.state === 'writing') await rollBack(store, mark);
		else await sweep(store, mark);
	} catch (cause) {
		throw new UpdateRefusedError(
			'unresolved-transaction',
			`An earlier get from GitHub did not finish, and this Workspace's record of it could not ` +
				'be resolved — so another get will not start over the top of it. Reload this page to ' +
				'try again.',
			{ cause }
		);
	}
	return {
		outcome: mark.state === 'writing' ? 'rolled-back' : 'completed',
		transaction: mark.transaction
	};
}

export async function writeUpdate(
	store: ProjectStore,
	planned: Omit<UpdateTransaction, 'formatVersion' | 'state' | 'replaced' | 'deleted'> & {
		readonly replaced: readonly StorePath[];
		readonly deleted: readonly StorePath[];
	},
	write: () => Promise<void>
): Promise<void> {
	const marker: UpdateTransaction = {
		formatVersion: UPDATE_TRANSACTION_FORMAT_VERSION,
		state: 'writing',
		...planned,
		replaced: planned.replaced
			.map((path, index) => ({ path, image: `${UPDATE_BEFORE_DIRECTORY}${index}` }))
			.sort(byPath),
		deleted: planned.deleted.map((path, index) => ({
			path,
			image: `${UPDATE_BEFORE_DIRECTORY}d${index}`
		}))
	};

	await store.write(UPDATE_TRANSACTION_PATH, serialiseUpdateTransaction(marker));
	try {
		for (const { path, image } of [...marker.replaced, ...marker.deleted]) {
			await store.write(image, await store.read(path));
		}
		await write();
		for (const { path } of marker.deleted) await store.delete(path);
		await store.write(
			UPDATE_TRANSACTION_PATH,
			serialiseUpdateTransaction({ ...marker, state: 'committed' })
		);
	} catch (cause) {
		return rollBackOrRefuse(store, marker, cause);
	}

	await sweep(store, marker).catch(() => {});
}

async function rollBackOrRefuse(
	store: ProjectStore,
	marker: UpdateTransaction,
	cause: unknown
): Promise<never> {
	try {
		await rollBack(store, marker);
	} catch (residue) {
		throw new UpdateRefusedError('unresolved-residue', unresolvedResidueMessage(), {
			cause: residue
		});
	}
	if (cause instanceof UpdateRefusedError) throw cause;
	throw new UpdateRefusedError('write-failed', writeFailedMessage(cause), { cause });
}

async function rollBack(store: ProjectStore, marker: UpdateTransaction): Promise<void> {
	for (const { path, image } of [...marker.replaced, ...marker.deleted]) {
		const bytes = await readIfPresent(store, image);
		if (bytes !== null) await writeInbound(store, path, bytes, 'restore');
	}
	for (const path of marker.added) await store.delete(path);
	await sweep(store, marker);
}

async function sweep(store: ProjectStore, marker: UpdateTransaction): Promise<void> {
	for (const { image } of [...marker.replaced, ...marker.deleted]) await store.delete(image);
	await store.delete(UPDATE_TRANSACTION_PATH);
}

export async function writeInbound(
	store: ProjectStore,
	path: StorePath,
	bytes: Bytes,
	effect: 'add' | 'replace' | 'restore' | 'answered'
): Promise<void> {
	const outcome = await writeArrivedFile(
		store,
		path,
		bytes,
		effect === 'add' ? { intent: 'create' } : { intent: 'replace', discarding: DISCARDING[effect] }
	);
	if (outcome === 'declined') {
		throw new UpdateRefusedError('write-failed', declinedAlignmentMessage(path), { paths: [path] });
	}
}

const DISCARDING: Record<'replace' | 'restore' | 'answered', string> = {
	replace: 'the Alignment this Workspace and GitHub last shared for this Map Image',
	restore: 'the Alignment a get from GitHub had written, which is being taken back',
	answered: 'the Alignment held here, which you chose to replace with the one from GitHub'
};

const writeFailedMessage = (cause: unknown): string =>
	`A file could not be written into this Workspace, so the get has stopped: ${messageOf(cause)}. ` +
	`Everything it had already written has been put back exactly as it was, and nothing on GitHub ` +
	`has been touched.`;

const declinedAlignmentMessage = (path: string): string =>
	`${path} could not be written, because this Workspace turned out to already hold an Alignment ` +
	`for that Map Image. The get has stopped and everything it had already written has been put ` +
	`back, rather than record work as shared with GitHub that is not.`;

const unresolvedResidueMessage = (): string =>
	`A get from GitHub failed, and the files it had already changed could not be put back — so ` +
	`this Workspace holds part of what GitHub sent. Nothing has been lost: reload this page and ` +
	`Ballastella will finish undoing it before anything else touches this Workspace.`;

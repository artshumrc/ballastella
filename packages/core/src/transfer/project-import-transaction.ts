import { writeArrivedFile } from '../alignment/alignment-file.js';
import { PROJECT_FILE_NAME } from '../project/project-file.js';
import { foldName } from '../project/workspace.js';
import type { EstimateStorage } from '../store/persistent-storage.js';
import {
	InvalidPathError,
	PathNotFoundError,
	assertStorePath,
	serialiseJson,
	type Bytes,
	type ProjectStore,
	type ReadOnlyProjectStore,
	type StorePath
} from '../store/project-store.js';
import {
	isStorePath,
	readTransactionMark,
	type TransactionHeader
} from '../store/transaction-mark.js';
import type { ClosurePath, ProjectImportSource } from './project-import-source.js';
import { storageShortfall } from './transfer.js';

export const IMPORT_TRANSACTION_PATH: StorePath = 'import.json';
export const IMPORT_TRANSACTION_FORMAT_VERSION = 1;

export interface ImportTransaction extends TransactionHeader {
	/** Written last and deleted first. */
	readonly project: StorePath;
	readonly paths: readonly StorePath[];
}

type ImportRefusal =
	| 'import-in-progress'
	| 'plan-mismatch'
	| 'remote-unavailable'
	| 'own-remote'
	| 'destination-exists'
	| 'insufficient-quota'
	| 'unresolved-residue'
	| 'unresolved-commit';

export class ImportRefusedError extends Error {
	override readonly name = 'ImportRefusedError';
	readonly requiredBytes: number;
	constructor(
		readonly refusal: ImportRefusal,
		message: string,
		options: { readonly requiredBytes?: number; readonly cause?: unknown } = {}
	) {
		super(message, options);
		this.requiredBytes = options.requiredBytes ?? 0;
	}
}

export const serialiseImportTransaction = (transaction: ImportTransaction): Bytes =>
	serialiseJson(transaction);

function parseImportTransaction(
	{ paths, project }: Record<string, unknown>,
	header: TransactionHeader
): ImportTransaction | null {
	if (!isStorePath(project) || !Array.isArray(paths) || !paths.every(isStorePath)) return null;
	return { ...header, project, paths };
}

export const readImportTransaction = (store: ReadOnlyProjectStore) =>
	readTransactionMark(store, IMPORT_TRANSACTION_PATH, parseImportTransaction);

export async function commitProjectImport(
	store: ProjectStore,
	source: ProjectImportSource,
	destinations: ReadonlyMap<ClosurePath, StorePath>,
	options: {
		readonly estimateStorage?: EstimateStorage;
		readonly now?: () => Date;
		readonly transaction?: () => string;
	} = {}
): Promise<{ readonly transaction: string; readonly files: number; readonly bytes: number }> {
	if ((await readImportTransaction(store)) !== null) {
		throw new ImportRefusedError(
			'import-in-progress',
			'This Workspace has an Import that has not finished, so another cannot start until it has ' +
				'been recovered. Reopen the Workspace and try again.'
		);
	}

	const plan = validatePlan(source, destinations);
	await assertDestinationsFree(store, plan.paths);

	const now = options.now ?? (() => new Date());
	const marker: ImportTransaction = {
		formatVersion: IMPORT_TRANSACTION_FORMAT_VERSION,
		transaction: options.transaction?.() ?? crypto.randomUUID(),
		state: 'writing',
		project: plan.project,
		paths: plan.paths,
		startedAt: now().toISOString()
	};

	const committed = serialiseImportTransaction({ ...marker, state: 'committed' });
	const required = source.totalBytes + 2 * committed.byteLength;
	const short = await storageShortfall(required, options.estimateStorage);
	if (short !== null) {
		throw new ImportRefusedError(
			'insufficient-quota',
			`This Project ${short} Delete a Project or a Workspace you no longer need, or free space ` +
				`on this device, and try again. Nothing has been added to your Workspace.`,
			{ requiredBytes: required }
		);
	}

	await store.write(IMPORT_TRANSACTION_PATH, serialiseImportTransaction(marker));
	let files = 0;
	let bytes = 0;
	try {
		for await (const file of source.files()) {
			if (file.path === PROJECT_FILE_NAME) continue;
			const destination = destinations.get(file.path) as StorePath;
			if ((await writeArrivedFile(store, destination, file.bytes)) === 'declined') {
				throw new Error(`${destination} already held an Alignment, which preflight ruled out`);
			}
			files += 1;
			bytes += file.bytes.byteLength;
		}
		await store.write(plan.project, source.projectFileBytes);
		files += 1;
		bytes += source.projectFileBytes.byteLength;
		await store.write(IMPORT_TRANSACTION_PATH, committed);
	} catch (cause) {
		try {
			await discardImportTransaction(store, marker);
		} catch (residue) {
			throw new ImportRefusedError(
				'unresolved-residue',
				'The Import failed and what it had already written could not be removed, so this Workspace ' +
					'stays closed until it has been recovered. Reopen it to finish clearing the Import.',
				{ cause: residue }
			);
		}
		throw cause;
	}

	try {
		await clearImportTransaction(store);
	} catch (cause) {
		throw new ImportRefusedError(
			'unresolved-commit',
			'The Project was Imported and this Workspace’s record of the Import could not be cleared, ' +
				'so it stays closed until it is reopened. Nothing has been lost — reopen the Workspace ' +
				'and the Project will be there.',
			{ cause }
		);
	}
	return { transaction: marker.transaction, files, bytes };
}

export async function discardImportTransaction(
	store: ProjectStore,
	transaction: ImportTransaction
): Promise<void> {
	await store.delete(transaction.project);
	for (const path of transaction.paths) {
		if (path !== transaction.project) await store.delete(path);
	}
	await clearImportTransaction(store);
}

export async function clearImportTransaction(store: ProjectStore): Promise<void> {
	await store.delete(IMPORT_TRANSACTION_PATH);
}

function validatePlan(
	source: ProjectImportSource,
	destinations: ReadonlyMap<ClosurePath, StorePath>
): { readonly project: StorePath; readonly paths: readonly StorePath[] } {
	const refuse = (message: string): never => {
		throw new ImportRefusedError(
			'plan-mismatch',
			`${message} Nothing has been added to your Workspace.`
		);
	};
	const paths: StorePath[] = [];
	const folded = new Map<string, StorePath>();

	for (const closure of source.paths) {
		const destination = destinations.get(closure);
		if (destination === undefined) {
			return refuse(
				`The Import was planned without a destination for “${closure}”, so the Project would ` +
					'arrive incomplete.'
			);
		}
		try {
			assertStorePath(destination);
		} catch (cause) {
			if (!(cause instanceof InvalidPathError)) throw cause;
			refuse(
				`The Import was planned to put “${closure}” at “${destination}”, which is not a path ` +
					`this Workspace can hold: ${cause.message}.`
			);
		}
		if (destination === IMPORT_TRANSACTION_PATH) {
			refuse(
				`The Import was planned to put “${closure}” at “${destination}”, which is the name the ` +
					'Workspace keeps for its own record of an Import in progress.'
			);
		}
		const key = foldName(destination);
		const taken = folded.get(key);
		if (taken !== undefined) {
			refuse(
				`The Import was planned to put two of its files at “${destination}”${
					taken === destination ? '' : ` and “${taken}”, which are one file on this computer`
				}, so one would overwrite the other.`
			);
		}
		folded.set(key, destination);
		paths.push(destination);
	}

	if (destinations.size !== paths.length) {
		refuse('The Import was planned to write files the Project does not hold.');
	}
	const project = destinations.get(PROJECT_FILE_NAME);
	if (project === undefined) {
		return refuse(`The Import was planned without a destination for ${PROJECT_FILE_NAME}.`);
	}
	return { project, paths: [...paths].sort() };
}

async function assertDestinationsFree(
	store: ProjectStore,
	destinations: readonly StorePath[]
): Promise<void> {
	const existing = new Map<string, StorePath>();
	for (const path of await store.list('')) existing.set(foldName(path), path);

	for (const destination of destinations) {
		const held = existing.get(foldName(destination));
		if (held === undefined) continue;
		throw new ImportRefusedError(
			'destination-exists',
			`This Workspace already holds “${held}”, and the Import was about to write ` +
				`“${destination}” there. Nothing has been added to your Workspace.`
		);
	}
}

export type ImportRecovery =
	| { readonly outcome: 'nothing' }
	| { readonly outcome: 'discarded'; readonly transaction: string }
	| { readonly outcome: 'completed'; readonly transaction: string };

type ImportRecoveryFailure = 'unreadable' | 'incomplete' | 'unverifiable' | 'residue';

export class ImportRecoveryFailedError extends Error {
	override readonly name = 'ImportRecoveryFailedError';
	constructor(
		readonly failure: ImportRecoveryFailure,
		message: string,
		options?: { readonly cause?: unknown }
	) {
		super(message, options);
	}
}

export async function recoverProjectImport(store: ProjectStore): Promise<ImportRecovery> {
	const mark = await readImportTransaction(store);
	if (mark === null) return { outcome: 'nothing' };
	if (mark.state === 'unreadable') {
		throw new ImportRecoveryFailedError(
			'unreadable',
			'This Workspace has a record of an Import that cannot be read, so Ballastella cannot tell ' +
				'whether the Project arrived or not and will not open the Workspace until it can. Reload ' +
				'this page to try again. Nothing has been lost.'
		);
	}
	if (mark.state === 'writing') {
		try {
			await store.reclaimAbandonedWrites('');
			await discardImportTransaction(store, mark);
		} catch (cause) {
			throw new ImportRecoveryFailedError(
				'residue',
				'An Import did not finish, and what it had already written could not be removed — so this ' +
					'Workspace stays closed rather than opening with part of a Project in it. Reload this page ' +
					'to try again. None of your own work has been touched.',
				{ cause }
			);
		}
		return { outcome: 'discarded', transaction: mark.transaction };
	}

	let missing = 0;
	for (const path of mark.paths) {
		try {
			await store.size(path);
		} catch (cause) {
			if (!(cause instanceof PathNotFoundError)) {
				throw new ImportRecoveryFailedError(
					'unverifiable',
					'An Import finished and Ballastella cannot reach this Workspace to check that the ' +
						'Project is all there, so it will not open it yet. Reload this page to try again.',
					{ cause }
				);
			}
			missing += 1;
		}
	}
	if (missing > 0) {
		throw new ImportRecoveryFailedError(
			'incomplete',
			`An Import was recorded as finished, but ${
				missing === 1 ? 'one of the Project’s files is' : `${missing} of the Project’s files are`
			} not in this Workspace — so it stays closed rather than opening with an incomplete Project ` +
				'in it. Nothing has been removed. Reload this page to try again, and if it says this every ' +
				'time, restore a Backup of this Workspace.'
		);
	}

	try {
		await clearImportTransaction(store);
	} catch (cause) {
		throw new ImportRecoveryFailedError(
			'residue',
			'An Import finished and this Workspace’s record of it could not be cleared, so it stays ' +
				'closed until that record goes. Nothing has been lost — the Project is there. Reload this ' +
				'page to try again.',
			{ cause }
		);
	}
	return { outcome: 'completed', transaction: mark.transaction };
}

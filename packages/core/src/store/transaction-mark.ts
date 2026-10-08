import {
	jsonObjectOrNull,
	readIfPresent,
	textField,
	type ReadOnlyProjectStore,
	type StorePath
} from './project-store.js';

export interface TransactionHeader {
	readonly formatVersion: number;
	readonly transaction: string;
	readonly state: 'writing' | 'committed';
	readonly startedAt: string;
}

type UnreadableMark = { readonly state: 'unreadable' };

export const isStorePath = (value: unknown): value is StorePath =>
	typeof value === 'string' && value !== '';

function transactionHeader(raw: Record<string, unknown>): TransactionHeader | null {
	const { formatVersion, state, transaction, startedAt } = raw;
	if (typeof formatVersion !== 'number') return null;
	if (state !== 'writing' && state !== 'committed') return null;
	return {
		formatVersion,
		transaction: textField(transaction),
		state,
		startedAt: textField(startedAt)
	};
}

export async function readTransactionMark<T>(
	store: ReadOnlyProjectStore,
	path: StorePath,
	parse: (raw: Record<string, unknown>, header: TransactionHeader) => T | null
): Promise<T | UnreadableMark | null> {
	const bytes = await readIfPresent(store, path).catch(() => undefined);
	if (bytes === null) return null;
	const raw = bytes && jsonObjectOrNull(bytes);
	const header = raw && transactionHeader(raw);
	return (raw && header && parse(raw, header)) ?? { state: 'unreadable' };
}

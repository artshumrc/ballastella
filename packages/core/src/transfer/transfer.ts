import { describeBytes } from '../project/workspace-size.js';
import { storageRoom, type EstimateStorage } from '../store/persistent-storage.js';

export interface TransferProgress {
	readonly files: number;
	readonly totalFiles: number;
	readonly bytes: number;
	readonly totalBytes: number;
	readonly path: string | null;
}

export type TransferProgressListener = (progress: TransferProgress) => void;

/** `null` when there is room, or when the browser will not say. */
export async function storageShortfall(
	needed: number,
	estimateStorage: EstimateStorage | undefined
): Promise<string | null> {
	const room = await storageRoom(estimateStorage);
	if (room === null || room.free >= needed) return null;
	return (
		`needs about ${describeBytes(needed)} and there is ${describeBytes(Math.max(0, room.free))} ` +
		`free — ${describeBytes(room.usage)} of the ${describeBytes(room.quota)} this browser allows ` +
		`is already in use.`
	);
}

const browserStorage = (): StorageManager | undefined =>
	typeof navigator === 'undefined' ? undefined : navigator.storage;

export async function requestPersistentStorage(
	storage = browserStorage()
): Promise<'granted' | 'refused' | 'unsupported'> {
	if (typeof storage?.persist !== 'function' || typeof storage?.persisted !== 'function') {
		return 'unsupported';
	}
	try {
		if (await storage.persisted()) return 'granted';
		return (await storage.persist()) ? 'granted' : 'refused';
	} catch {
		return 'unsupported';
	}
}

export type EstimateStorage = () => Promise<{ quota?: number; usage?: number } | null>;

/** Null when the browser will not answer: refusing because the quota API is unavailable would refuse on Safari. */
export async function storageRoom(
	estimateStorage: EstimateStorage | undefined
): Promise<{ quota: number; usage: number; free: number } | null> {
	if (!estimateStorage) return null;
	const estimate = await estimateStorage().catch(() => null);
	const quota = estimate?.quota;
	const usage = estimate?.usage;
	if (typeof quota !== 'number' || typeof usage !== 'number') return null;
	return { quota, usage, free: quota - usage };
}

export type StorageDurability =
	| { kind: 'granted' }
	| { kind: 'can-ask' }
	| { kind: 'install-to-keep' }
	| { kind: 'seven-day' }
	| { kind: 'ephemeral' }
	| { kind: 'unknown' };

export interface StorageAnswers {
	persisted: boolean | undefined;
	permission: PermissionState | undefined;
	ephemeral: boolean;
}

export interface StorageDurabilityInputs extends StorageAnswers {
	installed: boolean;
	fileSystemAccess: boolean;
}

export function deriveStorageDurability({
	persisted,
	permission,
	ephemeral,
	installed,
	fileSystemAccess
}: StorageDurabilityInputs): StorageDurability {
	if (ephemeral) return { kind: 'ephemeral' };
	if (persisted === undefined) return { kind: 'unknown' };
	if (persisted || permission === 'granted') return { kind: 'granted' };
	if (permission === undefined) return { kind: 'seven-day' };
	if (fileSystemAccess) return installed ? { kind: 'unknown' } : { kind: 'install-to-keep' };
	return permission === 'prompt' ? { kind: 'can-ask' } : { kind: 'unknown' };
}

export async function readStoragePersisted(
	storage = browserStorage()
): Promise<boolean | undefined> {
	if (typeof storage?.persisted !== 'function') return undefined;
	try {
		return await storage.persisted();
	} catch {
		return undefined;
	}
}

export async function readPersistentStoragePermission(
	permissions: Permissions | undefined = typeof navigator === 'undefined'
		? undefined
		: navigator.permissions
): Promise<PermissionState | undefined> {
	if (typeof permissions?.query !== 'function') return undefined;
	try {
		const status = await permissions.query({ name: 'persistent-storage' as PermissionName });
		return status.state;
	} catch {
		return undefined;
	}
}

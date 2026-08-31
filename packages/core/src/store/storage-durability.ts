// Whether this browser has promised to keep the work, and what the author can do about it.
//
// Its own module beside `persistent-storage.ts` because it answers a different question. That one
// *asks* the browser to keep the origin's storage and records what it said; this one turns the
// browser's answers into the one thing a scholar needs told — and, where a lever exists, which lever
// it is. The two are separate because the asking is a data-loss fix that runs whether or not anybody
// is looking (ADR-0024), and the telling is a sentence on a screen (ADR-0042).

/**
 * What a scholar's work is standing on, and the lever that would change it.
 *
 * Six states because there are six different answers to "what can I do about it", and collapsing
 * any two of them produces advice that is false on a real browser: telling a Safari user to accept
 * a prompt that will never appear, or a Firefox user to install an application their browser will
 * not persist for.
 */
export type StorageDurability =
	| { kind: 'granted' }
	| { kind: 'can-ask' }
	| { kind: 'install-to-keep' }
	| { kind: 'seven-day' }
	| { kind: 'ephemeral' }
	| { kind: 'unknown' };

/** What only the browser's storage APIs can answer. */
export interface StorageAnswers {
	/**
	 * `navigator.storage.persisted()`, or `undefined` where the Storage API cannot answer at all.
	 *
	 * ⚠ **`persisted()` and never `persist()`.** Firefox's `persist()` is what opens its permission
	 * prompt, and a prompt nobody asked for on every load is the nagging ADR-0012 rules out — it is
	 * also a promise that does not settle without a user gesture, so a durability read chained behind
	 * it would never produce a sentence on the one browser that asks.
	 */
	persisted: boolean | undefined;
	/**
	 * `navigator.permissions.query({ name: 'persistent-storage' })`'s state, or `undefined` where the
	 * browser does not know that permission name.
	 *
	 * The absence is the signal, and it is the only one WebKit gives: no `persistent-storage`
	 * permission means no grant is reachable from a page, which is what leaves ITP's seven days
	 * standing.
	 */
	permission: PermissionState | undefined;
	/**
	 * Whether this session discards its storage when it ends.
	 *
	 * A page the browser will not give `localStorage` to — a private window with site data blocked —
	 * is a session that keeps nothing, and it is the one form of that the browser will admit to.
	 */
	ephemeral: boolean;
}

/** {@link StorageAnswers}, plus the two things the application knows and the browser does not. */
export interface StorageDurabilityInputs extends StorageAnswers {
	/** Whether this page is running as an installed application. */
	installed: boolean;
	/** Whether File System Access exists here, which is also what separates the two grant models. */
	fileSystemAccess: boolean;
}

/**
 * Which of the six a browser's answers add up to.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ⚠ **NO USER-AGENT STRING IS READ, HERE OR ANYWHERE THIS IS CALLED FROM**
 *
 * The advice differs by engine, but a name is not what it is derived from: a browser may change what
 * it calls itself, and a fork or an embedded webview calls itself something nobody has a branch for.
 * Every distinction below is drawn from a capability the browser either has or has not:
 *
 * - **No `persistent-storage` permission name at all** is WebKit, and it is the substantive fact
 *   rather than a proxy for one — `NetworkStorageManager::persistOrigin` grants only app-bound,
 *   managed, persisted or standalone-application domains, so an ordinary page has no route to the
 *   grant, and ITP deletes `WebsiteDataType::FileSystem` — the OPFS store — after seven days of
 *   browser use with no interaction.
 * - **A permission that exists but is not granted, on a browser with File System Access**, is the
 *   Chromium grant model: Chromium answers `persist()` from its own heuristics and opens no dialog
 *   ever, and an installed domain is granted persistence outright. So the lever is installing, and
 *   telling that user "the browser will ask" would be a lie.
 * - **A permission that exists but is not granted, with no File System Access**, is the Firefox
 *   model: it is the one engine that really asks, and granting also raises its ceiling.
 *
 * An installed application that is *still* not persisted has no lever left that this can name, so it
 * is `unknown` rather than an offer to install something already installed.
 */
export function deriveStorageDurability({
	persisted,
	permission,
	ephemeral,
	installed,
	fileSystemAccess
}: StorageDurabilityInputs): StorageDurability {
	// First, because it is the only state where nothing else on this list would be worth saying: a
	// grant on storage that goes when the window closes is a promise about nothing.
	if (ephemeral) return { kind: 'ephemeral' };
	// No Storage API to answer with. Nothing below can be inferred from a permission alone.
	if (persisted === undefined) return { kind: 'unknown' };
	if (persisted || permission === 'granted') return { kind: 'granted' };
	if (permission === undefined) return { kind: 'seven-day' };
	if (fileSystemAccess) return installed ? { kind: 'unknown' } : { kind: 'install-to-keep' };
	// `denied` is a prompt this author has already refused for good; offering it again would be a
	// control that does nothing.
	return permission === 'prompt' ? { kind: 'can-ask' } : { kind: 'unknown' };
}

/**
 * Whether this origin's storage is already persisted, without asking for it.
 *
 * `undefined` for a browser that cannot answer, which is not the same as a refusal and must not be
 * reported as one. See {@link StorageAnswers.persisted} for why `persist()` is not called here.
 */
export async function readStoragePersisted(
	storage: StorageManager | undefined = typeof navigator === 'undefined'
		? undefined
		: navigator.storage
): Promise<boolean | undefined> {
	if (typeof storage?.persisted !== 'function') return undefined;
	try {
		return await storage.persisted();
	} catch {
		return undefined;
	}
}

/**
 * What the browser says about the `persistent-storage` permission, or `undefined` where it does not
 * know the name.
 *
 * Querying prompts for nothing — it is `persist()` that would — so this is safe on load, which is
 * what lets the sentence be there before anybody presses anything.
 */
export async function readPersistentStoragePermission(
	permissions: Permissions | undefined = typeof navigator === 'undefined'
		? undefined
		: navigator.permissions
): Promise<PermissionState | undefined> {
	if (typeof permissions?.query !== 'function') return undefined;
	try {
		// `PermissionName` does not include `persistent-storage` in TypeScript's DOM library, and the
		// browsers that have it are exactly the ones this distinguishes between.
		const status = await permissions.query({ name: 'persistent-storage' as PermissionName });
		return status.state;
	} catch {
		// A `TypeError` for an unknown permission name is WebKit's answer, and it is an answer.
		return undefined;
	}
}

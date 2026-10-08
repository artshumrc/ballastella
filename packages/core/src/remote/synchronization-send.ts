import type { ProjectStore } from '../store/project-store.js';
import {
	planRemoteSend,
	sendToRemote,
	type PendingLocalFile,
	type RemoteSendPlan,
	type SendToRemoteOptions
} from './send-to-remote.js';
import type { SynchronizationMetadata } from './synchronization-metadata.js';

interface SharedStateRecorder {
	clearShared(paths: Iterable<string>): Promise<boolean>;
}

interface SendWorkspaceOptions extends Pick<
	SendToRemoteOptions,
	'token' | 'remote' | 'fetch' | 'onProgress'
> {
	readonly metadata?: SynchronizationMetadata;
	readonly changes?: SharedStateRecorder;
	readonly overwrite?: readonly string[];
	readonly pending?: readonly PendingLocalFile[];
}

export async function sendWorkspaceToRemote(
	store: ProjectStore,
	options: SendWorkspaceOptions
): Promise<{
	readonly commit: string;
	readonly plan: RemoteSendPlan;
	readonly baselineKept: boolean;
	readonly shared: readonly string[];
}> {
	const { metadata, changes, overwrite, pending, onProgress, ...request } = options;
	const plan = await planRemoteSend(store, {
		...request,
		baseline: (await metadata?.readBaseline(request.remote)) ?? null,
		...(pending === undefined ? {} : { pending })
	});
	const { commit, baseline, shared } = await sendToRemote(store, {
		...request,
		plan,
		...(overwrite === undefined ? {} : { overwrite }),
		...(onProgress === undefined ? {} : { onProgress })
	});

	const baselineKept =
		metadata === undefined ||
		(await metadata.writeBaseline({ remote: request.remote, commit, files: baseline }));
	if (baselineKept) await changes?.clearShared(shared);
	return { commit, plan, baselineKept, shared };
}

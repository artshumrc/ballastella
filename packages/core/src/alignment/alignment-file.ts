import type {
	Bytes,
	AlignmentPath,
	ProjectStore,
	StorePath,
	WritablePath
} from '../store/project-store.js';
import { PathNotFoundError, sameBytes } from '../store/project-store.js';
import { alignmentImageId, alignmentPath, newAlignment, type Alignment } from './alignment.js';
import { serialiseAlignment, type AlignmentAddress } from './georeference-annotation.js';

export type AlignmentWrite =
	| { readonly intent: 'create' }
	| { readonly intent: 'update'; readonly basedOn?: Bytes | null }
	| { readonly intent: 'replace'; readonly discarding: string };

export type AlignmentWriteOutcome =
	'written' | 'left alone' | 'kept over the offer' | 'written over a change';

type AlignmentWriteReport = {
	readonly outcome: AlignmentWriteOutcome;
	readonly written: Bytes | null;
	readonly displaced: Bytes | null;
};

export interface AlignmentFilePort {
	read(path: StorePath): Promise<Bytes>;
	commit(path: WritablePath, bytes: Bytes): Promise<void>;
}

type AlignmentFileRequest = {
	readonly alignment: Alignment;
	readonly write: AlignmentWrite;
	readonly address?: AlignmentAddress;
};

export async function writeAlignmentFileReporting(
	port: AlignmentFilePort,
	{ alignment, write, address = {} }: AlignmentFileRequest
): Promise<AlignmentWriteReport> {
	const path = alignmentPath(alignment.imageId);
	const wanted = serialiseAlignment(alignment, address);

	if (write.intent !== 'create') {
		const displaced =
			write.intent === 'update' && write.basedOn !== undefined
				? await changedSince(port, path, write.basedOn)
				: null;
		await commit(port, path, wanted);
		return { outcome: displaced ? 'written over a change' : 'written', written: wanted, displaced };
	}

	const starter = serialiseAlignment(newAlignment(alignment.imageId, alignment.image), address);
	const offering = !sameBytes(wanted, starter);
	const state = await existing(port, path, starter);
	if (state === 'none' || (state === 'untouched' && offering)) {
		await commit(port, path, wanted);
		return { outcome: 'written', written: wanted, displaced: null };
	}
	const outcome = state === 'worked on' && offering ? 'kept over the offer' : 'left alone';
	return { outcome, written: null, displaced: null };
}

async function changedSince(
	port: AlignmentFilePort,
	path: AlignmentPath,
	basedOn: Bytes | null
): Promise<Bytes | null> {
	let stored: Bytes;
	try {
		stored = await port.read(path);
	} catch {
		return null;
	}
	return basedOn !== null && sameBytes(stored, basedOn) ? null : stored;
}

export async function writeAlignmentBytes(
	port: AlignmentFilePort,
	{
		imageId,
		bytes,
		write
	}: { readonly imageId: string; readonly bytes: Bytes; readonly write: AlignmentWrite }
): Promise<AlignmentWriteOutcome> {
	const path = alignmentPath(imageId);
	if (write.intent === 'create' && (await existing(port, path, null)) !== 'none') {
		return 'kept over the offer';
	}
	await commit(port, path, bytes);
	return 'written';
}

export async function writeArrivedFile(
	store: Pick<ProjectStore, 'read' | 'write'>,
	path: StorePath,
	bytes: Bytes,
	write: AlignmentWrite = { intent: 'create' }
): Promise<'written' | 'declined'> {
	const imageId = alignmentImageId(path);
	if (imageId === null) {
		await store.write(path, bytes);
		return 'written';
	}
	const outcome = await writeAlignmentBytes(
		{ read: (at) => store.read(at), commit: (at, content) => store.write(at, content) },
		{ imageId, bytes, write }
	);
	return outcome === 'written' ? 'written' : 'declined';
}

async function existing(
	port: AlignmentFilePort,
	path: AlignmentPath,
	starter: Bytes | null
): Promise<'none' | 'untouched' | 'worked on'> {
	let stored: Bytes;
	try {
		stored = await port.read(path);
	} catch (cause) {
		return cause instanceof PathNotFoundError ? 'none' : 'worked on';
	}
	return starter !== null && sameBytes(stored, starter) ? 'untouched' : 'worked on';
}

// The brand is a phantom property, so this cast is the only conversion there is.
const commit = (port: AlignmentFilePort, path: AlignmentPath, bytes: Bytes): Promise<void> =>
	port.commit(path as unknown as WritablePath, bytes);

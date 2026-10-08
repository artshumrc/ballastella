import {
	PathNotFoundError,
	asRecord,
	jsonObjectOrNull,
	serialiseJson,
	textField,
	type Bytes,
	type ReadOnlyProjectStore,
	type StorePath
} from '../store/project-store.js';

export const REVIEW_MARK_PATH = 'review.json' as StorePath;
export const REVIEW_MARK_FORMAT_VERSION = 1;

type ReviewOriginBacking = 'browser' | 'folder';

export interface ReviewOrigin {
	readonly workspaceKey: string;
	readonly backing: ReviewOriginBacking;
	readonly name: string;
	readonly folderReference: string;
}

export interface ReviewMark {
	readonly formatVersion: number;
	readonly project: string;
	readonly directory: string;
	readonly openedAt: string;
	readonly origin: ReviewOrigin | null;
}

export const serialiseReviewMark = (mark: ReviewMark): Bytes => serialiseJson(mark);

export function parseReviewMark(bytes: Bytes): ReviewMark | null {
	const record = jsonObjectOrNull(bytes);
	if (record === null) return null;
	const formatVersion = record['formatVersion'];
	if (typeof formatVersion !== 'number') return null;
	return {
		formatVersion,
		project: textField(record['project']),
		directory: textField(record['directory']),
		openedAt: textField(record['openedAt']),
		origin: parseReviewOrigin(record['origin'])
	};
}

function parseReviewOrigin(raw: unknown): ReviewOrigin | null {
	const record = asRecord(raw);
	if (record === null) return null;
	const workspaceKey = textField(record['workspaceKey']);
	const backing = record['backing'];
	const name = textField(record['name']);
	const folderReference = textField(record['folderReference']);
	if (workspaceKey === '' || name === '') return null;
	if (backing !== 'browser' && backing !== 'folder') return null;
	if (backing === 'folder' && folderReference === '') return null;
	return { workspaceKey, backing, name, folderReference };
}

export async function readReviewMark(store: ReadOnlyProjectStore): Promise<ReviewMark | null> {
	let bytes: Bytes;
	try {
		bytes = await store.read(REVIEW_MARK_PATH);
	} catch (cause) {
		if (cause instanceof PathNotFoundError) return null;
		return unreadableMark();
	}
	return parseReviewMark(bytes) ?? unreadableMark();
}

const unreadableMark = (): ReviewMark => ({
	formatVersion: REVIEW_MARK_FORMAT_VERSION,
	project: '',
	directory: '',
	openedAt: '',
	origin: null
});

export class ReviewWorkspaceError extends Error {
	override readonly name = 'ReviewWorkspaceError';
}

export function describeReviewSubject(mark: ReviewMark): string {
	return mark.project ? `“${mark.project}”` : 'a Project somebody sent you';
}

export function assertNotReviewing(
	workspaceName: string,
	mark: ReviewMark | null,
	verb: string
): void {
	if (mark === null) return;
	throw new ReviewWorkspaceError(
		`“${workspaceName}” is a review copy of ${describeReviewSubject(mark)}, so it cannot be ` +
			`${verb}. It holds somebody else's work and is meant to be discarded. Go back to your own ` +
			`Workspace first.`
	);
}

export function assertReviewing(workspaceName: string, mark: ReviewMark | null): void {
	if (mark !== null) return;
	throw new ReviewWorkspaceError(
		`“${workspaceName}” is one of your own Workspaces rather than a review copy, so it is not ` +
			`discarded from here. The Workspace list on the bar is where a Workspace of your own is ` +
			`deleted.`
	);
}

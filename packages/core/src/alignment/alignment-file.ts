// The one writer of `alignments/<image-id>.json` (ticket 18).
//
// **This module is the only place in the codebase where an `AlignmentPath` becomes a
// `WritablePath`**, and therefore the only place an Alignment can be written at all. Everything
// else in the application — every pane, every route, every importer — comes through
// {@link writeAlignmentFile} and has to say which of three things it means.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A MODULE FOR ONE FILE
//
// ADR-0023 made an Alignment belong to the **Workspace**, shared by every Project that draws the
// map. Before that, an Alignment belonged to one Project and clobbering it could only cost you the
// work in front of you. Afterwards it can cost somebody else's afternoon, in a Project you are not
// looking at and have possibly never opened.
//
// Nothing in the code was changed to reflect what that means for a write, and **three separate
// tickets in this epic then independently wrote a blind overwrite of the file**, none of them
// noticing, each caught only by review — in one case two lines from a correct guard doing exactly
// the right thing. Two authors reaching for the same mistake is a missing invariant, not two
// lapses, and the third instance is a matter of time.
//
// So the invariant is made structural in two layers that fail at different moments:
//
//   1. **The type**, which fails the build. `alignmentPath` returns an `AlignmentPath`;
//      `ProjectStore.write` and `Autosave.commit` take a `WritablePath`, which an `AlignmentPath`
//      is not. A blind write through a path helper does not compile.
//   2. **The fence**, `scripts/check-alignment-writers.mjs`, which catches what a type cannot: the
//      literal `'alignments/x.json'` spelled out by hand, which is how a *test fixture* writes one
//      and how the assertions above it go quietly vacuous.
//
// The failure mode is why neither is a review comment. An overwrite does not throw, does not log,
// and does not 404; it shows up as a colleague's Control Points quietly gone. This is the same
// argument `check-workspace-rooted-paths.mjs` makes about a Project-rooted image path, on the same
// file, for the same reason.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// READING AN ALIGNMENT MUST NEVER WRITE ONE
//
// There is deliberately **no** "read it, or make one if it is missing" function here, and there
// will not be one. Opening a view, resolving a Layer, computing an opening view, and listing the
// Workspace are all reads (ADR-0010). If a read path needs an Alignment to exist, that is a bug in
// whatever was supposed to create it — the add gesture — and not a licence to create it lazily. An
// earlier draft of the `/align/` route did exactly that, by routing `readAlignment` into
// `writeAlignment`, and in a git or Dropbox Workspace merely opening a view became a sync event.

import type { Bytes, AlignmentPath, StorePath, WritablePath } from '../store/project-store.js';
import { PathNotFoundError } from '../store/project-store.js';
import { alignmentPath, newAlignment, type Alignment } from './alignment.js';
import { serialiseAlignment, type AlignmentAddress } from './georeference-annotation.js';

/**
 * Which of three things a caller means by writing an Alignment.
 *
 * **A caller that cannot say which one it means is a caller that has not decided**, and this is the
 * argument that will not let it past. The three are not degrees of force; they are three different
 * claims about what is on disk and who it belongs to.
 */
export type AlignmentWrite =
	/**
	 * **Create** — this map has no Alignment worth keeping, so give it this one.
	 *
	 * Writes when there is no file at all, or when the file is still byte-identical to the starter
	 * this build would write for this map — which means nothing has happened to it since it was
	 * created and there is nothing to lose. Anything else is kept, and the caller is told so.
	 *
	 * This is the starter Alignment written when a Historical Map is added to the Workspace, and it
	 * is the community Alignment a user accepts on the add. **The community offer is the case this
	 * distinction exists for.** A remote resource's image id is `generateId(uri)`, the same for
	 * everybody, so "accept the offer" in Project B is not overwriting a file you just made: it is
	 * discarding the Control Points somebody placed in Project A, from a gesture that said nothing
	 * about Project A.
	 */
	| { readonly intent: 'create' }
	/**
	 * **Update** — write the result of a user's edit to the Alignment they are looking at.
	 *
	 * Control Point placement, a mask vertex dragged, the transformation type changed. The user has
	 * this Alignment open and this is their edit of it, so there is no existence question to ask:
	 * whatever is on disk is what they are editing.
	 *
	 * It is still narrower than a blind write in the one way that matters. An `update` is *this*
	 * Alignment written back, which means it started as a read — so a member of the document this
	 * build does not model comes back out again (see `Alignment.unmodelled`), where a rewrite
	 * generated from scratch would drop it.
	 */
	| { readonly intent: 'update' }
	/**
	 * **Replace** — deliberately discard an existing Alignment for a different one.
	 *
	 * Only ever as the result of a user saying so, and `discarding` is the words in which they were
	 * told what they were losing. It is a required field rather than an optional note because a
	 * replacement nobody can describe is a replacement nobody agreed to; if the call site cannot
	 * fill this in, it is a `create` that has not admitted the file might already be there.
	 *
	 * Nothing in the application uses this today. It is here because the contract has three cases
	 * and a two-case type would send the third one back to a blind write the first time it is
	 * needed.
	 */
	| { readonly intent: 'replace'; readonly discarding: string };

/**
 * What became of the file.
 *
 * Three answers rather than `void`, because a `create` that declines is not a failure and must not
 * be reported as one — but it is also not nothing, and the user did ask for something. A caller
 * that ignores this is a caller that will silently tell somebody their community Alignment was
 * accepted when it was not.
 */
export type AlignmentWriteOutcome =
	/** The bytes are on disk. */
	| 'written'
	/** There was already an Alignment and the caller was only offering the starter. Ordinary. */
	| 'left alone'
	/** There was work in the file and the caller's offer was refused to protect it. Say so. */
	| 'kept over the offer';

/**
 * The two operations this module needs from storage, and nothing else.
 *
 * A port rather than a `ProjectStore`, so the writer is the same object in the editor — where the
 * commit goes through `Autosave`, and must, or a Control Point write would bypass rule 2's
 * per-file debounce and rule 5's save state — and in a test, where it is a `MemoryProjectStore`.
 * The decision about what may be written is then one piece of code exercised by both.
 */
export interface AlignmentFilePort {
	read(path: StorePath): Promise<Bytes>;
	commit(path: WritablePath, bytes: Bytes): Promise<void>;
}

/**
 * The one function that writes an Alignment.
 *
 * @param request.alignment what to write. Its `imageId` chooses the file.
 * @param request.write which of create / update / replace this is. See {@link AlignmentWrite}.
 * @param request.address where the image is served from — the Library's service for a referenced
 *   map, omitted for a local pyramid (ADR-0007). **One argument rather than a `serialise` callback**,
 *   because a callback is a second serialiser at the call site and the two spellings drift; this is
 *   the same value `serialiseAlignment` takes and it goes straight through.
 * @returns what became of the file, which the caller is expected to tell the user about.
 */
export async function writeAlignmentFile(
	port: AlignmentFilePort,
	request: {
		readonly alignment: Alignment;
		readonly write: AlignmentWrite;
		readonly address?: AlignmentAddress;
	}
): Promise<AlignmentWriteOutcome> {
	const { alignment, write, address = {} } = request;
	const path = alignmentPath(alignment.imageId);
	const wanted = serialiseAlignment(alignment, address);

	if (write.intent !== 'create') {
		// `update` and `replace` both assert that the caller knows what is there — the user has it
		// open, or has been told in words what they are discarding. There is nothing to check.
		await port.commit(writable(path), wanted);
		return 'written';
	}

	// The bytes this build would write for a brand-new Alignment of this map. Both halves of the
	// decision below are measured against it.
	const starter = serialiseAlignment(newAlignment(alignment.imageId, alignment.image), address);
	const offering = !sameBytes(wanted, starter);

	switch (await existing(port, path, starter)) {
		case 'none':
			return commitAs(port, path, wanted, 'written');
		case 'untouched':
			// Nothing has happened to the file since it was created, so there is nothing to lose. An
			// offer replaces it; the starter is already what is there, and rewriting identical bytes is
			// a diff in a git Workspace for no reason.
			return offering ? commitAs(port, path, wanted, 'written') : 'left alone';
		case 'worked on':
			// Somebody's work is in that file, possibly in another Project. The ordinary re-add of a map
			// is not worth a word to anybody; a refused offer is, because the user asked for it.
			return offering ? 'kept over the offer' : 'left alone';
	}
}

async function commitAs(
	port: AlignmentFilePort,
	path: AlignmentPath,
	bytes: Bytes,
	outcome: AlignmentWriteOutcome
): Promise<AlignmentWriteOutcome> {
	await port.commit(writable(path), bytes);
	return outcome;
}

/**
 * What this Workspace already holds for a Historical Map, as far as writing over it goes.
 *
 * **Three answers rather than "is there a file", because that is not the question.** An Alignment
 * nobody has touched — the starter this build writes on the add — holds no work at all, so
 * replacing it destroys nothing.
 *
 * **The comparison is on the bytes rather than on `controlPoints.length`**, and that is the point of
 * doing it this way: the Resource Mask is editable without placing a single Control Point, so a
 * count would read a carefully cropped sheet as untouched and throw the crop away. Byte-identity
 * with the starter means *nothing has happened to this file since it was created*.
 */
async function existing(
	port: AlignmentFilePort,
	path: AlignmentPath,
	starter: Bytes
): Promise<'none' | 'untouched' | 'worked on'> {
	let stored: Bytes;
	try {
		stored = await port.read(path);
	} catch (cause) {
		// Only "no such path" means there is nothing there. A folder whose permission was revoked, or a
		// backend that is down, answers `'worked on'` — the safe direction. The cost of a false "there
		// is one" is a Historical Map added without its starter Alignment, which the next add of the
		// same map writes; the cost of a false "there is none" is Control Points somebody spent an
		// afternoon placing, gone with no message.
		return cause instanceof PathNotFoundError ? 'none' : 'worked on';
	}
	return sameBytes(stored, starter) ? 'untouched' : 'worked on';
}

function sameBytes(left: Bytes, right: Bytes): boolean {
	if (left.length !== right.length) return false;
	return left.every((byte, index) => byte === right[index]);
}

/**
 * The one crossing in the codebase from an `AlignmentPath` to a `WritablePath`.
 *
 * It is a cast, and it can only be a cast — the brand is a phantom property, so there is nothing to
 * convert at runtime. What matters is that it is *here*, in the module that has already made the
 * caller say which of create / update / replace they mean, and that a second one written anywhere
 * else is a line in a diff saying "I am opting out of the guard on a file shared by every Project".
 */
const writable = (path: AlignmentPath): WritablePath => path as unknown as WritablePath;

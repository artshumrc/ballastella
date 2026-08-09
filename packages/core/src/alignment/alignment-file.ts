// The one writer of `alignments/<image-id>.json` (ticket 18).
//
// **This module is the only place in the codebase where an `AlignmentPath` becomes a
// `WritablePath`.** Everything in the application that writes one — every pane, every route, both
// tar readers — comes through {@link writeAlignmentFile}, {@link writeAlignmentFileReporting} or
// {@link writeAlignmentBytes} and has to say which of three things it means.
//
// Since ticket 07 it is also the only place that can *notice* a concurrent edit, for the same reason:
// the re-read has to happen immediately before the commit, and the commit is here. See
// {@link AlignmentWrite}'s `update`, which states both what that delivers and what it does not.
//
// That is a claim about this codebase as it stands, kept true by a type and a fence, and **not** a
// claim that the language makes a blind write impossible. It does not: `WritablePath` accepts any
// plain `string`, so a path the compiler cannot see as an Alignment's is accepted, and the fence
// covers the spellings that produces rather than the whole space of them. The honest summary is
// that the cheap ways in are closed and the remaining ones are conspicuous. See the two layers
// below for exactly where the line is.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A MODULE FOR ONE FILE
//
// ADR-0023 made an Alignment belong to the **Workspace**, shared by every Project that draws the
// map. Before that, an Alignment belonged to one Project and clobbering it could only cost you the
// work in front of you. Afterwards it can cost somebody else's afternoon, in a Project you are not
// looking at and have possibly never opened.
//
// Nothing in the code was changed to reflect what that means for a write, and **two blind
// overwrites of the file were then written independently** — ticket 02's community-Alignment import
// and ticket 03's Align route — neither author noticing, each caught only by review. Ticket 02's
// starter path guards correctly two lines from its own unguarded write, so the same author wrote
// the check and missed the hole beside it. That is a missing invariant, not two lapses.
//
// A **third** existence check, spelled differently again, was found in the Project-zip importer
// during this ticket's own review — a module ticket 14 has since deleted with the whole zip path. It was not a live overwrite — see `project/workspace.ts` for
// exactly why — but it was a third answer to one question, in a place nobody had thought to look.
// Three independent spellings is the argument for this module existing, more than any one of them.
//
// So the invariant is made structural in two layers that fail at different moments:
//
//   1. **The type**, which fails the build. `alignmentPath` returns an `AlignmentPath`;
//      `ProjectStore.write`, `Autosave.commit` and `Autosave.queue` take a `WritablePath`, which an
//      `AlignmentPath` is not. A blind write through the path helper does not compile.
//
//      **It refuses that and nothing more, which is worth being exact about.** `WritablePath`
//      brands with an optional property so that every ordinary `string` path stays assignable
//      without a cast; the price is that an Alignment path the compiler sees as a plain `string`
//      is accepted. A `const` holding a template literal is enough to launder one past.
//   2. **The fence**, `scripts/check-alignment-writers.mjs`, which covers the spellings the type
//      cannot see — the literal written out by hand, the path laundered through a local, a detached
//      write method, and a second cast — and lists every opted-out fixture write on success.
//
// Neither can see a path computed at runtime from data. The two places that happen are the tar
// readers — `transfer/restore-workspace-tar.ts` and `transfer/open-project-bundle.ts` — and both are
// routed through {@link writeAlignmentBytes} rather than fenced. `scripts/check-alignment-writers.mjs`
// keeps that list current, because a fence whose honesty statement names a deleted file is one
// nobody can check the honesty of.
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
	 * **What an `update` does and does not protect.** It started as a read, so the members of the
	 * document this build does not model come back out again — see `Alignment.unmodelled`. It does
	 * **not** carry the `address`: `target.source.id` is modelled but not stored on `Alignment`, so
	 * an `update` that omits `address` rewrites it to the ADR-0004 placeholder. That is right for a
	 * map whose pyramid is here and wrong for one referenced from a Library, and it is the caller's
	 * to say. Both callers in the editor now do, explicitly.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * ⚠ **A CONCURRENT EDIT IS NOW SEEN AND SAID, NOT PREVENTED** (ticket 07).
	 *
	 * `update` writes what the user has, over whatever is there — so if a colleague changed the same
	 * Alignment through a synced Workspace since this one was read, their change is gone. ADR-0023
	 * accepts that and is precise about the terms: the mitigation is **visibility, not prevention**.
	 * Ticket 14 wrote the mitigation down and deferred it; the align route is the path that reaches
	 * this, so it is built here.
	 *
	 * {@link basedOn} is what makes it possible: the bytes the caller believes are on disk. When it
	 * is supplied, the file is re-read immediately before the commit and compared. If it has changed,
	 * the write still happens — **losing the edit in front of the user to protect one they cannot see
	 * would be the worse trade, and it is not what ADR-0023 asks for** — and the outcome says so, with
	 * the displaced bytes handed back so the caller can offer them. That is the "let them choose" half:
	 * a choice made *after* the save, which is the only kind available on a path where every gesture
	 * end is a write.
	 *
	 * **The comparison is bytes, not a model.** `Alignment.unmodelled` means two documents can be
	 * semantically equal and byte-different, so a model comparison would call a colleague's edit
	 * "no change" whenever this build happens not to model the field they touched. The honest claim is
	 * "the file changed", which is what a scholar can act on.
	 *
	 * **What it still does not do, stated rather than left to be discovered.** It is a check-then-write
	 * with no lock — nothing in the Web platform offers one across a Dropbox or git sync — so a change
	 * landing *between* the re-read and the commit is still lost silently. The window is narrowed from
	 * "however long the alignment view has been open", which is minutes, to the duration of one store
	 * write. It is not closed, and no test here should be read as claiming it is.
	 *
	 * **`basedOn: null` is a caller that knows the file was absent**; `undefined` — the field omitted —
	 * is a caller that is not making the claim at all, and gets ticket 18's behaviour unchanged. The
	 * two are different on purpose: a required field would have forced every existing `update` to
	 * invent an answer.
	 */
	| { readonly intent: 'update'; readonly basedOn?: Bytes | null }
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
	| 'kept over the offer'
	/**
	 * The bytes are on disk, **and they replaced a version this caller had never seen** (ticket 07).
	 *
	 * Somebody else changed this Alignment through a synced Workspace while the user had it open. The
	 * user's edit was written — see {@link AlignmentWrite}'s `update` for why that direction — so this
	 * is not a failure, but it is the one outcome the user must be told about, because the thing they
	 * lost is invisible: it was never on their screen. What was displaced comes back on
	 * {@link AlignmentWriteReport.displaced}.
	 */
	| 'written over a change';

/**
 * What became of the file, with the one thing an outcome alone cannot carry.
 *
 * Only {@link writeAlignmentFileReporting} returns this; {@link writeAlignmentFile} keeps returning
 * the bare outcome, because a caller that has no concurrency story to tell should not be made to
 * destructure one.
 */
export type AlignmentWriteReport = {
	readonly outcome: AlignmentWriteOutcome;
	/**
	 * The bytes now on disk, or `null` when nothing was written.
	 *
	 * **Returned rather than left to the caller to re-derive.** A caller tracking what it believes is
	 * on disk — which is what makes the concurrency check above possible at all — would otherwise have
	 * to call `serialiseAlignment` itself, and a second serialiser at the call site is exactly the
	 * drift `writeAlignmentFile`'s `address` argument exists to avoid. Two spellings of the bytes would
	 * make every write report itself as a concurrent change.
	 */
	readonly written: Bytes | null;
	/**
	 * The bytes that were on disk and have just been written over, when the outcome is
	 * `'written over a change'`. `null` otherwise.
	 *
	 * **Handed back rather than merely reported gone.** "Your colleague's edit was overwritten" with
	 * nothing attached is a sentence that helps nobody; with the document in hand the caller can offer
	 * to put it back, which is the choice ADR-0023's "visibility" is for. Holding it costs one
	 * Alignment document in memory, which is kilobytes.
	 */
	readonly displaced: Bytes | null;
};

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
	return (await writeAlignmentFileReporting(port, request)).outcome;
}

/**
 * {@link writeAlignmentFile}, with the displaced bytes when there were any.
 *
 * The same function — `writeAlignmentFile` delegates to this one — split only so that the concurrency
 * report is opt-in at the call site rather than a tuple every existing caller has to unpack. There is
 * still exactly one implementation of the decision, which is the whole point of this module.
 */
export async function writeAlignmentFileReporting(
	port: AlignmentFilePort,
	request: {
		readonly alignment: Alignment;
		readonly write: AlignmentWrite;
		readonly address?: AlignmentAddress;
	}
): Promise<AlignmentWriteReport> {
	const { alignment, write, address = {} } = request;
	const path = alignmentPath(alignment.imageId);
	const wanted = serialiseAlignment(alignment, address);

	// `discarding` is deliberately not logged, stored, or returned, and this is where that is said
	// rather than left to be noticed. **The compiler is the whole point of the field.** Its job is to
	// make a caller stop and put into words what the user is losing, at the moment they choose
	// `replace` over `create`; once they have, the words belong in the dialog the user actually read,
	// which is the caller's to write and not this module's to second-guess. A required field nobody
	// reads is a strange thing to leave unexplained, so: it is read by the person writing the call.
	void (write.intent === 'replace' ? write.discarding : '');

	if (write.intent !== 'create') {
		// `replace` asserts the user has been told in words what they are discarding, so there is
		// nothing left to check. An `update` that named the bytes it is based on is checked here —
		// see {@link AlignmentWrite} for why the write goes ahead either way, and for the window this
		// narrows rather than closes.
		const displaced =
			write.intent === 'update' && write.basedOn !== undefined
				? await changedSince(port, path, write.basedOn)
				: null;
		await port.commit(writable(path), wanted);
		return {
			outcome: displaced ? 'written over a change' : 'written',
			written: wanted,
			displaced
		};
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
			return offering ? commitAs(port, path, wanted, 'written') : report('left alone');
		case 'worked on':
			// Somebody's work is in that file, possibly in another Project. The ordinary re-add of a map
			// is not worth a word to anybody; a refused offer is, because the user asked for it.
			return report(offering ? 'kept over the offer' : 'left alone');
	}
}

/**
 * The bytes on disk if they are not the ones the caller was working from, or `null`.
 *
 * `null` also for a file that has gone — a colleague deleting the Alignment and this write putting one
 * back is not a change written over, it is a file restored, and reporting it as a loss would put a
 * warning in front of a user who has lost nothing. And `null` for a file that cannot be read: unlike
 * {@link existing}, where unreadable has to mean "assume there is work here", the safe direction is the
 * other one. This decides only what the user is *told*; the write happens regardless, so a false alarm
 * here is a scary sentence about a document nobody can produce.
 */
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
	if (basedOn !== null && sameBytes(stored, basedOn)) return null;
	return stored;
}

const report = (
	outcome: AlignmentWriteOutcome,
	written: Bytes | null = null
): AlignmentWriteReport => ({
	outcome,
	written,
	displaced: null
});

/**
 * The same three intents, for a caller holding **bytes it must not re-serialise**.
 *
 * This is the two tar readers — `restore-workspace-tar.ts` and `open-project-bundle.ts` — and they
 * are the callers that cannot go through
 * {@link writeAlignmentFile}. What they are copying is a document somebody else's build wrote, and
 * routing it through `Alignment` and back would regenerate it from this build's model — which is
 * exactly the loss SPEC story 60 forbids and `Alignment.unmodelled` exists to prevent. So the bytes
 * travel verbatim, and only the *decision* is shared.
 *
 * **`create` here is narrower than `create` above, and it has to be.** Deciding that a stored
 * Alignment is an untouched starter means comparing it against the starter this build would write
 * for that map, and that needs the image's pixel dimensions, which an archive entry does not carry.
 * So there is no `'untouched'` case: anything already on disk is kept. That is the safe direction —
 * the cost is an imported Alignment declined in favour of a starter, which re-importing after
 * deleting the map repairs, against Control Points that cannot be got back.
 *
 * @returns `'written'`, or `'kept over the offer'` when the destination already had one. Never
 *   `'left alone'`: an archive always carries a document somebody meant, so a decline is always
 *   worth reporting.
 */
export async function writeAlignmentBytes(
	port: AlignmentFilePort,
	request: {
		readonly imageId: string;
		readonly bytes: Bytes;
		readonly write: AlignmentWrite;
	}
): Promise<AlignmentWriteOutcome> {
	const { imageId, bytes, write } = request;
	const path = alignmentPath(imageId);

	// The two tar readers are copying a document into a Workspace nobody has open, so there is no
	// "the bytes I was working from" for them to name and nothing here consults `basedOn`.
	if (write.intent !== 'create') return (await commitAs(port, path, bytes, 'written')).outcome;

	try {
		await port.read(path);
	} catch (cause) {
		if (cause instanceof PathNotFoundError) {
			return (await commitAs(port, path, bytes, 'written')).outcome;
		}
		// Unreadable is not absent. See {@link existing} for why that direction is the safe one.
	}
	return 'kept over the offer';
}

async function commitAs(
	port: AlignmentFilePort,
	path: AlignmentPath,
	bytes: Bytes,
	outcome: AlignmentWriteOutcome
): Promise<AlignmentWriteReport> {
	await port.commit(writable(path), bytes);
	return report(outcome, bytes);
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

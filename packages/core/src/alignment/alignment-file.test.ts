import { describe, expect, it } from 'vitest';

import { Autosave } from '../autosave/autosave.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath, WritablePath } from '../store/project-store.js';
import { seedAlignmentFixture } from './alignment-fixture.js';
import { alignmentPath, newAlignment, type Alignment, type ControlPoint } from './alignment.js';
import {
	writeAlignmentFile,
	writeAlignmentFileReporting,
	type AlignmentFilePort
} from './alignment-file.js';
import { parseAlignment, serialiseAlignment } from './georeference-annotation.js';

// Ticket 18's whole subject: `alignments/<image-id>.json` belongs to the Workspace and is shared by
// every Project that draws the map (ADR-0023), so a write that does not ask what is already there
// can destroy Control Points somebody placed in a Project nobody has open.
//
// **The unguarded direction is what is asserted here**, not merely the guarded one. A test that only
// checks "the starter is written when there is no file" passes just as happily against a blind
// overwrite, which is how two tickets in this epic shipped one.

const IMAGE = { width: 4000, height: 3000 };
const IMAGE_ID = 'floride-1657';

const path = `alignments/${IMAGE_ID}.json`;

const point = (ordinal: number): ControlPoint => ({
	id: `p${ordinal}`,
	ordinal,
	resource: { x: 100 * ordinal, y: 200 * ordinal },
	geo: { lng: 4.9 + ordinal / 100, lat: 52.37 + ordinal / 100 }
});

/** Somebody's afternoon: an Alignment with Control Points in it. */
const workedOn = (): Alignment => ({
	...newAlignment(IMAGE_ID, IMAGE),
	controlPoints: [point(1), point(2), point(3)]
});

/**
 * The port, with every commit counted.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * A DELIBERATE DEPARTURE FROM CONTRIBUTING'S "NEVER ON INTERNAL CALL SEQUENCES"
 *
 * The standard is right and is followed everywhere below that can follow it: "nothing was written"
 * is asserted against `store.snapshot()`, which is the observable state, and the commit counter is
 * not consulted for it.
 *
 * **One claim genuinely is not expressible on contents**, and it is a claim this ticket has to make:
 * *there was already an identical starter there, and we did not rewrite it*. Before and after are
 * byte-identical either way, so no assertion on the file can tell an idempotent rewrite from no
 * write at all — and the rewrite is the defect, because `alignments/<image-id>.json` sits in
 * Workspaces kept in git and in Dropbox, where a write is a diff and a sync event whatever it
 * contains. `editor-align-route.e2e.ts` counts writes for exactly this reason and says so.
 *
 * So the counter is used for that one question and nothing else.
 */
function port(store: MemoryProjectStore): AlignmentFilePort & { commits: StorePath[] } {
	const commits: StorePath[] = [];
	return {
		commits,
		read: (at: StorePath) => store.read(at),
		commit: async (at: WritablePath, bytes: Bytes) => {
			commits.push(at);
			await store.write(at, bytes);
		}
	};
}

const read = async (store: MemoryProjectStore): Promise<Alignment> =>
	parseAlignment(await store.read(path), { imageId: IMAGE_ID });

/** Put a document on disk without going through the writer, which is what a fixture is for. */
const seed = (store: MemoryProjectStore, bytes: Bytes): Promise<void> =>
	seedAlignmentFixture(store, IMAGE_ID, bytes);

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE BRAND ITSELF, ASSERTED TWO WAYS
//
// Without this, removing the guard breaks nothing: widen `ProjectStore.write` back to `StorePath`
// and every test here still passes, `pnpm check` is still green, and the fence still prints
// success — because nothing anywhere asks the compiler to *refuse* something.
//
// `@ts-expect-error` is the assertion, and it is two-way: the line has to fail to typecheck, so
// `pnpm --filter @ballastella/core exec tsc --noEmit` fails if the brand is ever removed or the
// signature widened. An unused `@ts-expect-error` is itself an error, which is the whole trick —
// the same one `project/layer.test.ts` uses on `opacity`.
describe('the type refuses a blind write (ticket 18)', () => {
	const store = new MemoryProjectStore();
	const autosave = new Autosave(store);
	const bytes = new Uint8Array([1]) as Bytes;

	it('refuses an AlignmentPath at every verb that reaches the store', () => {
		// @ts-expect-error an Alignment is written through alignment-file.ts, never through the store
		void store.write(alignmentPath(IMAGE_ID), bytes); // alignment-write-is-the-fixture: a specimen proving the compiler refuses this line; it never runs
		// @ts-expect-error `commit` is the editor's route to the store, and it is closed too
		void autosave.commit(alignmentPath(IMAGE_ID), bytes); // alignment-write-is-the-fixture: a specimen proving the compiler refuses this line; it never runs
		// @ts-expect-error and so is `queue`, whose bytes reach `store.write` on the debounce
		void autosave.queue(alignmentPath(IMAGE_ID), bytes); // alignment-write-is-the-fixture: a specimen proving the compiler refuses this line; it never runs

		// The runtime half: the branded value is still just the path, so nothing above costs anything.
		expect(alignmentPath(IMAGE_ID)).toBe('alignments/floride-1657.json');
	});

	it('still allows every other path, which is what makes the brand affordable', () => {
		// Not `@ts-expect-error`: these must keep compiling. A brand that required a cast at every
		// ordinary write would be reverted within a week, and then there would be no guard at all.
		void store.write('amsterdam-1625/project.json', bytes);
		void store.write(`images/${IMAGE_ID}/info.json`, bytes);
		void autosave.queue('amsterdam-1625/annotations/l1.geojson', bytes);
		expect(true).toBe(true);
	});
});

describe('create — write only if there is nothing worth keeping', () => {
	it('writes the starter when the map has no Alignment at all', async () => {
		const store = new MemoryProjectStore();
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'create' }
		});

		expect(outcome).toBe('written');
		expect([...store.snapshot().keys()]).toEqual([path]);
		expect((await read(store)).resourceMask).toHaveLength(4);
	});

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE DEFECT THIS TICKET EXISTS FOR
	 *
	 * A remote resource's image id is `generateId(uri)`, the same for everybody. Align a Library map
	 * in Project A and place Control Points; add the same map to Project B months later and accept
	 * the community Alignment Allmaps happens to have. Under a blind write, Project A's placement is
	 * gone — silently, from a gesture that said nothing about Project A.
	 */
	it('keeps Control Points somebody placed rather than writing a community offer over them', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(workedOn()));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			// The community offer: a different placement of the same sheet.
			alignment: { ...newAlignment(IMAGE_ID, IMAGE), controlPoints: [point(7), point(8)] },
			write: { intent: 'create' }
		});

		expect(outcome).toBe('kept over the offer');
		// On the contents: the Control Points on disk are still the ones somebody placed.
		expect((await read(store)).controlPoints.map((p) => p.resource.x)).toEqual([100, 200, 300]);
		expect(store.snapshot().get(path)).toEqual(serialiseAlignment(workedOn()));
	});

	it('writes the offer over a starter nobody has touched, because there is nothing to lose', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(newAlignment(IMAGE_ID, IMAGE)));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: workedOn(),
			write: { intent: 'create' }
		});

		expect(outcome).toBe('written');
		expect((await read(store)).controlPoints).toHaveLength(3);
	});

	/**
	 * The Resource Mask is editable without placing a single Control Point, so "untouched" cannot be
	 * `controlPoints.length === 0`: a count would read a carefully cropped sheet as untouched and
	 * throw the crop away.
	 */
	it('treats a cropped sheet with no Control Points as work, not as an untouched starter', async () => {
		const store = new MemoryProjectStore();
		const cropped: Alignment = {
			...newAlignment(IMAGE_ID, IMAGE),
			resourceMask: [
				{ x: 10, y: 10 },
				{ x: 3990, y: 10 },
				{ x: 3990, y: 2990 },
				{ x: 10, y: 2990 }
			]
		};
		await seed(store, serialiseAlignment(cropped));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: workedOn(),
			write: { intent: 'create' }
		});

		expect(outcome).toBe('kept over the offer');
		expect((await read(store)).resourceMask[0]).toEqual({ x: 10, y: 10 });
		expect(store.snapshot().get(path)).toEqual(serialiseAlignment(cropped));
	});

	it('re-adding a map that is already aligned writes nothing and says nothing happened', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(workedOn()));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'create' }
		});

		// The ordinary re-add. Not worth a word to anybody, and not a write.
		expect(outcome).toBe('left alone');
		expect(store.snapshot().get(path)).toEqual(serialiseAlignment(workedOn()));
	});

	it('rewrites nothing when the starter it would write is already there', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(newAlignment(IMAGE_ID, IMAGE)));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'create' }
		});

		expect(outcome).toBe('left alone');
		// **The one assertion on the counter, and the reason the counter exists.** The file is
		// byte-identical whether or not it was rewritten, so contents cannot answer this — and an
		// identical rewrite is still a diff in a git Workspace and a sync event in a Dropbox one.
		expect(io.commits).toEqual([]);
	});

	it('keeps the file when the store cannot say whether there is one', async () => {
		// A revoked folder grant or a backend that is down. `'worked on'` is the safe direction: the
		// cost of a false "there is one" is a starter Alignment the next add writes, and the cost of a
		// false "there is none" is somebody's afternoon.
		const store = new MemoryProjectStore();
		const io: AlignmentFilePort = {
			read: () => Promise.reject(new Error('the folder is no longer reachable')),
			commit: (at, bytes) => store.write(at, bytes)
		};

		const outcome = await writeAlignmentFile(io, {
			alignment: workedOn(),
			write: { intent: 'create' }
		});

		expect(outcome).toBe('kept over the offer');
		expect(store.snapshot().size).toBe(0);
	});
});

describe('update — the user is editing the Alignment in front of them', () => {
	it('writes over what is there, because that is what the user has open', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(newAlignment(IMAGE_ID, IMAGE)));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: workedOn(),
			write: { intent: 'update' }
		});

		expect(outcome).toBe('written');
		expect((await read(store)).controlPoints).toHaveLength(3);
	});
});

describe('replace — the user said to discard what is there, in words', () => {
	it('writes over an Alignment somebody worked on, having named what is lost', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(workedOn()));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'replace', discarding: '3 Control Points, used by Amsterdam 1625' }
		});

		expect(outcome).toBe('written');
		expect((await read(store)).controlPoints).toEqual([]);
	});
});

describe('the address the file names its image by (ADR-0007)', () => {
	it('goes through the one writer rather than being edited into its output', async () => {
		const store = new MemoryProjectStore();
		const io = port(store);

		await writeAlignmentFile(io, {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'create' },
			address: { imageService: 'https://iiif.library.example/iiif/3/plan' }
		});

		const document = JSON.parse(new TextDecoder().decode(await store.read(path)));
		expect(document.target.source.id).toBe('https://iiif.library.example/iiif/3/plan');
	});

	it('measures "untouched" against a starter at the same address, not a placeholder one', async () => {
		// Otherwise a referenced map's own starter never looks untouched, and the community offer the
		// user just accepted on the add is refused for protecting a file with nothing in it.
		const address = { imageService: 'https://iiif.library.example/iiif/3/plan' };
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(newAlignment(IMAGE_ID, IMAGE), address));
		const io = port(store);

		const outcome = await writeAlignmentFile(io, {
			alignment: workedOn(),
			write: { intent: 'create' },
			address
		});

		expect(outcome).toBe('written');
		expect((await read(store)).controlPoints).toHaveLength(3);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// A COLLEAGUE'S EDIT, ARRIVING BETWEEN THE READ AND THE WRITE (ticket 07)
//
// ADR-0023 made an Alignment the Workspace's, shared by every Project that draws the map, and a
// Workspace can be a git checkout or a Dropbox folder. So the file can change under an open
// alignment view, and ticket 18 left that undetected: `update` wrote over whatever was there.
//
// ADR-0023's terms are **visibility, not prevention**. The write still happens — the alternative is
// discarding the edit in front of the user to protect one they cannot see — so what is asserted here
// is that the displacement is *noticed and handed back*, and that the bytes really do go down.
//
// **The unguarded direction is what makes these mean anything.** Every assertion below distinguishes
// "the file changed" from "the file did not", so a `changedSince` that always returned `null` — the
// shape ticket 18 shipped — fails them.
describe('an Alignment that changed somewhere else while it was open', () => {
	/** What this session read, and what it is about to write. */
	const opened = async (store: MemoryProjectStore) => {
		const bytes = await store.read(path);
		return bytes;
	};

	it('reports the displacement and hands back what it wrote over', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(newAlignment(IMAGE_ID, IMAGE), {}));
		const basedOn = await opened(store);

		// The colleague, arriving through a sync while the view is open. Seeded rather than written,
		// because it is another process's write and not this one's.
		const theirs = serialiseAlignment(
			{ ...newAlignment(IMAGE_ID, IMAGE), controlPoints: [point(1), point(2)] },
			{}
		);
		await seed(store, theirs);

		const report = await writeAlignmentFileReporting(port(store), {
			alignment: workedOn(),
			write: { intent: 'update', basedOn }
		});

		expect(report.outcome).toBe('written over a change');
		// Handed back, not merely reported gone: "your colleague's edit was overwritten" with nothing
		// attached is a sentence nobody can act on.
		expect(report.displaced).toEqual(theirs);
		// And the user's own edit is on disk. Visibility, not prevention.
		expect((await read(store)).controlPoints).toHaveLength(3);
	});

	it('says nothing when the file is exactly as this session left it', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(newAlignment(IMAGE_ID, IMAGE), {}));
		const basedOn = await opened(store);

		const report = await writeAlignmentFileReporting(port(store), {
			alignment: workedOn(),
			write: { intent: 'update', basedOn }
		});

		expect(report.outcome).toBe('written');
		expect(report.displaced).toBeNull();
	});

	it('compares bytes rather than the model, so an unmodelled field is a real change', async () => {
		// The reason the comparison cannot be on `Alignment`. A third-party document carries members
		// this build does not model — `Alignment.unmodelled` exists for exactly that — so a colleague
		// editing one of them produces a document this build parses to the *same* model. On a model
		// comparison that is "no change", and their edit disappears with the warning suppressed.
		const store = new MemoryProjectStore();
		const mine = newAlignment(IMAGE_ID, IMAGE);
		await seed(store, serialiseAlignment(mine, {}));
		const basedOn = await opened(store);

		const document = JSON.parse(new TextDecoder().decode(basedOn));
		document['ballastella:theirAnnotation'] = 'a field this build does not model';
		const theirs = new TextEncoder().encode(JSON.stringify(document, null, '\t') + '\n') as Bytes;
		await seed(store, theirs);

		// The model really is unchanged by their edit — otherwise this test proves nothing about the
		// comparison being on bytes.
		expect(parseAlignment(theirs, { imageId: IMAGE_ID }).controlPoints).toEqual(
			parseAlignment(basedOn, { imageId: IMAGE_ID }).controlPoints
		);

		const report = await writeAlignmentFileReporting(port(store), {
			alignment: workedOn(),
			write: { intent: 'update', basedOn }
		});

		expect(report.outcome).toBe('written over a change');
		expect(report.displaced).toEqual(theirs);
	});

	it('treats a file that was absent and is now present as a change', async () => {
		// `basedOn: null` is a caller that looked and found nothing. Somebody else creating the file in
		// the meantime is the same displacement by a different route, and reporting it as ordinary
		// would lose a whole Alignment rather than an edit to one.
		const store = new MemoryProjectStore();
		const theirs = serialiseAlignment(workedOn(), {});
		await seed(store, theirs);

		const report = await writeAlignmentFileReporting(port(store), {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'update', basedOn: null }
		});

		expect(report.outcome).toBe('written over a change');
		expect(report.displaced).toEqual(theirs);
	});

	it('says nothing when the file was absent and still is', async () => {
		const store = new MemoryProjectStore();

		const report = await writeAlignmentFileReporting(port(store), {
			alignment: workedOn(),
			write: { intent: 'update', basedOn: null }
		});

		expect(report.outcome).toBe('written');
		expect(report.displaced).toBeNull();
		expect((await read(store)).controlPoints).toHaveLength(3);
	});

	it('says nothing when the caller made no claim about what is on disk', async () => {
		// `basedOn` omitted — ticket 18's `update`, unchanged. A required field would have forced every
		// existing caller to invent an answer, and an invented baseline is a false alarm on every save.
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(workedOn(), {}));

		const report = await writeAlignmentFileReporting(port(store), {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'update' }
		});

		expect(report.outcome).toBe('written');
		expect(report.displaced).toBeNull();
	});

	it('returns the bytes it wrote, so a caller needs no second serialiser', async () => {
		// The baseline for the *next* write. Re-deriving it at the call site means two spellings of the
		// same document, and two spellings would report every ordinary save as a concurrent change.
		const store = new MemoryProjectStore();

		const report = await writeAlignmentFileReporting(port(store), {
			alignment: workedOn(),
			write: { intent: 'update', basedOn: null }
		});

		expect(report.written).toEqual(await store.read(path));

		// And feeding it straight back is silent, which is the property the session depends on.
		const next = await writeAlignmentFileReporting(port(store), {
			alignment: workedOn(),
			write: { intent: 'update', basedOn: report.written }
		});
		expect(next.outcome).toBe('written');
	});

	it('does not raise a false alarm when the file cannot be read', async () => {
		// The opposite direction from `existing`, deliberately. There, unreadable has to mean "assume
		// there is work here", because the cost of being wrong is somebody's afternoon. Here it decides
		// only what the user is *told* — the write happens regardless — so a false positive is a
		// frightening sentence about a document nobody can produce.
		const store = new MemoryProjectStore();
		const io = port(store);
		const failing: AlignmentFilePort = {
			read: () => Promise.reject(new Error('the folder’s permission was revoked')),
			commit: io.commit
		};

		const report = await writeAlignmentFileReporting(failing, {
			alignment: workedOn(),
			write: { intent: 'update', basedOn: new Uint8Array([1, 2, 3]) as Bytes }
		});

		expect(report.outcome).toBe('written');
		expect(report.displaced).toBeNull();
		expect((await read(store)).controlPoints).toHaveLength(3);
	});

	it('leaves replace alone: the user has already been told what they are discarding', async () => {
		const store = new MemoryProjectStore();
		await seed(store, serialiseAlignment(workedOn(), {}));

		const report = await writeAlignmentFileReporting(port(store), {
			alignment: newAlignment(IMAGE_ID, IMAGE),
			write: { intent: 'replace', discarding: 'three Control Points' }
		});

		expect(report.outcome).toBe('written');
		expect(report.displaced).toBeNull();
	});
});

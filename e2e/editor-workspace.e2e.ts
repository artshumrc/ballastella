import { DEFAULT_WORKSPACE, expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import { openProjectSettings, projectNameField } from './support/project-screen';
import { recordSaveStates } from './support/saved';
import { readStoredFile } from './support/stored-file';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { createWorkspace, switchToWorkspace } from './support/workspace.js';

// Every spec in this suite is behind the default-deny network fence in `support/network-fence.ts`,
// and this deployment's Base Map catalog points every entry at an archive on somebody else's host.
// So the archive is served from the committed fixture, in one place, for the whole file.
//
// **`context` rather than `page`**: a request that has passed through a service worker is not the
// page's own as far as Playwright is concerned, and `page.route` never sees it (measured in
// `editor-pwa.e2e.ts`, which says so at its own interception). Routing the context has no downside
// for a spec with no worker, and is the spelling that keeps working when one appears.
test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

/**
 * SPEC's Seam 2: the running app in a real browser against real OPFS.
 *
 * Everything here is a browser behaviour that the core suite cannot see — the save indicator
 * transitioning, the `formatVersion: 2` refusal reaching a screen, "Workspace not reachable"
 * being a page rather than an error boundary, and `<dialog>`'s Escape and focus restoration.
 * The storage layer itself is asserted in `@ballastella/core`, against both adapters.
 */

/** Empty the origin's OPFS, so no test can see another's Projects. */
async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		// The whole of browser storage, which since ticket 12 is **every named Workspace** rather than
		// one — so no test can see another's, whichever Workspace it was in.
		//
		// ⚠ **The Workspace the app is holding open is emptied, not removed.** `DirectoryHandleStore`
		// caches its root handle once it resolves (ADR-0008), and that handle is now a *named
		// subdirectory* rather than the OPFS root, which cannot vanish. Deleting the directory out from
		// under a running app therefore latches it "unreachable" until a reload — a state about the
		// harness rather than about the product, and one that used to be unreachable because emptying
		// the root left the root itself in place. Emptying it is exactly what this always meant.
		const root = await navigator.storage.getDirectory();
		const open = await workspaceRoot();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(
			names
				.filter((name) => name !== open.name)
				.map((name) => root.removeEntry(name, { recursive: true }))
		);
		const inside: string[] = [];
		for await (const name of open.keys()) inside.push(name);
		await Promise.all(inside.map((name) => open.removeEntry(name, { recursive: true })));
	});
	// The `localStorage` half of "no test can see another's Projects", which was missing: a record
	// naming a folder outlives the folder, and the next test's `seedProject` puts that folder back.
	await forgetEveryRecord(page);
}

/**
 * Drop every write-ahead journal entry **and** every unfinished-deletion record in the origin.
 *
 * ⚠ **Both prefixes, and the second was missing** (ticket 21, review 2). OPFS and `localStorage` are
 * origin-shared across every test in this harness, and {@link seedProject} writes `project.json`
 * straight into OPFS — bypassing `Workspace.#claim`, which is what would otherwise drop a stale
 * record naming that folder. So a `ballastella.deleted.` key left behind by a failing run survived
 * into later tests, where a startup could act on it against a seeded Project and present as an
 * unrelated flake.
 *
 * Named prefixes rather than `localStorage.clear()`: `ballastella.workspace` and its two siblings are
 * which Workspace the harness is in, and clearing those is a different test's subject.
 */
async function forgetEveryRecord(page: Page): Promise<void> {
	await page.evaluate(() => {
		for (const key of Object.keys(localStorage)) {
			if (key.startsWith('ballastella.journal.') || key.startsWith('ballastella.deleted.')) {
				localStorage.removeItem(key);
			}
		}
	});
}

/** Write a `project.json` straight into OPFS, bypassing the app entirely. */
async function seedProject(page: Page, directory: string, json: string): Promise<void> {
	await page.evaluate(
		async ([directory, json]) => {
			const root = await workspaceRoot();
			const project = await root.getDirectoryHandle(directory as string, { create: true });
			const file = await project.getFileHandle('project.json', { create: true });
			const writable = await file.createWritable();
			await writable.write(json as string);
			await writable.close();
		},
		[directory, json]
	);
}

/**
 * Write one file at any depth straight into OPFS, bypassing the app entirely.
 *
 * The Workspace's shared pool — `images/<id>/…` and `alignments/<id>.json` (ADR-0023) — is written
 * by an ingest that takes a real image and a real tiler, which is minutes of work and a different
 * test's subject. What the hub's list is about is what the *folder* holds, so the folder is what is
 * seeded.
 */
async function seedFile(page: Page, path: string, contents: string): Promise<void> {
	await page.evaluate(
		async ([path, contents]) => {
			const segments = (path as string).split('/');
			let directory = await workspaceRoot();
			for (const segment of segments.slice(0, -1)) {
				directory = await directory.getDirectoryHandle(segment, { create: true });
			}
			const file = await directory.getFileHandle(segments[segments.length - 1]!, { create: true });
			const writable = await file.createWritable();
			await writable.write(contents as string);
			await writable.close();
		},
		[path, contents]
	);
}

/** Every path in OPFS, so "the pyramid is still there" is provable from outside the app. */
async function everyPath(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const paths: string[] = [];
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [name, entry] of handle.entries()) {
				if (entry.kind === 'file') paths.push(`${prefix}${name}`);
				else await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
			}
		};
		await walk(await workspaceRoot(), '');
		return paths.sort();
	});
}

/**
 * SHA-256 of every file in a Project directory, **recursively**, so "nothing was written" is
 * provable.
 *
 * The recursion is the point. Skipping subdirectories left the hash covering `project.json` alone,
 * so the nested `images/…/info.json` that the byte-identity test deliberately seeds — standing in
 * for the pyramid a real Project is mostly made of — was silently never checked.
 */
async function hashProject(page: Page, directory: string): Promise<Record<string, string>> {
	return page.evaluate(async (directory) => {
		const hex = (digest: ArrayBuffer) =>
			[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

		const hashes: Record<string, string> = {};
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [name, entry] of handle.entries()) {
				if (entry.kind === 'file') {
					const bytes = await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer();
					hashes[`${prefix}${name}`] = hex(await crypto.subtle.digest('SHA-256', bytes));
				} else {
					await walk(entry as FileSystemDirectoryHandle, `${prefix}${name}/`);
				}
			}
		};

		const root = await workspaceRoot();
		await walk(await root.getDirectoryHandle(directory), '');
		return hashes;
	}, directory);
}

/** The display name in `project.json` as it sits on disk. */
/**
 * The `name` in `project.json`, read out of OPFS behind the app's back.
 *
 * Retried, because the app writes atomically — a temp file, then `move()` over the destination
 * (ADR-0017) — and a read that lands inside that window throws rather than returning stale bytes:
 * `getFileHandle` with a `NotFoundError` while the destination is momentarily gone, or `getFile()`
 * with a `NotReadableError` as it is replaced. Those are transient by construction, but they were
 * propagating out of `expect.poll`, whose retry covers a failed *assertion* and not a callback that
 * throws. That made this the flakiest test in the suite — it failed 2 of 5 runs at `--workers=1`,
 * with nothing else running.
 *
 * This is a fix to the read, not to the assertion: the bytes on disk are still what is compared, so
 * a write that never happens still fails. Only a read that collided with an atomic replace is
 * forgiven, and only for as long as one can plausibly last.
 */
async function readProjectName(page: Page, directory = 'amsterdam-1625'): Promise<string> {
	// The loop is `support/stored-file.ts`, which is where it lives for every helper that reads the
	// Workspace — this was the last hand-rolled copy of it (ticket 17), and copies are how one of them
	// came to be missing the retry altogether.
	return JSON.parse(await readStoredFile(page, `${directory}/project.json`)).name as string;
}

const createProject = async (page: Page, name: string) => {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page.getByRole('button', { name: 'Create Project' }).click();
	await expect(page.getByRole('link', { name })).toBeVisible();
};

test.describe('the Project hub', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('creating a Project lists it with its name and when it was last saved', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		const entry = page.getByRole('listitem').filter({ hasText: 'Amsterdam 1625' });
		// Addressed by query parameter, never by a per-Project path (ADR-0008).
		await expect(entry.getByRole('link', { name: 'Amsterdam 1625' })).toHaveAttribute(
			'href',
			/\?p=amsterdam-1625$/
		);
		await expect(entry.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
		await expect(entry.getByText('amsterdam-1625')).toBeVisible();
	});

	test('the Project is really in OPFS, laid out as ADR-0008 specifies', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		expect(Object.keys(await hashProject(page, 'amsterdam-1625'))).toEqual(['project.json']);
		const contents = await page.evaluate(async () => {
			const root = await workspaceRoot();
			const project = await root.getDirectoryHandle('amsterdam-1625');
			const file = await project.getFileHandle('project.json');
			return (await file.getFile()).text();
		});
		expect(JSON.parse(contents)).toMatchObject({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			layers: [],
			baseMap: null
		});
	});

	test('?p= opens the Project it names', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();

		await expect(page).toHaveURL(/\?p=amsterdam-1625$/);
		// The Project's own name is the Project screen's heading (ticket 04); the app's `<h1>` was on
		// the page that screen replaced.
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
	});

	test('renaming to a name another Project already has succeeds', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await createProject(page, 'Boston 1775');

		const boston = page.getByRole('listitem').filter({ hasText: 'Boston 1775' });
		await boston.getByRole('button', { name: /^Rename/ }).click();
		await page
			.getByRole('dialog', { name: 'Rename Project' })
			.getByLabel('New name')
			.fill('Amsterdam 1625');
		await page.getByRole('button', { name: 'Rename', exact: true }).click();

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(2);
		// Two display names, two distinct folders: identity is the folder, never the name.
		await expect(page.locator('code', { hasText: 'amsterdam-1625' })).toBeVisible();
		await expect(page.locator('code', { hasText: 'boston-1775' })).toBeVisible();
	});

	test('duplicating a Project adds a copy and leaves the original', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		await page.getByRole('button', { name: /^Duplicate/ }).click();

		await expect(page.getByRole('link', { name: 'Amsterdam 1625 (copy)' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625', exact: true })).toBeVisible();
	});

	// ADR-0023 keeps `images/`, `alignments/`, and `base-map/` for the Workspace itself, and ticket 01
	// requires the refusal to reach a screen "with a message naming the reservation". It did not: the
	// error was missing from `describeProblem`, so the hub fell through to `status = 'unreachable'` and
	// replaced itself — and every Project in it — with "Workspace not reachable — Your Workspace could
	// not be opened…". A scholar who typed "Images" was told their whole Workspace had gone.
	//
	// `bAsE mAp` is here as well as `Images` because the fold is the other half of the criterion: it is
	// `toDirectoryName` that turns a display name into `base-map`, and a check on the raw string would
	// pass this one straight through onto APFS, which would then hand the Project the Base Map folder.
	for (const [displayName, folder] of [
		['Images', 'images'],
		['bAsE mAp', 'base-map']
	]) {
		test(`refuses a Project called “${displayName}” and names the reservation`, async ({
			page
		}) => {
			await createProject(page, 'Amsterdam 1625');

			await page.getByRole('button', { name: 'New Project' }).click();
			await page
				.getByRole('dialog', { name: 'New Project' })
				.getByLabel('Project name')
				.fill(displayName);
			await page.getByRole('button', { name: 'Create Project' }).click();

			const refusal = page.getByTestId('reserved-name');
			await expect(refusal).toBeVisible();
			await expect(refusal).toContainText(folder);
			await expect(refusal).toContainText('reserved');

			// The Workspace is right here and still lists. Neither of these was true before.
			await expect(page.getByText('Workspace not reachable')).toHaveCount(0);
			await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

			// And nothing was written: no reserved folder, and no Project beside the one that existed.
			expect(
				await page.evaluate(async () => {
					const root = await workspaceRoot();
					const names: string[] = [];
					for await (const name of root.keys()) names.push(name);
					return names.sort();
				})
			).toEqual(['amsterdam-1625']);

			// A name that is not reserved goes through, and takes the refusal off the screen with it —
			// an alert still complaining about a Project that now exists says the opposite of the truth.
			await createProject(page, `${displayName} of Amsterdam`);
			await expect(refusal).toHaveCount(0);
		});
	}

	test('deleting a Project removes it from the list and from OPFS', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');

		await page.getByRole('button', { name: /^Delete/ }).click();
		await page.getByRole('button', { name: 'Delete Project' }).click();

		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);
		const remaining = await page.evaluate(async () => {
			const root = await workspaceRoot();
			const names: string[] = [];
			for await (const name of root.keys()) names.push(name);
			return names;
		});
		expect(remaining).toEqual([]);
	});
});

/**
 * The Workspace's Historical Maps, on the hub (SPEC stories 63, 64, 65, 98).
 *
 * Everything asserted here is a browser behaviour the core suite cannot see: the list reaching a
 * screen, the refusal reaching a screen instead of a dialog, `<dialog>`'s Escape and focus
 * restoration on the confirmation, and the whole of it working from the keyboard. What the *files*
 * do — which are deleted, which survive a refusal, what the used-by walk reads — is
 * `packages/core/src/project/historical-maps.test.ts`.
 */
test.describe('the Workspace’s Historical Maps', () => {
	const manifest = (label: string) => JSON.stringify({ label: { none: [label] } });
	const projectWith = (name: string, imageIds: readonly string[]) =>
		JSON.stringify({
			formatVersion: 1,
			name,
			updatedAt: '2026-01-02T03:04:05.000Z',
			layers: imageIds.map((imageId, order) => ({
				kind: 'map',
				id: `layer-${order}`,
				name: `${name} layer`,
				visible: true,
				order,
				opacity: 1,
				imageId
			}))
		});

	/** Three maps: one two Projects share, one only Amsterdam draws, and one nothing draws. */
	const seedWorkspace = async (page: Page) => {
		for (const [imageId, label] of [
			['shared', 'Blaeu’s plan of Amsterdam'],
			['solo', 'Bonner’s Boston'],
			['orphan', 'A map nobody kept']
		] as const) {
			await seedFile(
				page,
				`images/${imageId}/info.json`,
				`{"id":"https://unset.invalid/${imageId}"}`
			);
			await seedFile(page, `images/${imageId}/manifest.json`, manifest(label));
			await seedFile(
				page,
				`images/${imageId}/0,0,256,256/256,256/0/default.jpg`,
				'x'.repeat(50_000)
			);
			// alignment-write-is-the-fixture: the Historical Maps this spec lists and deletes, seeded rather than added through the UI
			await seedFile(page, `alignments/${imageId}.json`, '{}');
		}
		// A fourth whose tiles are on a Library's server: a `remote.json` and no `info.json`.
		await seedFile(
			page,
			'images/remote-one/remote.json',
			JSON.stringify({
				service: 'https://iiif.bnf.example/iiif/3/btv1b',
				label: 'Plan de Paris',
				width: 4000,
				height: 3000
			})
		);
		await seedProject(page, 'amsterdam-1625', projectWith('Amsterdam 1625', ['shared', 'solo']));
		await seedProject(page, 'boston-1775', projectWith('Boston 1775', ['shared']));
	};

	const entry = (page: Page, label: string) =>
		page.getByTestId('historical-map').filter({ hasText: label });

	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await seedWorkspace(page);
		await page.reload();
		await expect(page.getByTestId('historical-map')).toHaveCount(4);
	});

	test('lists every Historical Map with its label, its size, and how many files that is', async ({
		page
	}) => {
		// The file count beside the byte total, because "50 kB in 4 files" and "50 kB in 31 000 files"
		// are different news for a scholar deciding what to publish.
		await expect(entry(page, 'Blaeu’s plan of Amsterdam')).toContainText('50 kB in 4 files');
		await expect(entry(page, 'Bonner’s Boston')).toContainText('50 kB in 4 files');
		await expect(entry(page, 'A map nobody kept')).toContainText('50 kB in 4 files');
		await expect(entry(page, 'Plan de Paris')).toContainText('1 file');
	});

	test('says whether the tiles are here or names the Library they are on', async ({ page }) => {
		// Visible text, not a badge colour or a tooltip (SPEC story 111): this is the fact that decides
		// whether a Layer draws anything on a train.
		await expect(entry(page, 'Blaeu’s plan of Amsterdam')).toContainText('Tiles in this Workspace');
		await expect(entry(page, 'Plan de Paris')).toContainText('Tiles on iiif.bnf.example');
	});

	test('names the Projects that use each map, and says plainly when none do', async ({ page }) => {
		await expect(entry(page, 'Blaeu’s plan of Amsterdam')).toContainText(
			'Used by Amsterdam 1625, Boston 1775'
		);
		await expect(entry(page, 'Bonner’s Boston')).toContainText('Used by Amsterdam 1625');
		await expect(entry(page, 'A map nobody kept')).toContainText('No Project uses this map.');
	});

	test('deleting a Project keeps the Workspace’s Historical Maps, and the dialog says so', async ({
		page
	}) => {
		// The Delete Project dialog used to say "Its Historical Maps, Alignments, and Annotations go
		// with it", a few sections above a list stating the opposite. ADR-0023 made it false — a pyramid
		// and its Alignment belong to the **Workspace** and are shared — so this is the wording catching
		// up with the behaviour, which is unchanged and asserted below rather than described.
		await page.getByRole('button', { name: 'Delete Boston 1775' }).click();

		const dialog = page.getByRole('dialog', { name: 'Delete Project' });
		await expect(dialog).toContainText('The Historical Maps it drew stay in the Workspace');
		await expect(dialog).not.toContainText('Its Historical Maps');
		await page.getByRole('button', { name: 'Delete Project' }).click();

		await expect(page.getByRole('link', { name: 'Boston 1775' })).toHaveCount(0);
		// The shared map is still there, still listed, and now drawn by one Project instead of two.
		await expect(entry(page, 'Blaeu’s plan of Amsterdam')).toContainText('Used by Amsterdam 1625.');
		const remaining = await everyPath(page);
		expect(remaining).toContain('images/shared/info.json');
		expect(remaining).toContain('alignments/shared.json');
	});

	test('refuses to delete a map two Projects use, naming both, and keeps the pyramid', async ({
		page
	}) => {
		const before = await everyPath(page);

		await entry(page, 'Blaeu’s plan of Amsterdam')
			.getByRole('button', { name: /^Delete/ })
			.click();
		// The confirmation says what the list believes, and then the Workspace decides. The dialog is
		// not skipped for a map the list calls in-use: see the stale-list test below for why.
		await expect(page.getByTestId('delete-map-consequence')).toContainText(
			'deleting it will be refused'
		);
		await page.getByRole('button', { name: 'Delete Historical Map' }).click();

		const refusal = page.getByTestId('historical-map-refused');
		await expect(refusal).toContainText('Amsterdam 1625');
		await expect(refusal).toContainText('Boston 1775');
		// The claim that must not pass vacuously: the tiles are still on the disk, not merely that a
		// sentence appeared. A refusal that had deleted first would satisfy every assertion above it.
		expect(await everyPath(page)).toEqual(before);
	});

	test('confirms before deleting even when the list is a moment out of date', async ({ page }) => {
		// The regression this covers: the hub used to send a map its list called in-use straight to core
		// with no dialog, on the assumption core would refuse. When the list had gone stale — the last
		// Project drawing that map deleted in another tab, or by a colleague's sync — core did not
		// refuse, and one click destroyed a pyramid with no confirmation at all. The confirmation was
		// skipped in exactly the case where it was the only thing standing there.
		await expect(entry(page, 'Bonner’s Boston')).toContainText('Used by Amsterdam 1625');

		// Behind the app's back, so what is on screen is genuinely stale rather than merely re-rendered.
		await page.evaluate(async () => {
			const root = await workspaceRoot();
			await root.removeEntry('amsterdam-1625', { recursive: true });
		});
		const before = await everyPath(page);

		await entry(page, 'Bonner’s Boston')
			.getByRole('button', { name: /^Delete/ })
			.click();

		// A dialog, not a deletion. The old code reached `deleteHistoricalMap` here and the pyramid was
		// gone before this line ran.
		const dialog = page.getByRole('dialog', { name: 'Delete Historical Map' });
		await expect(dialog).toBeVisible();
		expect(await everyPath(page)).toEqual(before);

		// And confirming does delete it, because the decision is core's and taken from the Projects'
		// documents now rather than from the list.
		await page.getByRole('button', { name: 'Delete Historical Map' }).click();
		await expect(entry(page, 'Bonner’s Boston')).toHaveCount(0);
		expect((await everyPath(page)).filter((path) => path.startsWith('images/solo/'))).toEqual([]);
	});

	test('will not call a map unused, or delete it, because a Project is from a newer version', async ({
		page
	}) => {
		// ADR-0010 refuses to open a `formatVersion: 2` Project *because it is intact* — its Layer stack
		// is right there and certainly names Historical Maps. Reading that refusal as "this Project uses
		// nothing" is how a scholar is offered a delete button for a map their next release still draws,
		// on the same screen that has just told them the Project cannot be opened.
		await emptyWorkspace(page);
		await seedFile(page, 'images/orphan/info.json', '{"id":"https://unset.invalid/orphan"}');
		await seedFile(page, 'images/orphan/manifest.json', manifest('A map nobody kept'));
		await seedFile(page, 'images/orphan/0,0,256,256/256,256/0/default.jpg', 'x'.repeat(50_000));
		await seedProject(
			page,
			'from-the-future',
			'{"formatVersion":2,"name":"Tomorrow","layers":[{"kind":"something-new"}],"baseMap":null}'
		);
		await page.reload();

		// Both facts on one screen, agreeing with each other.
		await expect(
			page.getByText('Made with a newer version of Ballastella.', { exact: true })
		).toBeVisible();
		await expect(entry(page, 'A map nobody kept')).not.toContainText('No Project uses this map.');
		await expect(entry(page, 'A map nobody kept')).toContainText('from-the-future');

		const before = await everyPath(page);
		await entry(page, 'A map nobody kept')
			.getByRole('button', { name: /^Delete/ })
			.click();
		await page.getByRole('button', { name: 'Delete Historical Map' }).click();

		await expect(page.getByTestId('historical-map-refused')).toContainText('from-the-future');
		// Not merely that a sentence appeared: the pyramid is untouched.
		expect(await everyPath(page)).toEqual(before);
	});

	test('deletes a map no Project uses, with its remote.json and its Alignment, and the total drops', async ({
		page
	}) => {
		const total = page.getByTestId('historical-maps-total');
		// Three pyramids of 50 kB and one referenced map, whose `remote.json` is a few hundred bytes
		// because its tiles are on somebody else's disk — which is the point of the figure.
		await expect(total).toContainText('4 Historical Maps');
		await expect(total).toContainText('150 kB in all');
		await expect(total).toContainText('50 kB is used by no Project');

		await entry(page, 'A map nobody kept')
			.getByRole('button', { name: /^Delete/ })
			.click();
		await page.getByRole('button', { name: 'Delete Historical Map' }).click();

		await expect(page.getByTestId('historical-map')).toHaveCount(3);
		await expect(total).toContainText('3 Historical Maps');
		await expect(total).toContainText('100 kB in all');
		// Announced, not merely rendered (SPEC story 112) — so the region's own `aria-live` is asserted
		// beside its text. Without that this claim sat on a `data-testid` and was vacuous: a `<p>` with
		// the live attribute stripped would have passed it while announcing nothing. `aria-live` rather
		// than `role="status"` because the transfer line above already owns that role on this page.
		const announcement = page.getByTestId('historical-map-status');
		await expect(announcement).toHaveAttribute('aria-live', 'polite');
		await expect(announcement).toContainText('Deleted A map nobody kept, reclaiming 50 kB');

		const remaining = await everyPath(page);
		expect(remaining.filter((path) => path.startsWith('images/orphan/'))).toEqual([]);
		expect(remaining).not.toContain('alignments/orphan.json');
		// And nothing else went with it.
		expect(remaining).toContain('alignments/shared.json');
		expect(remaining).toContain('images/shared/info.json');
		expect(remaining).toContain('amsterdam-1625/project.json');
	});

	test('confirms through a <dialog> opened with showModal(), closable by Escape', async ({
		page
	}) => {
		const trigger = entry(page, 'A map nobody kept').getByRole('button', { name: /^Delete/ });
		await trigger.click();

		const dialog = page.getByRole('dialog', { name: 'Delete Historical Map' });
		await expect(dialog).toBeVisible();
		// It names the map and what deleting it reclaims, because it cannot be undone.
		await expect(dialog).toContainText('A map nobody kept');
		await expect(dialog).toContainText('50 kB');
		// `:modal` matches only a dialog opened by `showModal()` (ADR-0016).
		expect(
			await page.evaluate(() => document.querySelector('dialog[open]')?.matches(':modal') ?? false)
		).toBe(true);

		await page.keyboard.press('Escape');

		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
		// Escape cancelled rather than confirmed.
		await expect(page.getByTestId('historical-map')).toHaveCount(4);
	});

	test('is fully operable from the keyboard', async ({ page }) => {
		// **Tabbed to rather than `focus()`ed.** Calling `focus()` reaches an element a keyboard user
		// cannot: a control taken out of the tab order — `tabindex="-1"`, or a `<div>` with a click
		// handler — passes a test written that way while being unreachable in the app.
		const trigger = entry(page, 'A map nobody kept').getByRole('button', { name: /^Delete/ });
		await page.getByRole('button', { name: 'Open a Project someone sent me…' }).focus();
		for (
			let tab = 0;
			tab < 40 && !(await trigger.evaluate((node) => node === document.activeElement));
			tab++
		) {
			await page.keyboard.press('Tab');
		}
		await expect(trigger).toBeFocused();
		await page.keyboard.press('Enter');

		const dialog = page.getByRole('dialog', { name: 'Delete Historical Map' });
		await expect(dialog).toBeVisible();
		// And on into the dialog's own actions, without ever touching a pointer. `showModal()` traps
		// focus inside the dialog, so tabbing from here cannot leave it.
		const confirm = page.getByRole('button', { name: 'Delete Historical Map' });
		for (
			let tab = 0;
			tab < 10 && !(await confirm.evaluate((node) => node === document.activeElement));
			tab++
		) {
			await page.keyboard.press('Tab');
		}
		await expect(confirm).toBeFocused();
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('historical-map')).toHaveCount(3);
		await expect(entry(page, 'A map nobody kept')).toHaveCount(0);
	});

	test('a Workspace with no Historical Maps says so, and names the next action', async ({
		page
	}) => {
		await emptyWorkspace(page);
		await page.reload();

		await expect(page.getByTestId('no-historical-maps')).toContainText(
			'Open a Project and add one'
		);
		await expect(page.getByTestId('historical-map')).toHaveCount(0);
	});
});

test.describe('dialogs (ADR-0016)', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('Escape closes the dialog and focus returns to the button that opened it', async ({
		page
	}) => {
		const trigger = page.getByRole('button', { name: 'New Project' });
		await trigger.click();
		const dialog = page.getByRole('dialog', { name: 'New Project' });
		await expect(dialog).toBeVisible();

		await page.keyboard.press('Escape');

		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
	});

	test('is a native <dialog> opened with showModal(), not one of the banned methods', async ({
		page
	}) => {
		await page.getByRole('button', { name: 'New Project' }).click();

		// `:modal` matches only a dialog opened by `showModal()`, so this rules out the
		// checkbox-hack and anchor/hash modals ADR-0016 bans — neither of which handles Escape.
		expect(
			await page.evaluate(() => {
				const dialog = document.querySelector('dialog[open]');
				return {
					tagName: dialog?.tagName ?? null,
					isModal: dialog?.matches(':modal') ?? false,
					holdsFocus: dialog?.contains(document.activeElement) ?? false
				};
			})
		).toEqual({ tagName: 'DIALOG', isModal: true, holdsFocus: true });
	});
});

test.describe('the keyboard alone', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('creates, opens, and deletes a Project without a pointer', async ({ page }) => {
		const newProject = page.getByRole('button', { name: 'New Project' });
		await newProject.focus();
		await page.keyboard.press('Enter');
		await page
			.getByRole('dialog', { name: 'New Project' })
			.getByLabel('Project name')
			.fill('Keyboard Only');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('link', { name: 'Keyboard Only' })).toBeVisible();

		// Every control on the row is reachable by tabbing forward from the heading link.
		await page.getByRole('link', { name: 'Keyboard Only' }).focus();
		for (const label of [/^Rename/, /^Duplicate/, /^Export/, /^Delete/]) {
			await page.keyboard.press('Tab');
			await expect(page.getByRole('button', { name: label })).toBeFocused();
		}

		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog', { name: 'Delete Project' })).toBeVisible();
		await page.getByRole('button', { name: 'Delete Project' }).focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('link', { name: 'Keyboard Only' })).toHaveCount(0);
	});
});

test.describe('the save indicator (ADR-0017 rule 5)', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	// Named for the sequence the indicator *actually* publishes, which has four steps and not three
	// (ticket 17). `unsaved` is the debounce window — ADR-0017 rule 2's 400 ms, during which the
	// edit is in memory and the tool is saying so — and it is one of rule 5's three states, not an
	// implementation detail. The old title said `saved → saving → saved` while the old assertions
	// never looked at the third state at all.
	test('transitions saved → unsaved → saving → saved as the Project name is typed', async ({
		page
	}) => {
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();

		// By role, because being announced is the claim (SPEC story 112, ADR-0017 rule 5): a
		// `[data-save-state]` locator goes on passing with the live region deleted. One `role="status"`
		// per page is the convention this repo keeps for exactly that reason — every other announcement
		// on a page that has a save indicator is an `aria-live="polite"` region, and since ticket 04
		// the indicator is on the navigation bar and therefore on every page.
		const indicator = page.getByRole('status');
		await expect(indicator).toHaveAttribute('data-save-state', 'saved');

		// **Recorded, not polled** (ticket 17). This used to assert the middle of the sequence by
		// asking twice: `toHaveAttribute('saving')` and then `toHaveAttribute('saved')`. "Saving…" can
		// be over in a few milliseconds — it is an OPFS write of a small document — and two protocol
		// round trips can straddle it entirely, so the first assertion failed with
		// `Expected "saving", Received "saved"` in 2 of the 10 baseline runs of 2026-08-07 and told
		// nobody anything in the other 8. A poll cannot observe a transient state; a `MutationObserver`
		// sees every change, so what is asserted below is a record of what the indicator actually did.
		const saveStates = await recordSaveStates(page);

		// Renaming is behind the Project settings dialog since ticket 04 — one editable field did not
		// need a page of its own. The autosave rules it follows are unchanged, which is what this
		// asserts.
		const field = await projectNameField(page);
		await field.fill('Amsterdam 1626');

		// ─────────────────────────────────────────────────────────────────────────────────────────
		// **THE WHOLE SEQUENCE, EXACTLY, AND POLLED FOR — NOT READ ONCE.**
		//
		// Every step is a claim: the edit was held unsaved for the debounce window and the user was
		// told so, the write then happened and the user was told that too, and it finished. An
		// indicator that jumped straight back to "Saved" — a broken 400 ms dwell, or a missing
		// `unsaved` state — fails here.
		//
		// ⚠ `expect.poll`, because reading the record once is the *same* mistake this test was fixed
		// for, one level up. The obvious guard — wait for `data-save-state` to be `saved`, then read —
		// is satisfied by the `saved` the indicator is already showing *before* the edit lands, which
		// is exactly the hazard `support/saved.ts` exists to describe. A first read winning that race
		// returns `['saved']`, and `toEqual` on a single read would have gone green having observed
		// nothing at all. Found by review; it is the vacuous-pass shape this epic keeps producing.
		await expect
			.poll(saveStates, { message: 'the save indicator should pass through unsaved and saving' })
			.toEqual(['saved', 'unsaved', 'saving', 'saved']);

		// And it is what a screen reader is given, not only what the attribute says.
		await expect(indicator).toHaveText('Saved');

		// And the store really has it: reloading shows the new name.
		await page.reload();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1626');
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// ⚠ WHAT THIS DESCRIBE PROVES, AND WHAT IT DOES NOT — MEASURED 2026-08-07, TICKET 20
//
// It proves the listener is installed on the real `window` and that `Autosave.flush` puts the
// pending bytes on disk. It does **not** prove that a scholar's edit survives leaving the page,
// and the difference is not a nuance: it is measured, and it is total.
//
//   a debounced Project rename, then `page.reload()` inside the window   →  LOST 8 of 8
//   the same edit, `pagehide` dispatched with no navigation              →  written in 32 ms
//   a synchronous `localStorage.setItem` in a `pagehide` listener        →  survived 5 of 5
//
// So `pagehide` **does** fire on a real navigation, and the flush is fast, and it is lost anyway:
// the store write is asynchronous, and a document being unloaded does not run the continuation.
// Rule 3 is not a race that is usually lost. For a real navigation it is never won.
//
// The third line is the one that matters for whoever fixes this: something synchronous inside the
// same handler *does* survive, so a write-ahead journal is a real option rather than a hope. It is
// also an ADR-0017 decision and an ADR-0001 one — it puts user bytes somewhere that is not the
// ProjectStore — so it was reported rather than guessed at. See the ticket.
//
// ✅ **FIXED BY TICKET 20**, and the fix is asserted against a genuine navigation in
// `surviving a real navigation (ADR-0017 rule 3, as amended)` below. ADR-0017 rule 3 now reads
// "capture synchronously, then flush", the journal is `packages/core/src/autosave/journal.ts`, and
// the replay is `replay.ts`. This describe is kept, unchanged, because what it proves is still worth
// proving separately — that the listeners are on the real `window` and that `flush` works — and
// because it is the specimen for why a dispatched event is the weaker claim.
//
// Do not read the test below as covering the user's case. It is deliberately dispatched rather
// than provoked, and it is the strongest claim this seam can make.
// ═════════════════════════════════════════════════════════════════════════════════════════════
test.describe('flushing on hide (ADR-0017 rule 3)', () => {
	/**
	 * Hold back the app's own debounce, so that only a flush can put bytes on disk.
	 *
	 * This is what makes the test below about rule 3 rather than about rule 2. Rule 3 is the write
	 * the timer has *not yet reached* — the closed laptop — and the app's window is 400 ms while
	 * `expect.poll` waits five seconds, so with the timer live it fired well inside the poll and the
	 * assertion passed with `installFlushOnHide` deleted altogether. Verified both ways.
	 *
	 * Swallowing long timers rather than freezing the clock: Playwright's `clock` also replaces
	 * `Date` and `performance`, and a frozen clock stopped the flush from completing at all. Only
	 * timers at or beyond the debounce are dropped, and the save indicator's own 400 ms dwell goes
	 * with them — which is why this describe asserts files rather than the indicator.
	 */
	const holdBackTheDebounce = (page: Page) =>
		page.addInitScript(() => {
			const real = window.setTimeout;
			window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
				typeof delay === 'number' && delay >= 400
					? 0
					: real(handler as never, delay, ...args)) as typeof window.setTimeout;
		});

	test.beforeEach(async ({ page }) => {
		await holdBackTheDebounce(page);
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	// The `visibilitychange` half of rule 3 is asserted at the core seam instead
	// (`autosave.test.ts`), where the visibility state can be set. Chromium exposes no way for a
	// test to make a page genuinely hidden, and shadowing `document.visibilityState` from inside the
	// page does not take — so an e2e version would assert the shadowing, not the app.
	test('pagehide flushes a write that is still inside its debounce window', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		// Wait for the view to settle before typing. The screen appears as soon as the Project has been
		// read, but opening is driven by an effect over the URL that can run again, and a keystroke
		// landing while it is re-reading is dropped — see the note on `EditorSession.open`. An idle
		// indicator means nothing is in flight, so this test is about rule 3 and not about that race.
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

		const field = await projectNameField(page);
		await field.fill('Half a keystroke ago');
		// Still only in memory: the debounce window cannot close, so nothing has been written yet.
		expect(await readProjectName(page)).toBe('Amsterdam 1625');

		// Dispatched rather than provoked by a navigation, so the assertion is about the listener
		// being installed on the real window and not about how fast the browser tears a page down.
		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));

		await expect.poll(() => readProjectName(page)).toBe('Half a keystroke ago');
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE USER'S CASE, PROVOKED AND NOT DISPATCHED — TICKET 20
//
// This is the regression test for the measurement above. Everything about it is chosen so that it
// can only pass for the right reason:
//
//   * **A real `page.reload()`**, not `dispatchEvent(new PageTransitionEvent('pagehide'))`. That is
//     the entire difference between the 8-of-8 loss and the 32 ms success, and a test that
//     dispatches is a test that cannot see the bug.
//   * **The debounce is held back**, so the ordinary timer can never write. Without this the app's
//     own 400 ms window closes inside the assertion and the test passes with the fix deleted —
//     the exact vacuous shape the describe above documents having been caught in.
//   * **The bytes are read from OPFS**, not from the screen. A restored name that is only in memory
//     is not a save.
//
// The `flush` in the `pagehide` listener is still there and may occasionally win the race in a
// headless browser. That does not make these vacuous — every mutation below was actually run
// against this file, and two of them came back GREEN, which is recorded here rather than tidied
// away, because a mutation that does not go red is a finding about the tests:
//
//   * remove the replay from `WorkspaceStorage.start`            →  RED
//   * remove the `recovered` gate on the `?p=` open effect       →  RED, and it found a real defect
//                                                                   on its first run: restored on
//                                                                   disk, stale on screen, one
//                                                                   keystroke from being overwritten
//   * remove `journal.forgetUnder` from `deleteProject`          →  RED, but only against the fifth
//                                                                   test. Against the fourth it was
//                                                                   GREEN, because replay's own
//                                                                   precondition already covers a
//                                                                   Project that is simply gone; the
//                                                                   fifth test exists because of that
//                                                                   green, and says so itself.
//   * remove the journal write from `Autosave.queue`             →  GREEN — `capture()` on `pagehide`
//                                                                   picks the same bytes up.
//   * remove `autosave.capture()` from the `pagehide` listener   →  GREEN — `queue` had already
//                                                                   journalled them.
//
// The last two are a genuine redundancy rather than a gap: either half alone carries this case, so
// no e2e mutation of one can be red. Each is pinned separately in `journal.test.ts` — `queue` by
// "has the bytes on disk before the debounce has run at all", and `capture` by the one case only it
// can serve, a quota that was full at the edit and has room by the time the page goes away.
//
// The full record, including what review found afterwards and what was deliberately not done, is
// `.tracker/workspace-and-layers/tickets/20-a-real-navigation-does-not-lose-an-edit.md`.
// ═════════════════════════════════════════════════════════════════════════════════════════════
test.describe('surviving a real navigation (ADR-0017 rule 3, as amended)', () => {
	/** The same shim the describe above documents: only a flush or a capture can write. */
	const holdBackTheDebounce = (page: Page) =>
		page.addInitScript(() => {
			const real = window.setTimeout;
			window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
				typeof delay === 'number' && delay >= 400
					? 0
					: real(handler as never, delay, ...args)) as typeof window.setTimeout;
		});

	test.beforeEach(async ({ page }) => {
		await holdBackTheDebounce(page);
		await page.goto('./');
		await emptyWorkspace(page);
		await forgetEveryRecord(page);
		await page.reload();
	});

	const openAndRename = async (page: Page, typed: string) => {
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		// An idle indicator means nothing is in flight, so what follows is about rule 3 and not about
		// a keystroke landing while the Project is being re-read. Same reasoning as above.
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

		const field = await projectNameField(page);
		await field.fill(typed);
		// Still only in memory: the debounce window cannot close, so nothing has been written.
		expect(await readProjectName(page)).toBe('Amsterdam 1625');
	};

	test('a debounced rename survives reloading the page inside the debounce window', async ({
		page
	}) => {
		await openAndRename(page, 'Amsterdam 1626');

		// The real thing. Not a dispatched event.
		await page.reload();

		await expect
			.poll(() => readProjectName(page), {
				message: 'the rename should be in OPFS after a real reload, not only on screen'
			})
			.toBe('Amsterdam 1626');
		// And the screen the reload landed on shows it, so the recovery is not only on disk.
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1626');
	});

	test('says that it put the change back, in text a screen reader is given', async ({ page }) => {
		await openAndRename(page, 'Amsterdam 1627');

		await page.reload();

		// SPEC story 111: visible text, not a tooltip. Story 112: inside the `aria-live` region that
		// was already mounted, so it is announced rather than silently inserted.
		const notice = page.getByTestId('recovered-edits');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText('amsterdam-1625/project.json');
		await expect(page.getByTestId('recovered-region')).toHaveAttribute('aria-live', 'polite');

		// And it goes when the user says so, not on a timer.
		await page.getByTestId('recovered-dismiss').click();
		await expect(notice).toBeHidden();

		// ⚠ **And focus lands somewhere, which it did not** (ticket 21, round 4; the defect is
		// ticket 20's). "Got it" removes the `<section>` that contains it, so a keyboard or
		// screen-reader user had the focused element deleted from under them and landed on `<body>` —
		// back at the top of the document, with the next Tab starting from the beginning of the page.
		// It has been load-bearing since round 3 made this panel the only surface a folder Workspace's
		// deletions are ever reported on.
		expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN');
	});

	/**
	 * ⚠ **This is a re-edit, not an undo, and calling it one was wrong.** Two `fill()`s exercise the
	 * debounce and the journal's last-write-wins; they do not touch `UndoSlot` at all, so this test
	 * says nothing about ADR-0014 however it is named. Review caught that.
	 *
	 * It is kept because superseding *is* worth pinning at this seam — a journal that appended rather
	 * than replaced would fail here. The ADR-0014 claim is pinned where the mechanism actually lives,
	 * in `journal.test.ts`'s "single-level undo across a save", which drives a real `UndoSlot` against
	 * a store whose writes never settle: the only state in which the journal is what carries the file.
	 */
	test('replays the last edit to a file, not an earlier one', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

		const field = await projectNameField(page);
		await field.fill('A name typed and thought better of');
		await field.fill('Amsterdam 1625');

		await page.reload();

		expect(await readProjectName(page)).toBe('Amsterdam 1625');
	});

	test('does not put an edit back into a Project the user deleted', async ({ page }) => {
		await openAndRename(page, 'Gone before it was saved');

		// Back to the hub and delete it, with the rename still journalled.
		await page.goto('./');
		await page.getByRole('button', { name: /^Delete/ }).click();
		await page.getByRole('button', { name: 'Delete Project' }).click();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);

		// **Immediately, with the deletion still in flight** — which is the whole of what this pins,
		// and why nothing above waits for it to render. `Workspace.deleteProject` is several awaits
		// deep against OPFS and a document being unloaded does not run the continuation (ADR-0017,
		// "Rule 3, amended"), so before ticket 21 this reload caught the deletion before its *first*
		// await had resolved, one run in five, and the Project came back.
		await page.reload();

		// The Project stays deleted, and nothing is quietly recreated under its directory name.
		//
		// ⚠ **The empty state first, and it is not decoration** (ticket 21). `toHaveCount(0)` passes
		// against a page that has not rendered its list yet, so on a fresh reload both assertions
		// below were satisfied by the hub simply not being there — and the run that found this defect
		// passed both and then failed on the file list. Waiting for the sentence the hub shows when it
		// has looked and found nothing is what makes them mean something.
		await expect(page.getByText('No Projects yet')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Gone before it was saved' })).toHaveCount(0);
		expect(await everyPath(page)).toEqual([]);
	});

	/**
	 * ⚠ **A deletion carried out at startup used to be completely silent** (ticket 21, review 2).
	 *
	 * `Workspace.finishInterruptedDeletions` answered with three lists and `EditorSession` discarded
	 * all three. ADR-0017's standard for this exact recovery chain is explicit and repeated — *"every
	 * replay is named to the user, so an older state coming back is visible rather than silent"* — and
	 * the replay half honoured it while the half that **removes files from a scholar's folder** said
	 * nothing in either direction. SPEC stories 111 and 112.
	 *
	 * The record is seeded rather than provoked, because provoking it means winning the ~20% race this
	 * whole suite is about; what is seeded is exactly the key and value `DeletedProjects.record`
	 * writes, evidence included — a record without matching evidence is refused, which is the other
	 * half of the same review and is pinned at the unit seam.
	 */
	test('says at startup which Project it finished deleting', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await page.evaluate(async () => {
			const root = await workspaceRoot();
			const file = await (
				await (await root.getDirectoryHandle('amsterdam-1625')).getFileHandle('project.json')
			).getFile();
			const manifest = JSON.parse(await file.text());
			const workspace = `opfs:${localStorage.getItem('ballastella.workspace') || 'My Workspace'}`;
			localStorage.setItem(
				`ballastella.deleted.${encodeURIComponent(workspace)}/${encodeURIComponent('amsterdam-1625')}`,
				JSON.stringify({
					formatVersion: 1,
					at: new Date().toISOString(),
					was: { name: manifest.name, updatedAt: manifest.updatedAt }
				})
			);
		});

		await page.reload();

		await expect(page.getByTestId('deletion-finished')).toContainText('amsterdam-1625');
		await expect(page.getByText('No Projects yet')).toBeVisible();
		expect(await everyPath(page)).toEqual([]);
	});

	/**
	 * ⚠ **The other direction, and it was rendered by no test at all** (ticket 21, review 3).
	 *
	 * A refusal is the *only* thing a startup deletion ever reports in a folder Workspace since the
	 * identity rule, and the whole arm that renders it — `deletion-refused`, the "A deletion was not
	 * finished" heading, and `deletionsAreNoteworthy`'s `refused` term — was reachable in no test. A
	 * build that dropped any of them would silently throw away the one sentence standing between the
	 * user and a Project they think is deleted and which is still on disk.
	 *
	 * Provoked rather than seeded on the refusal itself: the record is written by the real deletion
	 * gesture against a store that cannot carry it out, and then the Project is renamed, which is
	 * exactly the "reopened and edited after a failed deletion" case `#claim` cannot see.
	 */
	test('says at startup which deletion it would not carry out, and leaves the Project alone', async ({
		page
	}) => {
		await createProject(page, 'Amsterdam 1625');
		await page.evaluate(async () => {
			const root = await workspaceRoot();
			const file = await (
				await (await root.getDirectoryHandle('amsterdam-1625')).getFileHandle('project.json')
			).getFile();
			const manifest = JSON.parse(await file.text());
			const workspace = `opfs:${localStorage.getItem('ballastella.workspace') || 'My Workspace'}`;
			localStorage.setItem(
				`ballastella.deleted.${encodeURIComponent(workspace)}/${encodeURIComponent('amsterdam-1625')}`,
				JSON.stringify({
					formatVersion: 1,
					at: new Date().toISOString(),
					// What the hub was showing when Delete was pressed — and the Project has moved on
					// since, which is what the next startup has to notice.
					was: { name: manifest.name, updatedAt: '2020-01-01T00:00:00.000Z' }
				})
			);
		});

		await page.reload();

		await expect(page.getByTestId('deletion-refused')).toContainText('Amsterdam 1625');
		await expect(page.getByTestId('deletion-refused')).toContainText('nothing was removed');
		// The panel says what it is, which is the arm of the heading nothing else reaches: no edit was
		// put back, so it cannot borrow the replay's sentence.
		await expect(page.getByTestId('recovered-edits')).toContainText('A deletion was not finished');
		// And the Project is right there, with every byte of it.
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		expect(await everyPath(page)).toEqual(['amsterdam-1625/project.json']);
	});

	/**
	 * ⚠ **ADR-0017 asks for two refusals and only one was rendered by a test.** A browser that answers
	 * reads and rejects every write — Safari with cookies blocked, or a `localStorage` filled by one
	 * enormous Annotation collection — cannot hold the deletion note, and the deletion is then only as
	 * durable as this tab. `protectionWarning` does not stand in for it: that sentence is about an
	 * edit on its way to storage and offers "wait for the indicator to read Saved", which a deletion
	 * has neither of.
	 */
	test('says when the browser will not write a deletion down', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		// Reads still answer, which is the browser this actually happens on — a probe that only reads
		// accepts this storage, and every write throws.
		await page.evaluate(() => {
			const setItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key: string, value: string) {
				if (key.startsWith('ballastella.deleted.')) throw new Error('QuotaExceededError');
				setItem.call(this, key, value);
			};
		});

		await page.getByRole('button', { name: /^Delete/ }).click();
		await page.getByRole('button', { name: 'Delete Project' }).click();

		await expect(page.getByTestId('deletion-warning')).toContainText(
			'would not let Ballastella write the deletion down'
		);
		// And the deletion itself still happened: a browser that will not hold a note must not stop a
		// user deleting a Project.
		await expect(page.getByText('No Projects yet')).toBeVisible();
	});

	test('does not leak a deleted Project’s file into a new one that reused its folder', async ({
		page
	}) => {
		// ⚠ **The one case replay's own precondition cannot see**, and therefore the only test that
		// pins `deleteProject`'s journal sweep down. Once a Project of the same name exists again, the
		// directory is back and its `project.json` is there, so from replay's side an entry naming a
		// file inside it is indistinguishable from an edit to the Project that is there now.
		//
		// `project.json` itself is *not* the specimen, and finding that out is what this test is for:
		// creating the replacement Project rewrites that path, which supersedes the journalled entry
		// and then forgets it. It is the Project's **other** files — an Annotation collection still
		// inside its debounce window — that nothing rewrites, and they would land in a Project that
		// has no Layer referencing them: a stray file in every size total and every backup.
		//
		// The entry is seeded rather than provoked, because provoking it needs an Annotation Layer and
		// a drawn shape, which is a different test's subject. What is seeded is exactly the bytes an
		// interrupted `writeAnnotations` leaves, at exactly the key `WriteAheadJournal` writes.
		await createProject(page, 'Amsterdam 1625');
		const stray = 'amsterdam-1625/annotations/stray.geojson';
		await page.evaluate((path) => {
			const workspace = `opfs:${localStorage.getItem('ballastella.workspace') || 'My Workspace'}`;
			const key = `ballastella.journal.${encodeURIComponent(workspace)}/${encodeURIComponent(path)}`;
			localStorage.setItem(
				key,
				JSON.stringify({ formatVersion: 1, at: new Date().toISOString(), bytes: btoa('{}') })
			);
		}, stray);

		await page.getByRole('button', { name: /^Delete/ }).click();
		await page.getByRole('button', { name: 'Delete Project' }).click();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);

		// The same display name, so the same folder name: `amsterdam-1625`.
		await createProject(page, 'Amsterdam 1625');

		await page.reload();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();

		expect(await everyPath(page)).toEqual(['amsterdam-1625/project.json']);
	});

	test('does not put an edit into a different named Workspace (ticket 12)', async ({ page }) => {
		await openAndRename(page, 'Typed in the first Workspace');

		// Switch Workspace, then reload. The edit belongs to the Workspace it was typed into, and the
		// arriving one must not be given it — the failure `#adopt` prevents for queued bytes, which a
		// journal would otherwise reintroduce across a whole browser session.
		//
		// Back to the hub first: Project settings is a `<dialog>` opened with `showModal()`, so
		// everything behind it — the bar's Workspace switcher included — is inert until it is closed.
		await page.goto('./');
		await createWorkspace(page, 'Teaching');
		await expect(page.getByText('No Projects yet')).toBeVisible();

		await page.reload();

		// The second Workspace is empty; the rename is still waiting in the first one's journal.
		expect(await everyPath(page)).toEqual([]);
		await expect(page.getByTestId('recovered-edits')).toBeHidden();
	});

	test('puts the edit back when the Workspace it was typed into is opened again', async ({
		page
	}) => {
		// ⚠ **The other half of the test above.** "The edit is not in the *other* Workspace" is
		// satisfied just as well by the edit having been destroyed, which is the vacuous shape this
		// epic keeps producing; this is the assertion that says it still exists.
		//
		// It does **not** pin `WorkspaceStorage.#adopt`'s `capture()` call — removing that leaves this
		// green, measured. The reason is the same redundancy as the `pagehide` pair above: `queue`
		// journalled these bytes when they were typed, so by the time the switch happens the entry is
		// already on disk and `capture` re-records it. `#adopt`'s capture earns its place only in the
		// case `capture` alone can serve — a quota that was full at the edit and has room by the
		// switch — which is pinned in `journal.test.ts` rather than here.
		await openAndRename(page, 'Typed in the first Workspace');

		await page.goto('./');
		await createWorkspace(page, 'Teaching');
		await expect(page.getByText('No Projects yet')).toBeVisible();

		await switchToWorkspace(page, DEFAULT_WORKSPACE);

		await expect(page.getByRole('link', { name: 'Typed in the first Workspace' })).toBeVisible();
		expect(await readProjectName(page)).toBe('Typed in the first Workspace');
	});
});

test.describe('a Project from a newer version (ADR-0010)', () => {
	const fromTheFuture =
		'{"formatVersion":2,"name":"Tomorrow","layers":[{"kind":"something-new"}],"baseMap":null}';

	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await seedProject(page, 'from-the-future', fromTheFuture);
	});

	test('is refused with a message that names the remedy, and is not modified', async ({ page }) => {
		const before = await hashProject(page, 'from-the-future');

		await page.goto('./?p=from-the-future');

		const alert = page.getByRole('alert');
		await expect(alert).toContainText('newer version of Ballastella');
		await expect(alert).toContainText('update your copy');
		await expect(alert).toContainText('https://');

		expect(await hashProject(page, 'from-the-future')).toEqual(before);
		const contents = await page.evaluate(async () => {
			const root = await workspaceRoot();
			const project = await root.getDirectoryHandle('from-the-future');
			return (await (await project.getFileHandle('project.json')).getFile()).text();
		});
		expect(contents).toBe(fromTheFuture);
	});

	test('is still listed on the hub, marked as unopenable', async ({ page }) => {
		await page.goto('./');

		await expect(page.getByText('Made with a newer version of Ballastella.')).toBeVisible();
	});
});

test.describe('an unreachable Workspace (ADR-0008)', () => {
	// The failure is injected at the browser API, not through a hook in the app: the app cannot
	// tell it is being lied to, which is the point.
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			navigator.storage.getDirectory = () =>
				Promise.reject(new DOMException('The Workspace could not be found', 'NotFoundError'));
		});
	});

	test('shows "Workspace not reachable" with a locate-again action, not an error boundary', async ({
		page
	}) => {
		await page.goto('./');

		const alert = page.getByRole('alert');
		await expect(alert).toContainText('Workspace not reachable');
		await expect(alert).toContainText('The Workspace could not be found');

		const locate = page.getByRole('button', { name: 'Locate Workspace again' });
		await expect(locate).toBeVisible();
		await locate.focus();
		await expect(locate).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(alert).toContainText('Workspace not reachable');

		// SvelteKit's error boundary would have replaced the page.
		await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();
	});
});

test.describe('opening a Project and closing it (ADR-0010)', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('./');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('tabbing and clicking through the name field writes nothing', async ({ page }) => {
		// The byte-identity test below navigates with `page.goto` and never focuses anything, so it
		// cannot see this: `onblur` committed with no dirty check, and `writeProject` stamps a fresh
		// `updatedAt` unconditionally, so a user who merely tabbed into the field and out again
		// rewrote `project.json`. ADR-0010 is explicit — merely looking at an old Project must not
		// modify files, or opening one in a git working tree produces an unexplained diff and opening
		// one in a Dropbox folder syncs a rewrite to every other machine.
		await createProject(page, 'Amsterdam 1625');
		await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		const before = await hashProject(page, 'amsterdam-1625');
		const dialog = await openProjectSettings(page);
		const field = dialog.getByLabel('Project name');
		await expect(field).toBeVisible();

		await field.focus();
		await expect(field).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(field).not.toBeFocused();

		// And with the pointer, which is the same gesture through a different event order. Inside the
		// dialog, because `showModal()` makes everything outside it inert.
		await field.click();
		await dialog.getByRole('heading', { name: 'Project settings' }).click();
		await expect(field).not.toBeFocused();

		// An absence, so it needs a settle: longer than the 400 ms debounce, plus the flush that
		// `pagehide` forces, so any write the app was going to make has certainly happened.
		await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
		await page.waitForTimeout(600);

		expect(await hashProject(page, 'amsterdam-1625')).toEqual(before);
	});

	test('writes nothing: every file is byte-identical before and after', async ({ page }) => {
		await createProject(page, 'Amsterdam 1625');
		await page.evaluate(async () => {
			const root = await workspaceRoot();
			const project = await root.getDirectoryHandle('amsterdam-1625');
			// `annotations/` rather than `images/`: since ADR-0023 a pyramid is the Workspace's and is not
			// inside a Project at all, so a nested fixture under the Project has to be one of the Project's
			// own files or the claim below would be about a file the application never puts there.
			const annotations = await project.getDirectoryHandle('annotations', { create: true });
			const file = await annotations.getFileHandle('l-notes.geojson', { create: true });
			const writable = await file.createWritable();
			await writable.write('{"type":"FeatureCollection","features":[]}');
			await writable.close();
		});
		const before = await hashProject(page, 'amsterdam-1625');
		// The hash has to reach into subdirectories, or "every file is byte-identical" is a claim
		// about `project.json` alone. The nested `annotations/l-notes.geojson` stands in for the
		// Annotations a real Project holds — untouched by merely looking. Sorted, because OPFS promises no
		// enumeration order.
		expect(Object.keys(before).sort()).toEqual(['annotations/l-notes.geojson', 'project.json']);

		await page.goto('./?p=amsterdam-1625');
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await page.goto('./');
		await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();

		expect(await hashProject(page, 'amsterdam-1625')).toEqual(before);
	});
});

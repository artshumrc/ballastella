import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { routeGitHubHosts } from './support/github-hosts.js';
import { expectNoRemote, expectWorkspaceNamed } from './support/workspace.js';

/**
 * Reviewing one Project out of a public repository (ADR-0024, ADR-0031).
 *
 * Seam 2. The engine — the closure a Project's Layers make, the blob-SHA check, the refusals
 * and their sentences — is asserted at Seam 1 in `review-from-remote.test.ts`, where the assertion
 * is the bytes that arrived and the fake's own counters rather than a screen. What only a browser
 * can show is here:
 *
 *   - a repository and a Project folder typed into the editor become a **review copy** the app
 *     switches to, carrying the banner and its two exits;
 *   - the Project in it lists on the hub, opens and draws, so its Map Image, its Alignment and
 *     its Annotations all really landed, read back through the app's own code;
 *   - the Workspace-shared maps the *other* Project draws never arrive (ADR-0023);
 *   - the result is **unbound and unpublishable**, and the credential is **sealed** while it is open
 *     — both refusals asserted at the route that creates the Workspace they protect against;
 *   - there is no affordance anywhere that moves the reviewed Project into the user's own Workspace,
 *     which ADR-0024 names as the fence making the rest coherent;
 *   - none of it needs a credential, and none is sent — asserted against a GitHub answering 401 to
 *     anything carrying one.
 */

const HUB = './';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const REMOTE = `${OWNER}/${REPOSITORY}`;
const AMSTERDAM = 'amsterdam-1625';
const BOSTON = 'boston-1710';

const projectJson = (name: string, imageId: string, annotation: string): string =>
	`${JSON.stringify(
		{
			formatVersion: 1,
			name,
			updatedAt: '2025-03-04T11:22:33.000Z',
			layers: [
				{
					id: 'l1',
					kind: 'annotation',
					name: `${name} notes`,
					visible: true,
					order: 0,
					geojsonRef: annotation,
					defaultStyle: {}
				},
				{
					id: 'l2',
					kind: 'map',
					name: `${name} sheet`,
					visible: true,
					order: 1,
					opacity: 1,
					imageId
				}
			],
			baseMap: null
		},
		null,
		'\t'
	)}\n`;

const FEATURES = '{"type":"FeatureCollection","features":[]}';

/** What the publisher's repository holds that is **not** any Project (ADR-0033). */
const OUTSIDE_NAMESPACE = ['README.md', 'CNAME', 'LICENSE', '.github/workflows/pages.yml'];

/**
 * A published Workspace holding **two** Projects and **three** Map Images.
 *
 * `map-3` is drawn by no Layer of either Project and `map-2` only by the Boston one, which is what
 * makes "only what this Project references travels" assertable rather than merely true of a fixture
 * with nothing else in it. A Workspace holds a shared pool (ADR-0023); a review copy holds one
 * Project's worth of it.
 */
const PUBLISHED: Record<string, string> = {
	'.nojekyll': '',
	'index.html': '<!doctype html><title>Atlas</title>',
	'remote.json': JSON.stringify({ formatVersion: 1, owner: 'someone-else', repository: 'fork' }),

	[`${AMSTERDAM}/project.json`]: projectJson(
		'Amsterdam 1625',
		'map-1',
		'annotations/warehouses.geojson'
	),
	[`${AMSTERDAM}/annotations/warehouses.geojson`]: FEATURES,
	[`${BOSTON}/project.json`]: projectJson('Boston 1710', 'map-2', 'annotations/wharves.geojson'),
	[`${BOSTON}/annotations/wharves.geojson`]: FEATURES,

	'images/map-1/info.json': '{"width":4096,"height":3072}',
	'images/map-1/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	'images/map-2/info.json': '{"width":2048,"height":1536}',
	'images/map-2/0,0,256,256/256,256/0/default.jpg': 'the other Project’s tile',
	'images/map-3/info.json': '{"width":512,"height":512}',
	// alignment-write-is-the-fixture: the reviewed Project's Alignment as it sits on the Remote, seeded into the fake GitHub rather than into any Workspace — the Review under test is what writes it, through `writeAlignmentBytes`
	'alignments/map-1.json': '{"type":"Annotation","id":"map-1"}',
	// alignment-write-is-the-fixture: the other Project's Alignment on the Remote, seeded so that leaving it out of the review copy is assertable
	'alignments/map-2.json': '{"type":"Annotation","id":"map-2"}',
	// alignment-write-is-the-fixture: the unused map's Alignment on the Remote, seeded so that leaving it out of the review copy is assertable
	'alignments/map-3.json': '{"type":"Annotation","id":"map-3"}',

	...Object.fromEntries(OUTSIDE_NAMESPACE.map((path) => [path, `${path}, the scholar's own\n`]))
};

/**
 * A real Georeference Annotation over `map-1`, as `serialiseAlignment` writes one.
 *
 * ⚠ **Only the Import fixture needs this.** A Review copies an Alignment's bytes across without
 * reading them, so the stub above is enough to prove which files travelled; an Import *remaps* every
 * Alignment onto the Map Image identity it mints, so it parses them and refuses one that is not a
 * Georeference Annotation. Both fixtures are deliberate: the stub keeps the Review's byte assertions
 * legible, and this keeps the Import's refusals about the Import.
 */
const GEOREFERENCED_MAP_1 = JSON.stringify({
	type: 'Annotation',
	'@context': [
		'http://iiif.io/api/extension/georef/1/context.json',
		'http://iiif.io/api/presentation/3/context.json'
	],
	motivation: 'georeferencing',
	target: {
		type: 'SpecificResource',
		source: { id: 'https://unset.invalid/map-1', type: 'ImageService3', width: 4096, height: 3072 },
		selector: {
			type: 'SvgSelector',
			value:
				'<svg width="4096" height="3072"><polygon points="0,0 4096,0 4096,3072 0,3072" /></svg>'
		}
	},
	body: {
		type: 'FeatureCollection',
		transformation: { type: 'polynomial', options: { order: 1 } },
		features: [
			[
				[100, 100],
				[4.88, 52.375]
			],
			[
				[3900, 100],
				[4.92, 52.375]
			],
			[
				[3900, 2900],
				[4.92, 52.36]
			],
			[
				[100, 2900],
				[4.88, 52.36]
			]
		].map(([resourceCoords, coordinates]) => ({
			type: 'Feature',
			properties: { resourceCoords },
			geometry: { type: 'Point', coordinates }
		}))
	}
});

/** The same published Workspace, with an Alignment an Import can really remap. */
const IMPORTABLE: Record<string, string> = {
	...PUBLISHED,
	// alignment-write-is-the-fixture: the Alignment as it sits on the Remote, seeded into the fake GitHub rather than into any Workspace — the Import under test is what writes one, through the remapping
	'alignments/map-1.json': GEOREFERENCED_MAP_1
};

/** Everything reviewing the Amsterdam Project brings down, and nothing else. */
const AMSTERDAM_CLOSURE = [
	'alignments/map-1.json',
	`${AMSTERDAM}/annotations/warehouses.geojson`,
	`${AMSTERDAM}/project.json`,
	'images/map-1/0,0,256,256/256,256/0/default.jpg',
	'images/map-1/info.json'
];

/** Paths the Remote holds that a review of the Amsterdam Project must never bring down. */
const NOT_THIS_PROJECT = [
	...OUTSIDE_NAMESPACE,
	'remote.json',
	'index.html',
	'.nojekyll',
	`${BOSTON}/project.json`,
	`${BOSTON}/annotations/wharves.geojson`,
	'alignments/map-2.json',
	'alignments/map-3.json',
	'images/map-2/info.json',
	'images/map-2/0,0,256,256/256,256/0/default.jpg',
	'images/map-3/info.json'
];

// The hub draws a Base Map from an archive on somebody else's host, and every spec here is behind
// the default-deny network fence. On the `context`, so a request through a service worker is covered.
test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

/** Empty the whole of browser storage — every named Workspace — so no test sees another's. */
async function emptyBrowserStorage(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
		localStorage.clear();
		sessionStorage.clear();
	});
}

/** Start on a clean hub, with the repositories a test needs. */
async function start(
	page: Page,
	repositories: Parameters<typeof routeGitHubHosts>[1] = {}
): Promise<Awaited<ReturnType<typeof routeGitHubHosts>>> {
	const github = await routeGitHubHosts(page, {
		repositories: [{ owner: OWNER, name: REPOSITORY, files: PUBLISHED }],
		...repositories
	});
	await page.goto(HUB);
	await emptyBrowserStorage(page);
	await page.reload();
	return github;
}

/** Every file in a named Workspace, read behind the app's back. */
async function everyByteOf(page: Page, workspace: string): Promise<Record<string, string>> {
	return page.evaluate(async (name) => {
		const found: Record<string, string> = {};
		const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
			for await (const [entry, child] of handle.entries()) {
				if (child.kind === 'directory') {
					await walk(child as FileSystemDirectoryHandle, `${prefix}${entry}/`);
					continue;
				}
				found[`${prefix}${entry}`] = await (await (child as FileSystemFileHandle).getFile()).text();
			}
		};
		try {
			await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(name), '');
		} catch {
			return {};
		}
		return found;
	}, workspace);
}

/** Every named Workspace in browser storage. */
async function workspaceNames(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const names: string[] = [];
		for await (const [name, handle] of (await navigator.storage.getDirectory()).entries()) {
			if (handle.kind === 'directory') names.push(name);
		}
		return names.sort();
	});
}

const banner = (page: Page) => page.getByTestId('review-banner');

/**
 * A Reader who followed "Review this Project in Ballastella" off a Published Site.
 *
 * ⚠ **The offer is the behaviour under test, not the Review.** A link that silently made a Workspace
 * and switched to it would rearrange a stranger's editor, so landing must change nothing until a
 * press. The *link* — its wording and its address at both base paths — is the viewer's half, in
 * `viewer-reader.e2e.ts`.
 */
test.describe('arriving on a link from a Published Site', () => {
	const LINK = `${HUB}?review=${REMOTE}&p=${AMSTERDAM}`;
	const offer = (page: Page) => page.getByTestId('return-link-offer');
	const accept = (page: Page) => page.getByTestId('accept-return-link');

	test('offers a Review of the one Project, and has done nothing until it is confirmed', async ({
		page
	}) => {
		await start(page);

		await page.goto(LINK);

		await expect(offer(page)).toContainText(REMOTE);
		await expect(offer(page)).toContainText(AMSTERDAM);
		await expect(accept(page)).toBeVisible();
		await expect(page.getByTestId('return-link-progress')).toHaveCount(0);
		await expect(banner(page)).toBeHidden();
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	/**
	 * ⚠ **`?p=` keeps its meaning, and it wins for display.** The review link carries the Project's
	 * directory in the parameter that already addresses a Project (ADR-0008), so the editor shows what
	 * `?p=` names — which, before the Review has run, is a Project this computer does not have. The
	 * offer is rendered above that screen rather than instead of it, and the same address becomes the
	 * reviewed Project the moment it arrives.
	 */
	test('shows the Project ?p= names beneath the offer, before and after the Review', async ({
		page
	}) => {
		await start(page);

		await page.goto(LINK);

		await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
		await expect(offer(page)).toBeVisible();
		// ⚠ **And the invitation is announced before the error it explains.** The visual order is right
		// either way; an assertive region is not, because it interrupts a polite one whatever the DOM
		// says — so a screen-reader user following a perfectly good link heard "Project not found"
		// before the offer to fetch it. Both polite here, which announces them in reading order.
		await expect(page.getByTestId('project-problem')).toHaveAttribute('aria-live', 'polite');

		await accept(page).click();

		await expect(banner(page)).toBeVisible();
		expect(new URL(page.url()).searchParams.get('p')).toBe(AMSTERDAM);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(page.getByTestId('project-screen')).toBeVisible();
	});

	/**
	 * The other half of what one link offers: keeping the Project rather than looking at it.
	 *
	 * ⚠ **One test, because the claims are one workflow and none of them survives on its own.** That
	 * the Import writes into the Workspace the offer *named* is only observable against the Workspace
	 * that already existed; that it made no second one is what tells Import from Review at all; and
	 * that a published tree's own `remote.json` did not become this Workspace's Remote is a fact
	 * about the same Workspace after the same operation. The engine's refusals, the closure and the
	 * allocation are exhausted at Seam 1 (`project-import-source.test.ts`,
	 * `project-import-own-remote.test.ts`) and the offer's controls at Seam 1c
	 * (`return-link-offer.dom.test.ts`).
	 *
	 * ⚠ **`rejectCredential`, and nothing signs in.** A reader who was sent a link is very often
	 * somebody with no GitHub account, so a request that attached an `Authorization` header anywhere
	 * would 401 here rather than passing unnoticed.
	 */
	test('can Import that Project into the Workspace the reader is already in', async ({ page }) => {
		const github = await start(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY, files: IMPORTABLE }],
			rejectCredential: true
		});

		await page.goto(LINK);

		// The destination in words, beside the other answer and the way out.
		await expect(page.getByTestId('import-return-link')).toContainText(DEFAULT_WORKSPACE);
		await expect(accept(page)).toContainText('review copy');
		await expect(page.getByTestId('dismiss-return-link')).toBeVisible();

		// ⚠ **Reached and pressed from the keyboard alone, and watched while it runs**.
		// A control taken out of the tab order passes a pointer test while being unreachable in the app,
		// and the button that was pressed is the one focus has to survive on: this download is minutes
		// long over a pyramid, and `disabled` would drop a keyboard user onto `<body>` for all of it.
		const importing = page.getByTestId('import-return-link');
		await importing.focus();
		await expect(importing).toBeFocused();
		await importing.evaluate((button) => {
			(window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled = (
				button as HTMLButtonElement
			).disabled;
			new MutationObserver(() => {
				if ((button as HTMLButtonElement).disabled) {
					(window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled = true;
				}
			}).observe(button, { attributes: true, attributeFilter: ['disabled'] });
		});
		await page.keyboard.press('Enter');

		const said = page.getByTestId('return-link-outcome');
		await expect(said).toContainText('Amsterdam 1625');
		await expect(said).toContainText(DEFAULT_WORKSPACE);
		// The pressed button is replaced by this line, so this is where focus has to be: the offer is
		// not a dialog and has no trigger left to be restored to.
		await expect(said).toBeFocused();
		expect(
			await page.evaluate(
				() => (window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled ?? false
			)
		).toBe(false);
		// The Workspace the reader never left, and no review copy anywhere.
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		await expect(banner(page)).toBeHidden();
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);

		// What arrived is the Project's closure as ordinary work — and **not** the publisher's own
		// files, the other Project, or the `remote.json` sitting in the published root.
		const paths = Object.keys(await everyByteOf(page, DEFAULT_WORKSPACE));
		// ⚠ **The Map Image is a fresh identity, not the publisher's** (ADR-0037). An Import mints one,
		// so the closure cannot be compared to the Remote's own paths — which is exactly the difference
		// from the Review above, and the reason the identity is read out of the result rather than
		// written into the expectation.
		const minted = [
			...new Set(paths.filter((at) => at.startsWith('images/')).map((at) => at.split('/')[1]))
		];
		expect(minted).toEqual([expect.not.stringMatching(/^map-1$/)]);
		expect(paths.sort()).toEqual(
			[
				`alignments/${minted[0]}.json`,
				`${AMSTERDAM}/annotations/warehouses.geojson`,
				`${AMSTERDAM}/project.json`,
				`images/${minted[0]}/0,0,256,256/256,256/0/default.jpg`,
				`images/${minted[0]}/info.json`
			].sort()
		);
		for (const path of NOT_THIS_PROJECT) expect(paths).not.toContain(path);

		// ⚠ **The published tree names `someone-else/fork`, and this Workspace is still unbound.** A
		// copied or forked repository choosing a stranger's Remote is the failure the separation between
		// published metadata and local binding exists to prevent, so the bind form is what the Remote
		// screen shows.
		// Read from the door, which offers connecting rather than naming a repository.
		await expectNoRemote(page);

		// Closing the offer leaves the reader on the Project they came for, addressed by where it
		// landed rather than by the link's own directory.
		const done = page.getByTestId('dismiss-return-link');
		await done.focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => new URL(page.url()).searchParams.get('p')).toBe(AMSTERDAM);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		// The offer has gone with the press, so focus is on the work rather than on `<body>` at the top
		// of the document.
		await expect(page.locator('main')).toBeFocused();

		// Anonymous throughout — `rejectCredential` would have 401'd anything carrying a token — and
		// one raw request per file of the closure, plus the `project.json` the source reads and parses
		// before it will plan a closure at all.
		expect(github.rawGets(OWNER, REPOSITORY)).toBe(AMSTERDAM_CLOSURE.length + 1);
	});

	test('confirming makes the review copy, holding that one Project', async ({ page }) => {
		await start(page);
		await page.goto(LINK);

		// The other answer to the same link, from the keyboard, for the reason the Import beside it is:
		// a reader who followed a link is the person likeliest to be using one.
		await accept(page).focus();
		await expect(accept(page)).toBeFocused();
		await page.keyboard.press('Enter');

		const said = page.getByTestId('return-link-outcome');
		await expect(said).toContainText('Amsterdam 1625');
		// The button pressed is replaced by this line, and the offer is not a dialog with a trigger to
		// be restored to — so this is the only place focus can be that a reader can see.
		await expect(said).toBeFocused();
		await expect(banner(page)).toBeVisible();
		await expectWorkspaceNamed(page, REPOSITORY);
		// What arrived, rather than what was said: the Project's closure and the mark that makes this
		// Workspace a review copy, and nothing of the publisher's own.
		const stored = await everyByteOf(page, REPOSITORY);
		expect(Object.keys(stored).sort()).toEqual([...AMSTERDAM_CLOSURE, 'review.json'].sort());
		for (const path of NOT_THIS_PROJECT) expect(Object.keys(stored)).not.toContain(path);
	});

	test('takes the parameter off the address, so a reload does not offer again', async ({
		page
	}) => {
		await start(page);

		await page.goto(LINK);
		await expect(offer(page)).toBeVisible();

		expect(new URL(page.url()).searchParams.get('review')).toBeNull();
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
		await expect(offer(page)).toHaveCount(0);
		// With no offer above it, the dead end is an alert again: nothing else on the page is going to
		// say why the Project is missing.
		await expect(page.getByTestId('project-problem')).toHaveAttribute('role', 'alert');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	/**
	 * Turning down a Review leaves the editor as the visitor found it — which means without the
	 * link's `?p=`.
	 *
	 * Dismissing the offer alone would drop them onto "There is no Project called “amsterdam-1625” in
	 * this Workspace", with the one thing on the page that explained where that name came from now
	 * gone.
	 */
	test('can be turned down, and turning it down leaves no trace of the link', async ({ page }) => {
		await start(page);
		await page.goto(LINK);
		await expect(offer(page)).toBeVisible();

		// From the keyboard, because turning a link down has to cost one press and no pointer.
		const decline = page.getByTestId('dismiss-return-link');
		await decline.focus();
		await expect(decline).toBeFocused();
		await page.keyboard.press('Enter');

		await expect(offer(page)).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
		// ⚠ **The button that was pressed went with the offer**, so without somewhere to send focus a
		// visitor who declined a link would be left on `<body>`, tabbing in from the top of a page they
		// had already read. `<main>` is where the editor's own work is.
		await expect(page.locator('main')).toBeFocused();
		await expect(page.getByRole('heading', { name: 'Project not found' })).toHaveCount(0);
		await expect.poll(() => new URL(page.url()).searchParams.get('p')).toBeNull();
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	// A Review is of a Project. Without `?p=` there is nothing to offer, and widening it to the whole
	// repository would take a Reader who asked to look at one piece of work and hand them all of it.
	//
	// ⚠ **The parameter still comes off the address**, whether or not it raised an offer: one left in
	// the bar is replayed by a reload and kept by a bookmark, which is what the stripping is for. The
	// link's `?p=` is not the invitation and keeps its ordinary meaning (ADR-0008).
	test('offers nothing for a link naming no Project, and none for a Project on no repository', async ({
		page
	}) => {
		await start(page);

		for (const query of [`?review=${REMOTE}`, `?review=ada&p=${AMSTERDAM}`]) {
			await page.goto(`${HUB}${query}`);
			// The bar rather than a heading: the second of these carries `?p=`, so the two land on
			// different screens and only the bar is on both.
			await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
			await expect(offer(page)).toHaveCount(0);
			await expect
				.poll(() => new URL(page.url()).searchParams.get('review'), {
					message: `${query} left in the address bar`
				})
				.toBeNull();
		}
		expect(new URL(page.url()).searchParams.get('p')).toBe(AMSTERDAM);
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});
});
